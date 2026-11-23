import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';
import 'package:soundspan/app/owner_services.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/session/session_broker_entrypoint.dart';
import 'package:soundspan/playback/just_audio_engine.dart';
import 'package:soundspan/playback/android_playback_gain.dart';
import 'package:soundspan/playback/loudness_gain_policy.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/queue_coordinator.dart';

import '../test/support/media_fixtures.dart';
import '../test/support/wave_reporting_fixtures.dart';
import 'support/synthetic_audio.dart';

@pragma('vm:entry-point')
Future<void> sessionBrokerMain() => runSessionBroker();

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'same actual Android player applies native gain and persisted owner mode',
    (tester) async {
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(() async {
        final authority = await mediaAuthority(
          Uri.parse('https://gain-fixture.invalid'),
        );
        final fence = authority.requireFence();
        final store = ReportingStore();
        await store.transaction(
          fence,
          (tx) =>
              tx.write('settings', 'network', {'version': 1, 'offline': true}),
        );
        final createdDirectory = await Directory(
          '${(await getApplicationSupportDirectory()).path}/gain-fixture',
        ).create(recursive: true);
        final directory = Directory(
          await createdDirectory.resolveSymbolicLinks(),
        );
        final file = await File('${directory.path}/synthetic.wav')
            .writeAsBytes(syntheticWav(duration: const Duration(seconds: 20)));
        final engine = JustAudioEngine();
        final queue = QueueCoordinator(
          authority: authority,
          engine: engine,
          prepare: (_, _) async =>
              PreparedAudio(uri: file.uri, revoke: () async {}),
        );
        var owner = await NativeOwnerServices.create(
          authority: authority,
          store: store,
          fence: fence,
          playback: queue,
          supportDirectory: directory,
          cancelDownloads: (_) async {},
        );
        var count = 0;
        Future<void> select({
          double? lufs,
          double? peak,
          double? album,
          double expected = 0,
        }) async {
          final entries = queue.createEntries([
            Track(
              ref: LibraryTrackRef('fixture-${++count}'),
              title: 'Synthetic fixture',
              artist: 'Test',
              albumId: 'a',
              loudnessLufs: lufs,
              truePeakDb: peak,
              albumLoudnessLufs: album,
            ),
          ], const PlayContext(surface: PlaySurface.library));
          await queue.dispatch(
            ReplaceQueue(entries, fence: fence, play: false),
          );
          expect(queue.snapshot.failure, isNull);
          final state = engine.gainDiagnostics;
          final native = await engine.readNativeGain();
          expect(native!.sessionId, state.sessionId);
          expect(
            native.targetGainMb,
            closeTo(math.max(0, expected) * 100, .51),
          );
          expect(native.enabled, expected > 0);
          expect(state.sessionId, isNotNull);
          expect(state.boostDb, math.max(0, expected));
          expect(state.enabled, expected > 0);
          expect(
            state.volume,
            closeTo(
              queue.snapshot.volume * math.pow(10, math.min(0, expected) / 20),
              1e-6,
            ),
          );
          expect(owner.gainAvailable.value, isTrue);
          debugPrint(
            'NATIVE_GAIN_ACK fixture=$count session=${state.sessionId} boostDb=${state.boostDb} nativeMillibels=${native.targetGainMb} volume=${state.volume} enabled=${native.enabled}',
          );
        }

        try {
          expect(owner.gainAvailable.value, isFalse);
          await select(lufs: -9, peak: -1, expected: -9);
          await select(lufs: -30, peak: -4, expected: 3);
          await queue.dispatch(const SetVolume(.4));
          expect(engine.gainDiagnostics.volume, .4);
          expect(engine.gainDiagnostics.boostDb, 3);
          await queue.dispatch(const SetVolume(0));
          expect(engine.gainDiagnostics.volume, 0);
          await queue.dispatch(const SetVolume(1));
          await select(lufs: -8, peak: -1, expected: -10);
          await select(lufs: -30);
          await select();
          await select(lufs: -10, peak: -2, album: -14, expected: -4);
          await queue.dispatch(const SetShuffle(true));
          await engine.loudness.flush();
          expect(
            engine.gainDiagnostics.volume,
            closeTo(math.pow(10, -8 / 20), 1e-6),
          );
          await owner.setLoudnessMode(LoudnessMode.off);
          expect(engine.gainDiagnostics.volume, 1);
          await queue.dispatch(const SetShuffle(false));
          await select(lufs: -30, peak: -4);
          await owner.close();
          owner = await NativeOwnerServices.create(
            authority: authority,
            store: store,
            fence: fence,
            playback: queue,
            supportDirectory: directory,
            cancelDownloads: (_) async {},
          );
          expect(owner.loudnessMode.value, LoudnessMode.off);
          await select(lufs: -30, peak: -4);
          await owner.setLoudnessMode(LoudnessMode.track);
          expect(engine.gainDiagnostics.boostDb, 3);
          expect((await engine.readNativeGain())!.targetGainMb, 300);
          await queue.dispatch(const Resume());
          await Future<void>.delayed(const Duration(milliseconds: 400));
          expect(queue.snapshot.position, greaterThan(Duration.zero));
          debugPrint(
            'NATIVE_GAIN_DUMPSYS_WINDOW session=${engine.gainDiagnostics.sessionId} boost=3',
          );
          await Future<void>.delayed(const Duration(seconds: 15));
          await queue.dispatch(const Pause());
          await authority.invalidate();
          await Future<void>.delayed(const Duration(milliseconds: 100));
          await owner.close();
          expect(engine.gainDiagnostics.enabled, isFalse);
          debugPrint(
            'NATIVE_GAIN_PASS sources=$count off_cache=true user_volume=true owner_revoke=true',
          );
        } finally {
          await owner.close();
          await queue.dispose();
          await directory.delete(recursive: true);
        }
      });
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );
  testWidgets(
    'caught native constructor failure leaves actual decoder playing',
    (tester) async {
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(() async {
        final authority = await mediaAuthority(
          Uri.parse('https://gain-unsupported-fixture.invalid'),
        );
        final fence = authority.requireFence();
        final directory = Directory(
          await (await getApplicationSupportDirectory()).resolveSymbolicLinks(),
        );
        final file = await File('${directory.path}/gain-unsupported.wav')
            .writeAsBytes(syntheticWav(duration: const Duration(seconds: 10)));
        final engine = JustAudioEngine(
          gainBridge: AndroidPlaybackGain.unsupportedFixture(),
        );
        final queue = QueueCoordinator(
          authority: authority,
          engine: engine,
          prepare: (_, _) async =>
              PreparedAudio(uri: file.uri, revoke: () async {}),
        );
        await engine.loudness.setOwner(
          fence,
          LoudnessMode.track,
          isCurrent: () => authority.isCurrent(fence),
        );
        try {
          final entries = queue.createEntries([
            const Track(
              ref: LibraryTrackRef('unsupported-synthetic'),
              title: 'Fixture',
              artist: 'Fixture',
              loudnessLufs: -30,
              truePeakDb: -4,
            ),
          ], const PlayContext(surface: PlaySurface.library));
          await queue.dispatch(ReplaceQueue(entries, fence: fence));
          await Future<void>.delayed(const Duration(milliseconds: 500));
          expect(queue.snapshot.failure, isNull);
          expect(queue.snapshot.position, greaterThan(Duration.zero));
          expect(engine.loudness.gainAvailable.value, isFalse);
          expect(engine.loudness.failure.value?.code, 'loudness_unavailable');
          expect(engine.gainDiagnostics.volume, 1);
          expect((await engine.readNativeGain())!.available, isFalse);
          await queue.dispatch(const SetVolume(.3));
          expect(engine.gainDiagnostics.volume, .3);
          await queue.dispatch(const SetVolume(0));
          expect(engine.gainDiagnostics.volume, 0);
          debugPrint(
            'NATIVE_GAIN_UNSUPPORTED_PASS constructorFaultInjected=true decoderProgress=true cap=false volume=true mute=true',
          );
        } finally {
          await queue.dispose();
          await file.delete();
        }
      });
    },
  );
}
