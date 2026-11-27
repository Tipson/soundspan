import 'dart:async';

import '../core/model/app_failure.dart';
import '../core/model/owner_key.dart';
import '../core/model/track_ref.dart';
import '../core/network/api_transport.dart';
import '../core/network/redirect_policy.dart';
import '../core/session/session_authority.dart';
import 'resolved_media.dart';

/// Looks up an optional alternative without delaying standard playback on
/// older servers or making a broken lookup a prerequisite for playback.
final class TrackAudioVersions {
  const TrackAudioVersions({required this.transport, required this.authority});

  final ApiTransport transport;
  final SessionAuthority authority;

  static final _trackId = RegExp(r'^[A-Za-z0-9_-]{1,256}$');
  static final _youtubeId = RegExp(r'^[A-Za-z0-9_-]{11}$');

  Future<ResolvedMedia?> resolve(TrackRef ref, SessionFence fence) async {
    final identity = switch (ref) {
      LibraryTrackRef(:final libraryId) when _trackId.hasMatch(libraryId) =>
        'library/$libraryId',
      YoutubeTrackRef(:final videoId) when _youtubeId.hasMatch(videoId) =>
        'youtube/$videoId',
      NativeTrackRef(:final recording) =>
        '${recording.provider.name}/${recording.id}',
      _ => null,
    };
    if (identity == null) return null;
    await authority.assertCurrent(fence);
    final cancellation = MediaCancellation();
    final timeout = Timer(
      const Duration(milliseconds: 800),
      cancellation.cancel,
    );
    try {
      final response = await transport.send(
        ApiRequest(
          origin: fence.owner.serverOrigin,
          method: ApiMethod.get,
          path: '/api/track-audio/$identity',
          cancellation: cancellation,
        ),
        fence: fence,
      );
      await authority.assertCurrent(fence);
      cancellation.check();
      final data = response.data;
      final id = response.statusCode == 200 && data is Map
          ? data['publishedId']
          : null;
      if (id is! String || !RedirectPolicy.audioVersionIdPattern.hasMatch(id)) {
        return null;
      }
      final media = ResolvedMedia(
        ref: ref,
        purpose: ResolvePurpose.playback,
        fence: fence,
        uri: fence.owner.serverOrigin.resolve(
          '/api/track-audio/versions/$id/stream',
        ),
        publishedAudioVersionId: id,
      );
      RedirectPolicy.validate(media.uri, media);
      return media;
    } on AppFailure {
      await authority.assertCurrent(fence);
      return null;
    } finally {
      timeout.cancel();
    }
  }
}
