import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// Read back from Android's actual effect, in millibels (100 mB == 1 dB).
final class NativeGainState {
  const NativeGainState({
    required this.sessionId,
    required this.targetGainMb,
    required this.enabled,
    required this.available,
  });
  final int? sessionId;
  final double targetGainMb;
  final bool enabled, available;
}

/// Only binds DSP to the existing player's audio session. No audio sources.
final class AndroidPlaybackGain {
  AndroidPlaybackGain();
  @visibleForTesting
  AndroidPlaybackGain.unsupportedFixture() : _forceUnsupported = true;
  static const _channel = MethodChannel('soundspan/playback_gain');
  static int _nextLease = 0;
  bool _forceUnsupported = false;
  int? _lease, _sessionId;
  NativeGainState? _state;
  NativeGainState? get diagnostics => _state;

  Future<bool> bind(int sessionId) async {
    final lease = ++_nextLease;
    _lease = lease;
    _sessionId = sessionId;
    _state = null;
    try {
      final raw = await _channel.invokeMapMethod<String, Object?>('bind', {
        'lease': lease,
        'sessionId': sessionId,
        if (_forceUnsupported) 'forceUnsupported': true,
      });
      if (_lease != lease) return false;
      _state = _decode(raw, lease, sessionId);
      return _state!.available;
    } catch (_) {
      if (_lease == lease) {
        _state = NativeGainState(
          sessionId: sessionId,
          targetGainMb: 0,
          enabled: false,
          available: false,
        );
      }
      return false;
    }
  }

  Future<void> setBoostDb(double db) async {
    final lease = _lease, session = _sessionId;
    if (lease == null || session == null || _state?.available != true) {
      if (db > 0) throw UnsupportedError('Native gain unavailable');
      return;
    }
    final raw = await _channel.invokeMapMethod<String, Object?>('gain', {
      'lease': lease,
      'sessionId': session,
      'db': db,
    });
    if (_lease != lease) return;
    _state = _decode(raw, lease, session);
    if (!_state!.available) throw UnsupportedError('Native gain unavailable');
    if (_state!.targetGainMb > db * 100 + 1e-6 ||
        _state!.targetGainMb < db * 100 - 1.000001 ||
        _state!.enabled != (db > 0)) {
      throw StateError('Native gain acknowledgement mismatch');
    }
  }

  Future<NativeGainState?> read() async {
    final lease = _lease, session = _sessionId;
    if (lease == null || session == null) return null;
    final raw = await _channel.invokeMapMethod<String, Object?>('read', {
      'lease': lease,
      'sessionId': session,
    });
    if (_lease != lease) return null;
    return _state = _decode(raw, lease, session);
  }

  Future<void> release() async {
    final lease = _lease, session = _sessionId;
    _lease = null;
    _sessionId = null;
    _state = null;
    if (lease == null || session == null) return;
    try {
      await _channel.invokeMethod<void>('release', {
        'lease': lease,
        'sessionId': session,
      });
    } on PlatformException {
      /* Engine shutdown still releases the AudioTrack. */
    } on MissingPluginException {
      /* No native effect exists. */
    }
  }

  NativeGainState _decode(Map<String, Object?>? raw, int lease, int session) {
    final gain = raw?['targetGainMb'];
    if (raw == null ||
        raw['lease'] != lease ||
        raw['sessionId'] != session ||
        raw['available'] is! bool ||
        raw['enabled'] is! bool ||
        gain is! num ||
        !gain.isFinite ||
        raw['failure'] == 'gain_protocol') {
      throw const FormatException('Invalid native gain reply');
    }
    return NativeGainState(
      sessionId: session,
      targetGainMb: gain.toDouble(),
      enabled: raw['enabled'] as bool,
      available: raw['available'] as bool,
    );
  }
}
