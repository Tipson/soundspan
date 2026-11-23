import 'dart:async';
import 'dart:io';

import 'package:audio_session/audio_session.dart';

import 'playback_command.dart';
import 'queue_coordinator.dart';

/// Sole interruption/noisy policy. JustAudio's automatic handlers are disabled.
final class AudioFocusCoordinator {
  AudioFocusCoordinator(this.coordinator);
  final QueueCoordinator coordinator;
  StreamSubscription<AudioInterruptionEvent>? _interruptions;
  StreamSubscription<void>? _noisy;
  int? _generation, _revision;
  bool _disposed = false;

  Future<void> attach() async {
    if (_interruptions != null) throw StateError('Focus already attached');
    final session = await AudioSession.instance;
    if (_disposed) return;
    await session.configure(
      const AudioSessionConfiguration.music().copyWith(
        androidWillPauseWhenDucked: true,
      ),
    );
    if (_disposed) return;
    _interruptions = session.interruptionEventStream.listen((event) {
      if (event.begin) {
        unawaited(
          interruptionBegan(
            permanent:
                Platform.isAndroid &&
                event.type == AudioInterruptionType.unknown,
          ),
        );
      } else {
        unawaited(
          interruptionEnded(
            allowResume:
                event.type == AudioInterruptionType.pause ||
                event.type == AudioInterruptionType.duck,
          ),
        );
      }
    });
    _noisy = session.becomingNoisyEventStream.listen((_) {
      unawaited(becomingNoisy());
    });
  }

  Future<void> interruptionBegan({bool permanent = false}) async {
    if (_disposed) return;
    _generation = permanent ? null : coordinator.snapshot.generation;
    _revision = permanent ? null : coordinator.intentRevision;
    await coordinator.suspendForFocus(resumeOnGain: !permanent);
  }

  Future<void> interruptionEnded({required bool allowResume}) async {
    if (_disposed || _generation == null) return;
    final generation = _generation!, revision = _revision!;
    _generation = null;
    _revision = null;
    await coordinator.resumeAfterFocus(
      generation,
      revision,
      allowResume: allowResume,
    );
  }

  Future<void> becomingNoisy() => coordinator.dispatch(const Pause());
  Future<void> dispose() async {
    _disposed = true;
    await _interruptions?.cancel();
    await _noisy?.cancel();
  }
}
