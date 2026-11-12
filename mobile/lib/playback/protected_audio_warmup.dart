import '../core/model/owner_key.dart';
import '../core/model/track_ref.dart';
import '../downloads/protected_media_fetcher.dart';
import 'playback_resolver.dart';
import 'resolved_media.dart';

/// Warms the server's exact-recording cache without creating a native source.
final class ProtectedAudioWarmup {
  const ProtectedAudioWarmup({
    required this.resolver,
    required this.fetcher,
    required this.requireNetwork,
  });
  final PlaybackResolver resolver;
  final ProtectedMediaFetcher fetcher;
  final void Function() requireNetwork;
  Future<void> warm(
    TrackRef ref,
    SessionFence fence,
    MediaCancellation cancellation,
  ) async {
    void check() {
      cancellation.check();
      requireNetwork();
    }

    check();
    final media = await resolver.resolve(ref, ResolvePurpose.preload, fence);
    check();
    final response = await fetcher.open(
      media,
      fence,
      range: ByteRange(start: 0, end: 65535),
      cancellation: cancellation,
    );
    try {
      check();
      var bytes = 0;
      await for (final chunk in response.body) {
        check();
        bytes += chunk.length;
        // Servers may ignore Range. Never turn prewarming into a full download.
        if (bytes >= 65536) break;
      }
    } finally {
      await response.close();
    }
  }
}
