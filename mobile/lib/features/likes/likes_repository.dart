import '../../core/mapping/liked_track_mapper.dart';
import '../../core/model/owner_key.dart';
import '../../core/network/api_transport.dart';
import '../../core/network/network_policy.dart';
import '../../core/session/session_authority.dart';
import '../library/library_models.dart';
import 'likes_models.dart';

/// Owner-bound API reader, independent of credentials and the audio engine.
final class LikesRepository {
  LikesRepository({
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
  Future<LikedPage> page(LikedCursor? cursor, {int limit = 100}) async {
    if (limit < 1 || limit > 10000) throw ArgumentError.value(limit, 'limit');
    await authority.assertCurrent(fence);
    networkPolicy.requireNetwork();
    final response = await transport.send(
      ApiRequest(
        origin: fence.owner.serverOrigin,
        method: ApiMethod.get,
        path: '/api/library/liked',
        query: {
          'limit': '$limit',
          if (cursor != null) ...{
            'cursorLikedAt': cursor.likedAt,
            'cursorTrackId': cursor.trackId,
          },
        },
      ),
      fence: fence,
    );
    await authority.assertCurrent(fence);
    response.requireSuccess();
    final dto = collectionObject(response.data);
    final pagination = collectionObject(dto['pagination']);
    final hasMore = pagination['hasMore'];
    if (hasMore is! bool) throw collectionFailure(StateError('pagination'));
    final rawCursor = pagination['nextCursor'];
    final next = rawCursor == null ? null : collectionObject(rawCursor);
    final parsed = next == null
        ? null
        : LikedCursor(
            likedAt: collectionString(next['likedAt']),
            trackId: collectionString(next['trackId']),
          );
    if (hasMore && (parsed == null || parsed == cursor)) {
      throw collectionFailure(StateError('cursor'));
    }
    final tracks = collectionList(dto['tracks'])
        .map((row) => const LikedTrackMapper().map(collectionObject(row)))
        .toList();
    if (hasMore && tracks.isEmpty) {
      throw collectionFailure(StateError('empty pagination'));
    }
    return LikedPage(
      tracks: tracks,
      total: collectionCount(dto['total']),
      hasMore: hasMore,
      nextCursor: parsed,
    );
  }
}
