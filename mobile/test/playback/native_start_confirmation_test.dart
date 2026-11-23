import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:just_audio/just_audio.dart' as audio;
import 'package:soundspan/playback/just_audio_engine.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/queue_coordinator.dart';

import '../support/media_fixtures.dart';
import 'queue_coordinator_test.dart' show entry;
import 'queue_coordinator_test.dart' show FakeEngine;

class HeldConfirmationEngine extends FakeEngine
    implements PlaybackStartConfirmation {
  final firstReply = Completer<bool>();
  var reads = 0;
  @override
  bool get requiresNativeStartConfirmation => true;
  @override
  Future<bool> confirmPlaying() =>
      ++reads == 1 ? firstReply.future : Future.value(false);
}

class NativeBoundaryPlayer implements audio.AudioPlayer {
  final native = StreamController<audio.PlaybackEvent>.broadcast();
  Duration clock = Duration.zero;
  @override
  int get androidAudioSessionId => 17;
  @override
  bool get playing => true;
  @override
  Duration get position => clock;
  @override
  Duration get bufferedPosition => const Duration(minutes: 1);
  @override
  Duration get duration => const Duration(minutes: 1);
  @override
  audio.ProcessingState get processingState => audio.ProcessingState.ready;
  @override
  Stream<audio.PlaybackEvent> get playbackEventStream => native.stream;
  @override
  Stream<audio.PlayerException> get errorStream => const Stream.empty();
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
  }) async => duration;
  @override
  Future<void> setVolume(double volume) async {}
  @override
  Future<void> play() => Completer<void>().future;
  @override
  Future<void> stop() async {}
  @override
  Future<void> pause() async {}
  @override
  Future<void> seek(Duration? position, {int? index}) async {
    clock = position ?? Duration.zero;
  }

  @override
  Future<void> dispose() => native.close();
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('com.ryanheise.just_audio.methods');
  test(
    'ACK before focus pause cannot acknowledge a later focus-gain Play attempt',
    () async {
      final authority = await mediaAuthority(
        Uri.parse('https://audio.example'),
      );
      final engine = HeldConfirmationEngine();
      final queue = QueueCoordinator(
        authority: authority,
        engine: engine,
        prepareTimeout: const Duration(milliseconds: 200),
        prepare: (_, _) async => PreparedAudio(
          uri: Uri.parse('file:///focus.wav'),
          revoke: () async {},
        ),
      );
      addTearDown(queue.dispose);
      await queue.dispatch(
        ReplaceQueue([entry('a')], fence: authority.requireFence()),
      );
      await pumpEventQueue();
      final generation = queue.snapshot.generation,
          revision = queue.intentRevision;
      await queue.suspendForFocus();
      await queue.resumeAfterFocus(generation, revision);
      engine.firstReply.complete(true);
      await Future<void>.delayed(const Duration(milliseconds: 280));
      expect(queue.snapshot.failure?.code, 'playback_start_timeout');
      expect(engine.plays, 2);
    },
  );
  for (final (nativePlaying, session, source) in [
    (false, 17, 'file:///ack.wav'),
    (true, 17, 'file:///ack.wav'),
    (true, 18, 'file:///ack.wav'),
    (true, 17, 'file:///previous.wav'),
  ]) {
    final confirmed =
        nativePlaying && session == 17 && source == 'file:///ack.wav';
    test(
      'native acknowledgement requires playing=$nativePlaying session=$session source=$source',
      () async {
        debugDefaultTargetPlatformOverride = TargetPlatform.android;
        var probes = 0;
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(channel, (call) async {
              expect(call.method, 'soundspanReadPlayback');
              probes++;
              return {
                'sessionId': session,
                'source': source,
                'isPlaying': nativePlaying,
                'positionMs': 250,
              };
            });
        final authority = await mediaAuthority(
          Uri.parse('https://audio.example'),
        );
        final player = NativeBoundaryPlayer();
        final engine = JustAudioEngine(player: player);
        final queue = QueueCoordinator(
          authority: authority,
          engine: engine,
          prepareTimeout: const Duration(milliseconds: 150),
          prepare: (_, _) async => PreparedAudio(
            uri: Uri.parse('file:///ack.wav'),
            revoke: () async {},
          ),
        );
        addTearDown(() async {
          await queue.dispose();
          debugDefaultTargetPlatformOverride = null;
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
              .setMockMethodCallHandler(channel, null);
        });
        await queue.dispatch(
          ReplaceQueue([entry('a')], fence: authority.requireFence()),
        );
        player.clock = const Duration(seconds: 2);
        player.native.add(
          audio.PlaybackEvent(processingState: audio.ProcessingState.ready),
        );
        await Future<void>.delayed(const Duration(milliseconds: 230));
        expect(
          queue.snapshot.failure?.code,
          confirmed ? isNull : 'playback_start_timeout',
        );
        expect(
          probes,
          greaterThan(0),
          reason: 'confirmation must cross the native boundary',
        );
      },
    );
  }
}
