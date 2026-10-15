import 'dart:math' as math;
import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/playback/loudness_gain_policy.dart';
import 'package:soundspan/playback/platform_gain_adapter.dart';

void main() {
  test(
    'native ramp follows eight 25ms steps and close prevents late gain',
    () async {
      final delays = <Duration>[], volumes = <double>[];
      final adapter = PlatformGainAdapter(
        setVolume: (v) async => volumes.add(v),
        delay: (d) async => delays.add(d),
      );
      await adapter.apply(1, -6);
      expect(delays, List.filled(8, const Duration(milliseconds: 25)));
      expect(volumes.length, 8);
      final gate = Completer<void>();
      var writes = 0;
      final closing = PlatformGainAdapter(
        setVolume: (_) async {
          writes++;
        },
        delay: (_) => gate.future,
      );
      final pending = closing.apply(1, -6);
      await Future<void>.delayed(Duration.zero);
      final closed = closing.close();
      gate.complete();
      await pending;
      await closed;
      expect(writes, 0);
    },
  );
  test('web fixtures attenuation, boost, peak, scope and passthrough', () {
    LoudnessDecision gain(
      Map<String, Object?>? track, {
      LoudnessMode mode = LoudnessMode.auto,
      bool album = false,
      double target = -18,
    }) => resolveLoudnessGain(
      track: track,
      mode: mode,
      isAlbumContext: album,
      targetLufs: target,
    );
    expect(gain(null).reason, 'no_track');
    expect(gain({}, mode: LoudnessMode.off).reason, 'mode_off');
    expect(gain({}, target: double.nan).reason, 'invalid_target');
    expect(gain({}).reason, 'unmeasured');
    expect(gain({'loudnessLufs': -9.5}).gainDb, -8.5);
    expect(gain({'loudnessLufs': -30, 'truePeakDb': -12}).gainDb, 3);
    expect(gain({'loudnessLufs': -24, 'truePeakDb': -1.5}).gainDb, 1.5);
    expect(gain({'loudnessLufs': -30}).reason, 'boost_denied_no_peak');
    expect(gain({'loudnessLufs': -25, 'truePeakDb': .8}).gainDb, 0);
    final row = <String, Object?>{
      'loudnessLufs': -8,
      'album': {'albumLoudnessLufs': -12},
    };
    expect(gain(row, album: true).gainDb, -6);
    expect(gain(row).gainDb, -10);
    expect(gain({...row, 'albumLoudnessLufs': -10}, album: true).gainDb, -8);
    expect(gain({'loudnessLufs': -14}, mode: LoudnessMode.album).gainDb, -4);
    expect(
      gain({
        'loudnessLufs': -21,
        'truePeakDb': -2,
        'albumLoudnessLufs': -22,
      }, mode: LoudnessMode.album).gainDb,
      2,
    );
    expect(
      gain({'loudnessLufs': -9.5}).gainFactor,
      closeTo(math.pow(10, -8.5 / 20), 1e-9),
    );
  });
  test('album auto is bounded and ramp is exact', () {
    expect(isAlbumOrderedQueue(['a', 'a'], false), isTrue);
    expect(isAlbumOrderedQueue(['a', 'b'], false), isFalse);
    expect(isAlbumOrderedQueue(['a'], true), isFalse);
    expect(isAlbumOrderedQueue([null], false), isFalse);
    expect(isAlbumOrderedQueue(List.filled(500, 'a'), false), isTrue);
    expect(isAlbumOrderedQueue(List.filled(501, 'a'), false), isFalse);
    expect(computeGainRampSteps(.5, 1, steps: 4), [.625, .75, .875, 1]);
    expect(computeGainRampSteps(0, 1).length, 8);
    expect(computeGainRampSteps(0, 1, steps: 10000).length, 32);
  });
  test('adapter combines volume attenuation and actual boost port', () async {
    final volumes = <double>[], boosts = <double>[];
    final adapter = PlatformGainAdapter(
      setVolume: (v) async => volumes.add(v),
      setBoostDb: (v) async => boosts.add(v),
      delay: (_) async {},
    );
    await adapter.apply(.5, -6);
    expect(volumes.last, closeTo(.5 * math.pow(10, -6 / 20), 1e-9));
    expect(boosts.last, 0);
    await adapter.apply(.5, 3);
    expect(volumes.last, .5);
    expect(boosts.last, 3);
    expect(adapter.capabilities.positiveGain, isTrue);
    await expectLater(adapter.apply(1, double.nan), throwsArgumentError);
    final limited = PlatformGainAdapter(
      setVolume: (v) async {},
      delay: (_) async {},
    );
    expect(limited.capabilities.positiveGain, isFalse);
    await expectLater(limited.apply(1, 3), throwsUnsupportedError);
  });
}
