import 'dart:async';
import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/playback/loudness_gain_policy.dart';
import 'package:soundspan/playback/native_loudness_controller.dart';
import 'package:soundspan/playback/platform_gain_adapter.dart';
import 'package:soundspan/playback/queue_snapshot.dart';

final fence = SessionFence(
  owner: OwnerKey(
    serverOrigin: Uri.parse('https://fixture.invalid'),
    userId: 'a',
  ),
  epoch: 1,
);
QueueSnapshot state(
  int generation, {
  double? lufs = -30,
  double? peak = -4,
  double? albumLufs,
  bool shuffle = false,
  double volume = 1,
  Duration position = Duration.zero,
}) => QueueSnapshot(
  fence: fence,
  generation: generation,
  currentEntryId: 'track-$generation',
  entries: [
    QueueEntry(
      entryId: 'track-$generation',
      track: Track(
        ref: LibraryTrackRef('track-$generation'),
        title: 'fixture',
        artist: 'fixture',
        albumId: 'album',
        loudnessLufs: lufs,
        truePeakDb: peak,
        albumLoudnessLufs: albumLufs,
      ),
      context: const PlayContext(surface: PlaySurface.library),
    ),
  ],
  shuffle: shuffle,
  volume: volume,
  position: position,
);

void main() {
  test(
    'neutral reset disables possibly stale native boost before volume restore',
    () async {
      final writes = <String>[];
      final adapter = PlatformGainAdapter(
        setVolume: (v) async => writes.add('volume'),
        setBoostDb: (v) async => writes.add('boost:$v'),
        delay: (_) async {},
      );
      await adapter.apply(1, -6);
      writes.clear();
      await adapter.reset(1);
      expect(writes, ['boost:0.0', 'volume']);
      await adapter.close();
    },
  );
  late NativeLoudnessController controller;
  late List<double> volumes, boosts;
  setUp(() async {
    volumes = [];
    boosts = [];
    controller = NativeLoudnessController(
      PlatformGainAdapter(
        setVolume: (v) async => volumes.add(v),
        setBoostDb: (v) async => boosts.add(v),
        delay: (_) async {},
      ),
    );
    await controller.setOwner(fence, LoudnessMode.auto, isCurrent: () => true);
  });
  tearDown(() => controller.close());

  test('native constructor unavailable keeps playback and attenuation without attempting positive gain', () async {
    controller.updateContext(state(1));
    expect(await controller.sourceReady(1, nativeActive: false), isTrue);
    expect(boosts.every((value) => value == 0), isTrue);
    expect(volumes.last, 1);
    expect(controller.gainAvailable.value, isFalse);
    expect(controller.failure.value?.code, 'loudness_unavailable');
    controller.updateContext(state(2, lufs: -8));
    await controller.sourceReady(2, nativeActive: false);
    expect(volumes.last, closeTo(math.pow(10, -10 / 20), 1e-9));
  });

  test(
    'position ticks after confirmed mode change do not restart native work',
    () async {
      controller.updateContext(state(1));
      await controller.sourceReady(1, nativeActive: true);
      await controller.setOwner(fence, LoudnessMode.off, isCurrent: () => true);
      final count = volumes.length;
      controller.updateContext(state(1, position: const Duration(seconds: 4)));
      await controller.flush();
      expect(volumes.length, count);
    },
  );

  test('failed DSP operation reports typed capability failure and preserves playback admission', () async {
    await controller.close();
    controller = NativeLoudnessController(
      PlatformGainAdapter(
        setVolume: (v) async => volumes.add(v),
        setBoostDb: (v) async {
          if (v > 0) throw StateError('native unsupported');
          boosts.add(v);
        },
        delay: (_) async {},
      ),
    );
    await controller.setOwner(fence, LoudnessMode.auto, isCurrent: () => true);
    controller.updateContext(state(1));
    expect(await controller.sourceReady(1, nativeActive: true), isTrue);
    expect(controller.gainAvailable.value, isFalse);
    expect(controller.failure.value?.code, 'loudness_unavailable');
    expect(boosts.last, 0);
    expect(volumes.last, 1);
  });

  test('setter failure stays unavailable through mode and volume changes until a new bind', () async {
    await controller.close();
    var nativeAvailable = false;
    var positiveAttempts = 0;
    controller = NativeLoudnessController(
      PlatformGainAdapter(
        setVolume: (v) async => volumes.add(v),
        setBoostDb: (v) async {
          if (v > 0) {
            positiveAttempts++;
            if (!nativeAvailable) throw UnsupportedError('effect released');
          }
          boosts.add(v);
        },
        delay: (_) async {},
      ),
    );
    await controller.setOwner(fence, LoudnessMode.track, isCurrent: () => true);
    controller.updateContext(state(1));
    expect(await controller.sourceReady(1, nativeActive: true), isTrue);
    expect(positiveAttempts, 1);
    expect(controller.gainAvailable.value, isFalse);
    expect(controller.failure.value?.code, 'loudness_unavailable');

    await controller.setOwner(fence, LoudnessMode.off, isCurrent: () => true);
    expect(controller.gainAvailable.value, isFalse);
    expect(controller.failure.value?.code, 'loudness_unavailable');
    controller.updateContext(state(1, volume: 0));
    await controller.flush();
    expect(volumes.last, 0);
    controller.updateContext(state(1, volume: .4));
    await controller.flush();
    expect(volumes.last, .4);
    await controller.setOwner(fence, LoudnessMode.track, isCurrent: () => true);
    expect(volumes.last, .4);
    expect(positiveAttempts, 1);
    controller.updateContext(state(1, lufs: -8, volume: .4));
    await controller.flush();
    expect(volumes.last, closeTo(.4 * math.pow(10, -10 / 20), 1e-9));
    expect(controller.canPlay, isTrue);
    expect(controller.gainAvailable.value, isFalse);
    expect(controller.failure.value?.code, 'loudness_unavailable');
    expect(positiveAttempts, 1);

    nativeAvailable = true;
    controller.updateContext(state(2, volume: .4));
    await controller.suspend();
    expect(await controller.sourceReady(2, nativeActive: true), isTrue);
    expect(controller.gainAvailable.value, isTrue);
    expect(controller.failure.value, isNull);
    expect(boosts.last, 3);
    expect(volumes.last, .4);
  });

  test(
    'late setter failure from an old source cannot invalidate a new bind',
    () async {
      await controller.close();
      final failedSetter = Completer<void>();
      var blocked = false;
      controller = NativeLoudnessController(
        PlatformGainAdapter(
          setVolume: (v) async => volumes.add(v),
          setBoostDb: (v) async {
            if (v > 0 && !blocked) {
              blocked = true;
              await failedSetter.future;
            }
            boosts.add(v);
          },
          delay: (_) async {},
        ),
      );
      await controller.setOwner(
        fence,
        LoudnessMode.track,
        isCurrent: () => true,
      );
      controller.updateContext(state(1));
      final oldSource = controller.sourceReady(1, nativeActive: true);
      while (!blocked) {
        await Future<void>.delayed(Duration.zero);
      }
      controller.updateContext(state(2, volume: .4));
      final newSource = controller.sourceReady(2, nativeActive: true);
      failedSetter.completeError(UnsupportedError('obsolete native lease'));
      expect(await oldSource, isFalse);
      expect(await newSource, isTrue);
      expect(controller.gainAvailable.value, isTrue);
      expect(controller.failure.value, isNull);
      expect(boosts.last, 3);
      expect(volumes.last, .4);
    },
  );

  test(
    'late mode and revoked original owner cannot contaminate replacement',
    () async {
      var currentA = true;
      await controller.setOwner(
        fence,
        LoudnessMode.track,
        isCurrent: () => currentA,
      );
      controller.updateContext(state(1));
      await controller.sourceReady(1, nativeActive: true);
      currentA = false;
      final other = SessionFence(
        owner: OwnerKey(
          serverOrigin: Uri.parse('https://fixture.invalid'),
          userId: 'b',
        ),
        epoch: 2,
      );
      await controller.setOwner(other, LoudnessMode.off, isCurrent: () => true);
      final count = volumes.length;
      await controller.releaseOwner(fence);
      expect(volumes.length, count);
      await expectLater(
        controller.setOwner(
          fence,
          LoudnessMode.track,
          isCurrent: () => currentA,
        ),
        throwsA(anything),
      );
      expect(boosts.last, 0);
    },
  );

  test('each guarded source gets its own gain before admission; missing peak and metadata reset boost', () async {
    for (final fixture in [
      (1, -9.0, -1.0, -9.0),
      (2, -30.0, -4.0, 3.0),
      (3, -8.0, -1.0, -10.0),
      (4, -30.0, null, 0.0),
      (5, null, null, 0.0),
    ]) {
      controller.updateContext(
        state(fixture.$1, lufs: fixture.$2, peak: fixture.$3),
      );
      await controller.suspend();
      expect(
        await controller.sourceReady(fixture.$1, nativeActive: true),
        isTrue,
      );
      expect(boosts.last, math.max(0, fixture.$4));
      expect(
        volumes.last,
        closeTo(math.pow(10, math.min(0, fixture.$4) / 20), 1e-9),
      );
    }
    expect(controller.gainAvailable.value, isTrue);
  });
  test('auto album shuffle, logical volume and mute; position ticks do not restart ramps', () async {
    controller.updateContext(state(1, lufs: -10, albumLufs: -14, volume: .4));
    await controller.sourceReady(1, nativeActive: true);
    expect(volumes.last, closeTo(.4 * math.pow(10, -4 / 20), 1e-9));
    final count = volumes.length;
    controller.updateContext(
      state(
        1,
        lufs: -10,
        albumLufs: -14,
        volume: .4,
        position: const Duration(seconds: 1),
      ),
    );
    await controller.flush();
    expect(volumes.length, count);
    controller.updateContext(
      state(1, lufs: -10, albumLufs: -14, volume: .4, shuffle: true),
    );
    await controller.flush();
    expect(volumes.last, closeTo(.4 * math.pow(10, -8 / 20), 1e-9));
    controller.updateContext(state(1, volume: 0));
    await controller.flush();
    expect(volumes.last, 0);
    expect(boosts.last, 3);
  });
  test(
    'old generation and original owner cannot affect replacement; off retained',
    () async {
      controller.updateContext(state(1));
      await controller.sourceReady(1, nativeActive: true);
      await controller.setOwner(fence, LoudnessMode.off, isCurrent: () => true);
      expect(boosts.last, 0);
      controller.updateContext(state(2));
      expect(await controller.sourceReady(1, nativeActive: true), isFalse);
      await controller.sourceReady(2, nativeActive: true);
      expect(boosts.last, 0);
      await controller.releaseOwner(fence);
      expect(boosts.last, 0);
      expect(await controller.sourceReady(2, nativeActive: true), isFalse);
    },
  );
  test(
    'delayed native write drains before new source, mode and close',
    () async {
      await controller.close();
      final gate = Completer<void>();
      var blocked = false;
      controller = NativeLoudnessController(
        PlatformGainAdapter(
          setVolume: (v) async => volumes.add(v),
          setBoostDb: (v) async {
            if (v > 0 && !blocked) {
              blocked = true;
              await gate.future;
            }
            boosts.add(v);
          },
          delay: (_) async {},
        ),
      );
      await controller.setOwner(
        fence,
        LoudnessMode.auto,
        isCurrent: () => true,
      );
      controller.updateContext(state(1));
      final old = controller.sourceReady(1, nativeActive: true);
      while (!blocked) {
        await Future<void>.delayed(Duration.zero);
      }
      controller.updateContext(state(2, lufs: -8));
      final latest = controller.sourceReady(2, nativeActive: true);
      gate.complete();
      expect(await old, isFalse);
      expect(await latest, isTrue);
      expect(boosts.last, 0);
      expect(volumes.last, closeTo(math.pow(10, -10 / 20), 1e-9));
      await controller.close();
      final count = boosts.length;
      controller.updateContext(state(3));
      await controller.flush();
      expect(boosts.length, count);
    },
  );
  test('unsupported platforms retain attenuation but never advertise positive gain', () async {
    await controller.close();
    controller = NativeLoudnessController(
      PlatformGainAdapter(
        setVolume: (v) async => volumes.add(v),
        delay: (_) async {},
      ),
    );
    await controller.setOwner(fence, LoudnessMode.auto, isCurrent: () => true);
    controller.updateContext(state(1));
    await controller.sourceReady(1, nativeActive: false);
    expect(volumes.last, 1);
    expect(controller.gainAvailable.value, isFalse);
  });
}
