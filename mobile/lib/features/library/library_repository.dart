import '../../core/model/owner_key.dart';
import '../../core/network/api_transport.dart';
import '../../core/network/network_policy.dart';
import '../../core/session/session_authority.dart';
import 'library_models.dart';

/// Reads actual saved entities and user playlists; never scans server files.
final class LibraryRepository {
  LibraryRepository({
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
  Future<ApiResponse> _request(
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
    return response;
  }

  Future<LibraryCollection> load() async {
    SavedEntityPage? saved;
    List<LibraryPlaylist> playlists = const [];
    Object? savedError;
    Object? playlistError;
    await Future.wait([
      loadSaved().then(
        (value) {
          saved = value;
        },
        onError: (Object e) {
          savedError = e;
        },
      ),
      loadPlaylists().then(
        (value) {
          playlists = value;
        },
        onError: (Object e) {
          playlistError = e;
        },
      ),
    ]);
    await authority.assertCurrent(fence);
    return LibraryCollection(
      saved: saved?.items ?? const [],
      totalSaved: saved?.total ?? 0,
      hasMoreSaved: saved?.hasMore ?? false,
      playlists: playlists,
      savedFailure: savedError == null ? null : collectionFailure(savedError!),
      playlistsFailure: playlistError == null
          ? null
          : collectionFailure(playlistError!),
    );
  }

  Future<SavedEntityPage> loadSaved({int offset = 0, int limit = 80}) async {
    if (offset < 0 || offset > 100000 || limit < 1 || limit > 200) {
      throw ArgumentError('Invalid saved page');
    }
    final dto = collectionObject(
      (await _request(
        '/api/library/saved',
        query: {'offset': '$offset', 'limit': '$limit'},
      )).data,
    );
    final items = collectionList(dto['items']).map((row) {
      final item = collectionObject(row);
      final kind = switch (item['entityType']) {
        'album' => SavedEntityKind.album,
        'artist' => SavedEntityKind.artist,
        _ => throw collectionFailure(StateError('entityType')),
      };
      return SavedEntityRef(
        kind: kind,
        source: collectionString(item['source']),
        entityId: collectionString(item['entityId']),
        title: collectionString(item['title']),
        subtitle: item['subtitle'] as String?,
        image: item['imageUrl'] == null
            ? null
            : Uri.parse(collectionString(item['imageUrl'])),
      );
    }).toList();
    final total = collectionCount(dto['total']);
    if (items.isEmpty && offset < total) {
      throw collectionFailure(StateError('empty page'));
    }
    return SavedEntityPage(items: items, total: total, offset: offset);
  }

  Future<List<LibraryPlaylist>> loadPlaylists() async {
    const limit = 200;
    var offset = 0;
    final result = <LibraryPlaylist>[];
    while (true) {
      final rows = collectionList(
        (await _request(
          '/api/playlists',
          query: {'offset': '$offset', 'limit': '$limit'},
        )).data,
      );
      for (final row in rows) {
        final item = collectionObject(row);
        if (item['isHidden'] == true) continue;
        result.add(
          LibraryPlaylist(
            id: collectionString(item['id']),
            name: collectionString(item['name']),
            trackCount: collectionCount(item['trackCount']),
            isOwner: item['isOwner'] == true,
          ),
        );
      }
      if (rows.length < limit) break;
      offset += rows.length;
    }
    return result;
  }

  Future<bool> status(SavedEntityRef entity) async {
    final dto = collectionObject(
      (await _request(
        '/api/library/saved/status',
        query: entity.identity,
      )).data,
    );
    if (dto['saved'] is! bool) {
      throw collectionFailure(StateError('saved status'));
    }
    return dto['saved'] as bool;
  }

  Future<bool> save(SavedEntityRef entity, bool saved) async {
    final dto = collectionObject(
      (await _request(
        '/api/library/saved',
        method: saved ? ApiMethod.put : ApiMethod.delete,
        body: saved ? entity.payload : entity.identity,
      )).data,
    );
    if (dto['saved'] != saved) {
      throw collectionFailure(StateError('saved confirmation'));
    }
    return saved;
  }
}
