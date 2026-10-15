import '../../core/mapping/playlist_track_mapper.dart';
import '../../core/model/owner_key.dart';
import '../../core/model/track.dart';
import '../../core/model/track_ref.dart';
import '../../core/network/api_transport.dart';
import '../../core/network/network_policy.dart';
import '../../core/session/session_authority.dart';
import '../library/library_models.dart';
import 'playlist_models.dart';

/// Exact current playlist API; this adapter never retries mutations.
final class PlaylistRepository {
  PlaylistRepository({
    required this.transport,
    required this.authority,
    required this.fence,
    this.networkPolicy = const NetworkPolicy.online(),
  });
  final ApiTransport transport;
  final SessionAuthority authority;
  final SessionFence fence;
  final NetworkPolicy networkPolicy;
  bool get isCurrent => authority.isCurrent(fence);
  bool get canMutate => isCurrent && networkPolicy.networkAllowed;
  String _path(String id) => '/api/playlists/${Uri.encodeComponent(id)}';
  Future<Object?> _request(
    String path, {
    ApiMethod method = ApiMethod.get,
    Map<String, String> query = const {},
    Map<String, Object?>? body,
  }) async {
    await authority.assertCurrent(fence);
    networkPolicy.requireNetwork();
    final response = await transport.send(
      ApiRequest(
        origin: fence.owner.serverOrigin,
        method: method,
        path: path,
        query: query,
        body: body,
      ),
      fence: fence,
    );
    await authority.assertCurrent(fence);
    response.requireSuccess();
    return response.data;
  }

  Future<List<PlaylistSummary>> list() async {
    final items = <PlaylistSummary>[];
    for (var offset = 0; ;) {
      final rows = collectionList(
        await _request(
          '/api/playlists',
          query: {'limit': '200', 'offset': '$offset'},
        ),
      );
      for (final row in rows) {
        items.add(PlaylistSummary.fromJson(collectionObject(row)));
      }
      if (rows.length < 200) break;
      offset += rows.length;
    }
    return List.unmodifiable(items);
  }

  Future<PlaylistPage> page(String id, String? cursor) async {
    final dto = collectionObject(
      await _request(_path(id), query: {'limit': '100', 'cursor': ?cursor}),
    );
    final playlist = PlaylistSummary.fromJson(dto);
    if (playlist.id != id) {
      throw collectionFailure(StateError('playlist identity'));
    }
    final pagination = collectionObject(dto['pagination']);
    if (pagination['hasMore'] is! bool) {
      throw collectionFailure(StateError('pagination'));
    }
    final hasMore = pagination['hasMore'] as bool;
    final next = pagination['nextCursor'];
    if ((hasMore && (next is! String || next.isEmpty)) ||
        (!hasMore && next != null)) {
      throw collectionFailure(StateError('cursor'));
    }
    final keys = <String>{};
    final items = collectionList(dto['mergedItems']).map((raw) {
      final row = collectionObject(raw);
      final key = collectionString(row['id']);
      if (!keys.add(key)) throw collectionFailure(StateError('item identity'));
      final pending = row['type'] == 'pending';
      if (!pending && row['type'] != 'track') {
        throw collectionFailure(StateError('item type'));
      }
      final data = pending ? collectionObject(row['pending']) : null;
      return PlaylistItem(
        id: key,
        sort: collectionCount(row['sort']),
        pending: pending,
        track: pending
            ? Track(
                ref: UnavailableTrackRef(
                  'playlist-pending:$key',
                  reason: 'pending_import',
                ),
                title: collectionString(data!['title']),
                artist: collectionString(data['artist']),
                album: data['album'] as String?,
                playbackAllowed: false,
                unavailableReason: 'pending_import',
              )
            : const PlaylistTrackMapper().map(row),
      );
    }).toList();
    final total = collectionCount(dto['totalItemCount']);
    if (items.length > 100 ||
        items.length > total ||
        (hasMore && items.isEmpty)) {
      throw collectionFailure(StateError('item count'));
    }
    return PlaylistPage(
      playlist: playlist,
      items: items,
      total: total,
      hasMore: hasMore,
      nextCursor: next as String?,
    );
  }

  Future<PlaylistSummary> create(PlaylistDraft draft) async {
    final dto = collectionObject(
      await _request(
        '/api/playlists',
        method: ApiMethod.post,
        body: draft.payload,
      ),
    );
    // Create returns the persisted row without computed isOwner/count fields.
    return PlaylistSummary.fromJson({
      ...dto,
      'isOwner': true,
      'isHidden': false,
      'trackCount': 0,
    });
  }

  Future<void> update(String id, PlaylistPatch patch) async {
    await _request(_path(id), method: ApiMethod.put, body: patch.payload);
  }

  Future<void> delete(String id) async {
    await _request(_path(id), method: ApiMethod.delete);
  }

  Future<void> hide(String id, bool hidden) async {
    final dto = collectionObject(
      await _request(
        '${_path(id)}/hide',
        method: hidden ? ApiMethod.post : ApiMethod.delete,
      ),
    );
    if (dto['isHidden'] != hidden) {
      throw collectionFailure(StateError('hidden confirmation'));
    }
  }

  Future<void> add(String id, List<Track> tracks) async {
    final payloads = tracks.map(playlistAddPayload).toList();
    for (final payload in payloads) {
      await _request(
        '${_path(id)}/items',
        method: ApiMethod.post,
        body: payload,
      );
    }
  }

  Future<void> remove(String id, String itemId, {bool pending = false}) async {
    await _request(
      '${_path(id)}/${pending ? 'pending' : 'items'}/${Uri.encodeComponent(itemId)}',
      method: ApiMethod.delete,
    );
  }

  Future<void> reorder(String id, List<String> allItemIds) async {
    if (allItemIds.length > 1000 ||
        allItemIds.toSet().length != allItemIds.length) {
      throw ArgumentError('Invalid complete order');
    }
    await _request(
      '${_path(id)}/items/reorder',
      method: ApiMethod.put,
      body: {'itemIds': List<String>.of(allItemIds)},
    );
  }
}
