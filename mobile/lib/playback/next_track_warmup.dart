import 'dart:async';

import '../core/model/owner_key.dart';
import '../core/session/session_authority.dart';
import 'playback_controller.dart';
import 'resolved_media.dart';
import 'finite_queue_admission_coordinator.dart';
import 'finite_queue_admission_api.dart';

typedef WarmNextAudio = Future<void> Function(
  QueueEntry entry,
  SessionFence fence,
  MediaCancellation cancellation,
);

typedef _WarmKey = ({
  SessionFence fence,
  int generation,
  int lineage,
  String current,
  String next,
  int mutation,
});

/// Best-effort service work; never owns a decoder or changes playback intent.
final class NextTrackWarmup {
  NextTrackWarmup({
    required this.controller,
    required this.authority,
    required this.networkAllowed,
    required this.warm,
    this.timeout = const Duration(seconds: 8),
    this.finiteAdmission,
  }) {
    _snapshots = controller.snapshots.listen(_observe);
    _sessions = authority.changes.listen((_) => _observe(controller.snapshot));
    _admission = finiteAdmission?.changes.listen((_) {
      cancelNetwork();
      if (finiteAdmission!.pendingMutations == 0) _observe(controller.snapshot);
    });
  }
  final PlaybackController controller;
  final SessionAuthority authority;
  final bool Function() networkAllowed;
  final WarmNextAudio warm;
  final Duration timeout;
  final FiniteQueueAdmissionCoordinator? finiteAdmission;
  late final StreamSubscription<QueueSnapshot> _snapshots;
  late final StreamSubscription<SessionState> _sessions;
  StreamSubscription<void>? _admission;
  _WarmKey? _active, _attempted;
  MediaCancellation? _cancellation;
  Timer? _deadline;
  bool _closed = false, _running = false;

  void _observe(QueueSnapshot state) {
    final fence = state.fence;
    final index = state.effectiveOrder.indexOf(state.currentEntryId ?? '');
    final order = state.effectiveOrder;
    final byId = {for (final entry in state.entries) entry.entryId: entry};
    bool allowed(String id) {
      final entry = byId[id];
      return entry != null &&
          entry.track.playable &&
          state.allowsRecommendation(entry.track.ref, entry.context);
    }

    final candidates =
        index < 0 || order.length < 2 || state.repeat == QueueRepeat.one
        ? <String>[]
        : [
            ...order.skip(index + 1).where(allowed),
            if (state.repeat == QueueRepeat.all)
              ...order.take(index + 1).where(allowed),
          ];
    final next = candidates.firstOrNull;
    final entry = state.entries.where((e) => e.entryId == next).firstOrNull;
    final _WarmKey? key =
        !_closed &&
            networkAllowed() &&
            (finiteAdmission?.pendingMutations ?? 0) == 0 &&
            fence != null &&
            authority.isCurrent(fence) &&
            state.playing &&
            state.audible &&
            state.processing == PlaybackProcessing.ready &&
            state.position >= const Duration(seconds: 2) &&
            entry != null &&
            entry.track.playable
        ? (
            fence: fence,
            generation: state.generation,
            lineage: state.lineage,
            current: state.currentEntryId!,
            next: entry.entryId,
            mutation: finiteAdmission?.mutationEpoch ?? 0,
          )
        : null;
    if (key != _active) cancelNetwork();
    if (key == null || _running || key == _attempted) return;
    _active = _attempted = key;
    _running = true;
    final cancellation = _cancellation = MediaCancellation();
    _deadline = Timer(timeout, cancellation.cancel);
    void finished() {
      _deadline?.cancel();
      _deadline = null;
      _cancellation = null;
      _active = null;
      _running = false;
      if (!_closed) _observe(controller.snapshot);
    }

    // A failed speculative request is terminal for this occurrence. Playback's
    // normal preparation remains the only authority for a user-visible error.
    unawaited(
      Future<void>.sync(
        () => _warmAdmitted(
          state,
          candidates.map((id) => byId[id]!).toList(),
          key.fence,
          cancellation,
        ),
      ).then<void>((_) => finished(), onError: (Object _) => finished()),
    );
  }

  Future<void> _warmAdmitted(
    QueueSnapshot captured,
    List<QueueEntry> candidates,
    SessionFence fence,
    MediaCancellation cancellation,
  ) async {
    final policy = finiteAdmission;
    QueueEntry? next;
    if (policy == null ||
        candidates.first.context.recommendationScopeKey == null) {
      next = candidates.first;
    } else {
      final automatic = candidates
          .takeWhile((entry) => entry.context.recommendationScopeKey != null)
          .toList();
      final manual = candidates.skip(automatic.length).firstOrNull;
      final refs = <FiniteQueueAdmissionReference>[];
      final referenced = <QueueEntry>[];
      for (final entry in automatic) {
        final ref = FiniteQueueAdmissionReference.fromTrack(
          entry.track.ref,
          generationId: entry.context.recommendationGenerationId,
        );
        if (ref != null) {
          refs.add(ref);
          referenced.add(entry);
        }
      }
      final result = await policy.admit(captured: captured, references: refs);
      cancellation.check();
      if (!result.isCurrent ||
          result.mode == FiniteQueueAdmissionMode.unavailable) {
        return;
      }
      if (result.mode == FiniteQueueAdmissionMode.legacyExact) {
        next = automatic.firstOrNull ?? manual;
      } else {
        for (var i = 0; i < referenced.length; i++) {
          if (result.stateAt(i) == FiniteQueueAdmissionState.allowed) {
            next = referenced[i];
            break;
          }
        }
        next ??= manual;
      }
    }
    cancellation.check();
    if (next != null) await warm(next, fence, cancellation);
  }

  void cancelNetwork() {
    _cancellation?.cancel();
    _deadline?.cancel();
    _deadline = null;
    _active = null;
  }

  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    cancelNetwork();
    await Future.wait([_snapshots.cancel(), _sessions.cancel()]);
    await _admission?.cancel();
  }
}
