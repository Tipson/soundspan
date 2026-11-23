import 'dart:async';
import 'dart:math' as math;

import 'package:just_audio/just_audio.dart';

import 'loudness_gain_policy.dart';

class GainCapabilities {
  const GainCapabilities({required this.positiveGain});
  final bool positiveGain;
  bool get attenuation => true;
}

/// One adapter per real player. [setBoostDb] must drive the effect inserted in
/// that player's AudioPipeline. No boost is silently replaced with volume=1.
class PlatformGainAdapter {
  PlatformGainAdapter({
    required this.setVolume,
    this.setBoostDb,
    Future<void> Function(Duration)? delay,
  }) : delay = delay ?? Future<void>.delayed;
  factory PlatformGainAdapter.android({
    required AudioPlayer player,
    required AndroidLoudnessEnhancer effect,
  }) => PlatformGainAdapter(
    setVolume: player.setVolume,
    setBoostDb: (db) async {
      if (db <= 0) await effect.setEnabled(false);
      await effect.setTargetGain(db);
      if (db > 0) await effect.setEnabled(true);
    },
  );
  final Future<void> Function(double) setVolume;
  final Future<void> Function(double)? setBoostDb;
  final Future<void> Function(Duration) delay;
  GainCapabilities get capabilities =>
      GainCapabilities(positiveGain: setBoostDb != null);
  Future<void> _tail = Future.value();
  int _revision = 0;
  bool _closed = false;
  double _factor = 1;

  /// Invalidates queued steps synchronously; in-flight native calls still drain.
  void cancelPending() => _revision++;

  Future<void> reset(double userVolume) {
    if (!userVolume.isFinite || userVolume < 0 || userVolume > 1) {
      return Future.error(ArgumentError('Invalid volume'));
    }
    if (_closed) return Future.error(StateError('Gain adapter closed'));
    final revision = ++_revision;
    final next = _tail.then((_) async {
      if (_closed || revision != _revision) return;
      // Cancellation can leave a partially acknowledged effect operation. Do
      // not infer native boost from the last completed ramp's cached factor.
      try {
        await setBoostDb?.call(0);
      } catch (_) {
        await setVolume(0);
        rethrow;
      }
      if (_closed || revision != _revision) return;
      await setVolume(userVolume);
      _factor = 1;
    });
    _tail = next.then<void>((_) {}, onError: (Object _) {});
    return next;
  }

  Future<void> apply(double userVolume, double gainDb) {
    if (!userVolume.isFinite ||
        userVolume < 0 ||
        userVolume > 1 ||
        !gainDb.isFinite ||
        gainDb > 3) {
      return Future.error(ArgumentError('Invalid gain or volume'));
    }
    if (gainDb > 0 && setBoostDb == null) {
      return Future.error(
        UnsupportedError('Positive gain requires an audio effect'),
      );
    }
    if (_closed) return Future.error(StateError('Gain adapter closed'));
    final revision = ++_revision;
    final next = _tail.then((_) async {
      final target = math.pow(10, gainDb / 20).toDouble();
      final steps = computeGainRampSteps(_factor, target);
      for (var i = 0; i < steps.length; i++) {
        if (steps.length > 1) await delay(gainRampStepDuration);
        if (_closed || revision != _revision) return;
        final factor = steps[i];
        // First lower volume, then enable boost; on decreasing boost first
        // reduce the effect before increasing player volume to avoid overshoot.
        final boost = factor > 1
            ? (i == steps.length - 1
                  ? gainDb
                  : math.min(3.0, 20 * math.log(factor) / math.ln10))
            : 0.0;
        if (factor <= _factor) await setBoostDb?.call(boost);
        if (_closed || revision != _revision) return;
        await setVolume(userVolume * math.min(1.0, factor));
        if (_closed || revision != _revision) return;
        if (factor > _factor) await setBoostDb?.call(boost);
        if (_closed || revision != _revision) return;
        _factor = factor;
      }
    });
    _tail = next.then<void>((_) {}, onError: (Object _) {});
    return next;
  }

  Future<void> close() async {
    _closed = true;
    _revision++;
    await _tail;
  }
}
