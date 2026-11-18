import '../core/model/owner_key.dart';
import '../core/model/app_failure.dart';
import 'media_gateway.dart';
import 'playback_resolver.dart';
import 'resolved_media.dart';
import 'queue_snapshot.dart';

/// Runtime-only resource. Ready offline files can implement the same seam.
final class PreparedAudio {
  const PreparedAudio({
    required this.uri,
    required this.revoke,
    this.readFailure,
  });
  final Uri uri;
  final Future<void> Function() revoke;

  /// Safe typed cause from this exact resource; no URI or credentials enter state.
  final AppFailure? Function()? readFailure;
  AppFailure? get failure => readFailure?.call();

  /// A local reader remains reserved until the native decoder has drained.
  /// Network revocation starts immediately so blocked gateway IO can stop too.
  Future<void> revokeAfterStop(Future<void> stopped) async {
    if (uri.scheme == 'file') {
      await stopped;
      await revoke();
    } else {
      await Future.wait<void>([stopped, revoke()]);
    }
  }

  @override
  String toString() => 'PreparedAudio(<private>)';
}

typedef PrepareAudio = Future<PreparedAudio> Function(
  QueueEntry entry,
  SessionFence fence,
);

PrepareAudio protectedAudioPreparation(
  PlaybackResolver resolver,
  MediaGateway gateway,
) => (entry, fence) async {
  final media = await resolver.resolve(
    entry.track.ref,
    ResolvePurpose.playback,
    fence,
  );
  final handle = await gateway.open(media, fence);
  return PreparedAudio(
    uri: handle.uri,
    revoke: handle.revoke,
    readFailure: () => handle.failure,
  );
};

final class EngineEvent {
  const EngineEvent({
    required this.generation,
    required this.position,
    required this.processing,
    required this.playing,
    this.duration,
    this.bufferedPosition = Duration.zero,
    this.failed = false,
  });
  final int generation;
  final Duration position;
  final Duration? duration;
  final Duration bufferedPosition;
  final PlaybackProcessing processing;
  final bool playing;
  final bool failed;
}

abstract interface class PlaybackEngine {
  Stream<EngineEvent> get events;
  Future<void> load(Uri uri, int generation);

  /// Native play completes on pause/end; callers must never await it as a lock.
  Future<void> play();
  Future<void> pause();
  Future<void> stop();
  Future<void> seek(Duration position);
  Future<void> setVolume(double volume);
  Future<void> dispose();
}

/// A read-only native acknowledgement, independent of extrapolated UI clocks.
abstract interface class PlaybackStartConfirmation {
  bool get requiresNativeStartConfirmation;
  Future<bool> confirmPlaying();
}
