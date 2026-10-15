import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';

import '../core/model/app_failure.dart';
import '../core/model/owner_key.dart';
import 'loudness_gain_policy.dart';
import 'platform_gain_adapter.dart';
import 'queue_snapshot.dart';

/// Optional engine capability: existing engines and test fakes stay compatible.
abstract interface class LoudnessPlaybackEngine {
  NativeLoudnessController get loudness;
  void updateLoudnessContext(QueueSnapshot state);
}

/// Process-owned gain state. A resolver and a widget can never activate a gain.
/// Source admission waits for serialized native writes for the latest context.
final class NativeLoudnessController {
  NativeLoudnessController(this.adapter);
  final PlatformGainAdapter adapter;
  final gainAvailable = ValueNotifier<bool>(false);
  final failure = ValueNotifier<AppFailure?>(null);
  SessionFence? _owner;
  bool Function()? _isCurrent;
  LoudnessMode _mode = LoudnessMode.off;
  QueueSnapshot? _context;
  int? _activeGeneration;
  int _revision = 0;
  bool _closed = false, _nativeActive = false;
  Future<void> _pending = Future.value();
  Future<void>? _closing;
  (int, SessionFence?, double, double)? _signature;

  bool get _current =>
      !_closed && _owner != null && (_isCurrent?.call() ?? false);
  bool get hasOwner => _owner != null;
  bool get canPlay => _activeGeneration != null && _valid(_activeGeneration!);
  bool _valid(int generation) =>
      _current &&
      _context?.fence == _owner &&
      _context?.generation == generation;
  double get _volume => _context?.volume ?? 1;
  double get _gain {
    final state = _context;
    final track = state?.currentEntry?.track;
    if (!_current || state?.fence != _owner || track == null) return 0;
    final gain = resolveLoudnessGain(
      track: {
        'loudnessLufs': track.loudnessLufs,
        'truePeakDb': track.truePeakDb,
        'albumLoudnessLufs': track.albumLoudnessLufs,
        'albumTruePeakDb': track.albumTruePeakDb,
      },
      mode: _mode,
      isAlbumContext: isAlbumOrderedQueue(
        state!.entries.map((e) => e.track.albumId).toList(),
        state.shuffle,
      ),
    ).gainDb;
    return adapter.capabilities.positiveGain && _nativeActive
        ? gain
        : math.min(0, gain);
  }

  Future<void> setOwner(
    SessionFence fence,
    LoudnessMode mode, {
    required bool Function() isCurrent,
  }) async {
    if (_closed || !isCurrent()) throw _stale;
    if (_owner != fence) {
      _owner = null;
      if (_context?.fence != fence) _context = null;
      await suspend();
      if (_closed || !isCurrent()) throw _stale;
      _owner = fence;
      _isCurrent = isCurrent;
    }
    _mode = mode;
    final state = _context;
    _signature = state == null
        ? null
        : (state.generation, state.fence, state.volume, _gain);
    _revision++;
    adapter.cancelPending();
    if (_activeGeneration != null) await _queueApply(_activeGeneration!);
  }

  Future<void> releaseOwner(SessionFence original) async {
    if (_owner != original || _closed) return;
    _owner = null;
    _isCurrent = null;
    _context = null;
    await suspend();
  }

  /// Capture only. Native work starts in a microtask outside queue publication.
  void updateContext(QueueSnapshot state) {
    if (_closed) return;
    _context = state;
    final next = (state.generation, state.fence, state.volume, _gain);
    if (_signature == next) return;
    _signature = next;
    _revision++;
    adapter.cancelPending();
    if (_activeGeneration == state.generation && _valid(state.generation)) {
      _queueApply(state.generation);
    }
  }

  Future<void> suspend() {
    _activeGeneration = null;
    _nativeActive = false;
    if (!_closed) gainAvailable.value = false;
    _revision++;
    adapter.cancelPending();
    return _pending = _reset();
  }

  Future<void> _reset() async {
    try {
      await adapter.reset(_volume);
    } catch (_) {
      if (!_closed) _failed();
    }
  }

  Future<bool> sourceReady(int generation, {required bool nativeActive}) async {
    if (!_valid(generation)) return false;
    _activeGeneration = generation;
    _nativeActive = nativeActive;
    final state = _context!;
    _signature = (state.generation, state.fence, state.volume, _gain);
    await _queueApply(generation);
    return _valid(generation) && _activeGeneration == generation;
  }

  Future<void> _queueApply(int generation) =>
      _pending = _pending.then((_) => _apply(generation));

  Future<void> _apply(int generation) async {
    while (_valid(generation) && _activeGeneration == generation) {
      final revision = _revision;
      try {
        await adapter.apply(_volume, _gain);
        if (!_valid(generation) || _activeGeneration != generation) return;
        if (revision != _revision) continue;
        gainAvailable.value =
            _nativeActive && adapter.capabilities.positiveGain;
        if (!gainAvailable.value && adapter.capabilities.positiveGain) {
          _failed();
        } else {
          failure.value = null;
        }
        return;
      } catch (_) {
        if (!_valid(generation) || _activeGeneration != generation) return;
        // A neutral write cannot restore an effect released by native failure.
        // Only sourceReady with a fresh native bind may restore this flag.
        _nativeActive = false;
        _failed();
        // A failed boost is never advertised. Disable it before passthrough.
        await _reset();
        return;
      }
    }
  }

  void _failed() {
    gainAvailable.value = false;
    failure.value = const AppFailure(
      code: 'loudness_unavailable',
      message: 'Выравнивание громкости недоступно на этом устройстве.',
    );
  }

  Future<void> flush() => _pending;
  Future<void> close() {
    if (_closing != null) return _closing!;
    _owner = null;
    _context = null;
    _closed = true;
    _activeGeneration = null;
    adapter.cancelPending();
    return _closing = () async {
      await _pending;
      await adapter.close();
      gainAvailable.dispose();
      failure.dispose();
    }();
  }

  static const _stale = AppFailure(
    code: 'stale_session',
    message: 'Сеанс завершён.',
  );
}
