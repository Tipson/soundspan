import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:just_audio/just_audio.dart' as audio;
import 'package:soundspan/playback/just_audio_engine.dart';
import 'package:soundspan/playback/queue_snapshot.dart';
import 'package:soundspan/playback/loudness_gain_policy.dart';

import 'native_loudness_controller_test.dart' show state, fence;

// A plugin boundary probe, not a replacement PlaybackEngine. It reproduces
// the synchronous Rx critical section that rejects reentrant stop/load.
final class PluginProbe implements audio.AudioPlayer {
  final native = StreamController<audio.PlaybackEvent>.broadcast(sync: true);
  final errors = StreamController<audio.PlayerException>.broadcast(sync: true);
  bool delivering = false;
  int stops = 0;
  int loads = 0;
  Completer<void>? firstLoad;
  final volumes = <double>[];
  @override
  Future<void> setVolume(double volume) async => volumes.add(volume);
  @override
  audio.ProcessingState processingState = audio.ProcessingState.ready;
  @override
  bool get playing => true;
  @override
  Duration get position => const Duration(seconds: 1);
  @override
  Duration? get duration => const Duration(seconds: 3);
  @override
  Duration get bufferedPosition => const Duration(seconds: 3);
  @override
  Stream<audio.PlaybackEvent> get playbackEventStream => native.stream;
  @override
  Stream<audio.PlayerException> get errorStream => errors.stream;
  @override
  Stream<Duration> get positionStream => const Stream.empty();
  @override
  Stream<audio.PlayerState> get playerStateStream => const Stream.empty();
  @override
  Future<Duration?> setAudioSources(
    List<audio.AudioSource> sources, {
    bool preload = true,
    int? initialIndex,
    Duration? initialPosition,
    audio.ShuffleOrder? shuffleOrder,
  }) async {
    if (delivering) throw StateError('Reentrant native load');
    if (++loads == 1 && firstLoad != null) await firstLoad!.future;
    return duration;
  }

  @override
  Future<void> stop() async {
    if (delivering) throw StateError('Reentrant native stop');
    stops++;
  }

  void complete() {
    delivering = true;
    processingState = audio.ProcessingState.completed;
    native.add(audio.PlaybackEvent(processingState: processingState));
    delivering = false;
  }

  @override
  Future<void> dispose() async {
    await native.close();
    await errors.close();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  test(
    'delayed old plugin load cannot stall stop/new load or apply obsolete gain',
    () async {
      final plugin = PluginProbe()..firstLoad = Completer<void>();
      final engine = JustAudioEngine(player: plugin);
      await engine.loudness.setOwner(
        fence,
        LoudnessMode.track,
        isCurrent: () => true,
      );
      engine.updateLoudnessContext(state(1, lufs: -8));
      final old = engine.load(Uri.parse('file:///old.wav'), 1);
      while (plugin.loads == 0) {
        await Future<void>.delayed(Duration.zero);
      }
      await engine.stop().timeout(const Duration(seconds: 1));
      engine.updateLoudnessContext(state(2, lufs: -18));
      await engine
          .load(Uri.parse('file:///new.wav'), 2)
          .timeout(const Duration(seconds: 1));
      final writes = plugin.volumes.length;
      plugin.firstLoad!.complete();
      await old;
      expect(plugin.loads, 2);
      expect(plugin.volumes.length, writes);
      expect(plugin.volumes.last, 1);
      await engine.dispose();
    },
  );
  test(
    'native completion delivered outside plugin synchronous callback',
    () async {
      final plugin = PluginProbe();
      final engine = JustAudioEngine(player: plugin);
      await engine.load(Uri.parse('file:///synthetic.wav'), 1);
      await pumpEventQueue();
      final stopped = Completer<void>();
      final sub = engine.events.listen((event) async {
        if (event.processing == PlaybackProcessing.completed) {
          try {
            await engine.stop();
            stopped.complete();
          } catch (error, stack) {
            stopped.completeError(error, stack);
          }
        }
      });
      plugin.complete();
      await stopped.future.timeout(const Duration(seconds: 1));
      expect(plugin.stops, 1);
      await sub.cancel();
      await engine.dispose();
    },
  );
  test(
    'published just_audio error stream maps to typed engine failure',
    () async {
      final plugin = PluginProbe();
      final engine = JustAudioEngine(player: plugin);
      await engine.load(Uri.parse('file:///synthetic.wav'), 1);
      await pumpEventQueue();
      final failed = engine.events.firstWhere((e) => e.failed);
      plugin.errors.add(audio.PlayerException(7, 'private native error', null));
      expect((await failed.timeout(const Duration(seconds: 1))).generation, 1);
      await engine.dispose();
    },
  );
}
