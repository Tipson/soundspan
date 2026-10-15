import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../core/model/app_failure.dart';
import '../../core/model/owner_key.dart';
import '../../core/network/network_policy.dart';
import '../../core/session/session_authority.dart';
import '../../playback/playback_controller.dart';
import '../../playback/wave_continuation.dart';
export '../../playback/wave_selection.dart';

/// Thin owner-bound presenter for the service; no UI queue or audio instance.
final class WaveController extends ChangeNotifier {
  WaveController({
    required this.continuation,
    required this.playback,
    required this.authority,
    required this.fence,
    this.networkPolicy = const NetworkPolicy.online(),
  }) {
    _observedSelection = continuation.state.selection;
    _wave = continuation.states.listen((_) {
      if (continuation.state.selection != _observedSelection) {
        _observedSelection = continuation.state.selection;
        ++_selectionRevision;
      }
      if (isCurrent) notifyListeners();
    });
    _queue = playback.snapshots.listen((_) {
      if (isCurrent) notifyListeners();
    });
    _sessions = authority.changes.listen((_) {
      if (!authority.isCurrent(fence)) _revoked = true;
      if (!_disposed) notifyListeners();
    });
  }
  final WaveContinuation continuation;
  final PlaybackController playback;
  final SessionAuthority authority;
  final SessionFence fence;
  final NetworkPolicy networkPolicy;
  late final StreamSubscription<WaveState> _wave;
  late final StreamSubscription<QueueSnapshot> _queue;
  late final StreamSubscription<SessionState> _sessions;
  bool _disposed = false, _revoked = false;
  AppFailure? _failure;
  int _intent = 0;
  int _selectionRevision = 0;
  WaveSelection _observedSelection = const WaveSelection();
  int get selectionRevision => _selectionRevision;
  bool get isCurrent {
    if (!authority.isCurrent(fence)) _revoked = true;
    return !_disposed && !_revoked;
  }

  bool get online => networkPolicy.networkAllowed;
  WaveState get state => isCurrent ? continuation.state : const WaveState();
  WaveSelection get selection => state.selection;
  AppFailure? get failure => _failure ?? state.failure;
  QueueSnapshot get snapshot => isCurrent && playback.snapshot.fence == fence
      ? playback.snapshot
      : QueueSnapshot();
  bool get ownsCurrentWave =>
      state.status != WaveStatus.detached &&
      snapshot.currentEntry?.context.surface == PlaySurface.wave;
  List<QueueEntry> get upcoming {
    if (!ownsCurrentWave) return [];
    final queue = snapshot,
        index = queue.effectiveOrder.indexOf(queue.currentEntryId ?? '');
    final byId = {for (final entry in queue.entries) entry.entryId: entry};
    return [
      for (final id in queue.effectiveOrder.skip(index < 0 ? 0 : index + 1))
        if (byId[id] != null) byId[id]!,
    ];
  }

  Future<void> _run(
    Future<void> Function() action, {
    bool network = false,
  }) async {
    if (!isCurrent) return;
    final intent = ++_intent;
    try {
      if (network) networkPolicy.requireNetwork();
      await authority.assertCurrent(fence);
      if (!isCurrent || intent != _intent) return;
      _failure = null;
      await action();
    } catch (error) {
      if (isCurrent && intent == _intent) {
        _failure = error is AppFailure
            ? error
            : const AppFailure(
                code: 'wave_failed',
                message: 'Не удалось выполнить действие с волной.',
                retryable: true,
              );
      }
    }
    if (isCurrent && intent == _intent) notifyListeners();
  }

  Future<void> start() {
    ++_selectionRevision;
    return _run(() => continuation.start(selection, fence), network: true);
  }

  Future<void> apply(WaveSelection draft) {
    ++_selectionRevision;
    return _run(
      () => state.status == WaveStatus.detached
          ? continuation.start(draft, fence)
          : continuation.retune(draft),
      network: true,
    );
  }

  Future<void> retry() => _run(continuation.retry, network: true);
  Future<void> togglePlayback() => _run(() async {
    if (!ownsCurrentWave) return;
    await playback.dispatch(
      snapshot.playingIntent ? const Pause() : const Resume(),
    );
  });
  Future<void> playUpcoming(String entryId) => _run(() async {
    if (!upcoming.any((e) => e.entryId == entryId && e.track.playable)) return;
    await playback.dispatch(PlayEntry(entryId));
  });
  @override
  void dispose() {
    _disposed = true;
    ++_intent;
    unawaited(_wave.cancel());
    unawaited(_queue.cancel());
    unawaited(_sessions.cancel());
    super.dispose(); // Service lifetime is independent of this screen.
  }
}
