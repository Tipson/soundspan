import 'dart:async';

import '../core/model/owner_key.dart';
import '../core/network/request_cancellation.dart';
import '../core/session/session_authority.dart';
import 'finite_queue_admission_api.dart';
import 'queue_snapshot.dart';
import 'resolved_media.dart';

typedef _Capture = ({
  SessionFence fence,
  int lineage,
  int generation,
  String? current,
  int mutation,
  int queue,
});

/// One independent preference intent, including like/clear and unsent intents.
final class FiniteQueueMutation {
  FiniteQueueMutation._();
}

/// Its getters recheck ownership so a saved allowed response cannot be replayed.
final class FiniteQueueAdmissionEvaluation {
  FiniteQueueAdmissionEvaluation._(this._result, this._current);
  final FiniteQueueAdmissionResult _result;
  final bool Function() _current;
  bool get isCurrent => _current();
  FiniteQueueAdmissionMode get mode =>
      isCurrent ? _result.mode : FiniteQueueAdmissionMode.unavailable;
  FiniteQueueAdmissionState stateAt(int index) =>
      isCurrent && index >= 0 && index < _result.states.length
      ? _result.states[index]
      : FiniteQueueAdmissionState.unavailable;
}

/// Runtime-only owner/queue/mutation fence. A single deadline covers pending
/// writes, authoritative owner admission, refresh and the read-only request.
final class FiniteQueueAdmissionCoordinator {
  FiniteQueueAdmissionCoordinator({
    required this.api,
    required this.authority,
    required this.snapshot,
    Stream<QueueSnapshot>? snapshots,
    this.timeout = const Duration(seconds: 17),
  }) {
    _sessions = authority.changes.listen((_) => _cancelStale());
    _snapshots = snapshots?.listen((_) => _cancelStale());
  }
  final FiniteQueueAdmissionApi api;
  final SessionAuthority authority;
  final QueueSnapshot Function() snapshot;
  final Duration timeout;
  late final StreamSubscription<SessionState> _sessions;
  StreamSubscription<QueueSnapshot>? _snapshots;
  final _pending = <FiniteQueueMutation>{};
  final _flights = <_Flight>[];
  final _changes = StreamController<void>.broadcast(sync: true);
  Stream<void> get changes => _changes.stream;
  Completer<void> _pendingChanged = Completer<void>();
  int _mutation = 0, _queue = 0;
  bool _closed = false;
  int get mutationEpoch => _mutation;
  int get queueEpoch => _queue;
  int get pendingMutations => _pending.length;
  bool isMutationCurrent(int epoch) =>
      !_closed && _mutation == epoch && _pending.isEmpty;

  FiniteQueueMutation beginMutation() {
    final ticket = FiniteQueueMutation._();
    if (_closed) return ticket;
    ++_mutation;
    _pending.add(ticket);
    _cancelAll();
    _changes.add(null);
    return ticket;
  }

  void finishMutation(FiniteQueueMutation ticket) {
    if (!_pending.remove(ticket)) return;
    final changed = _pendingChanged;
    _pendingChanged = Completer<void>();
    changed.complete();
    if (!_closed) _changes.add(null);
  }

  Future<T> trackMutation<T>(Future<T> Function() operation) async {
    final ticket = beginMutation();
    try {
      return await operation();
    } finally {
      finishMutation(ticket);
    }
  }

  /// Reserve synchronously before a manual queue/selection admission awaits.
  void invalidateQueue() {
    ++_queue;
    _cancelAll();
    if (!_closed) _changes.add(null);
  }

  _Capture? _capture(QueueSnapshot state, [SessionFence? emptyFence]) {
    final fence = state.fence ?? (state.entries.isEmpty ? emptyFence : null);
    if (fence == null) return null;
    return (
      fence: fence,
      lineage: state.lineage,
      generation: state.generation,
      current: state.currentEntryId,
      mutation: _mutation,
      queue: _queue,
    );
  }

  bool _current(_Capture capture) =>
      !_closed &&
      authority.isCurrent(capture.fence) &&
      _capture(snapshot(), capture.fence) == capture;

  void _cancelAll() {
    for (final flight in _flights.toList()) {
      flight.cancellation.cancel();
    }
  }

  void _cancelStale() {
    for (final flight in _flights.toList()) {
      if (!_current(flight.capture)) flight.cancellation.cancel();
    }
  }

  Future<FiniteQueueAdmissionEvaluation> admit({
    required QueueSnapshot captured,
    required List<FiniteQueueAdmissionReference> references,
    SessionFence? emptyQueueFence,
  }) {
    final refs = List<FiniteQueueAdmissionReference>.unmodifiable(references);
    final capture = _capture(captured, emptyQueueFence);
    if (capture == null || !_current(capture)) {
      return Future.value(
        FiniteQueueAdmissionEvaluation._(
          FiniteQueueAdmissionResult.unavailable(refs.length),
          () => false,
        ),
      );
    }
    for (final flight in _flights) {
      if (flight.capture == capture && _sameRefs(flight.references, refs)) {
        return flight.future;
      }
    }
    final flight = _Flight(capture, refs);
    _flights.add(flight);
    flight.future = _evaluate(flight);
    return flight.future;
  }

  Future<FiniteQueueAdmissionEvaluation> _evaluate(_Flight flight) async {
    final cancellation = flight.cancellation;
    final timer = Timer(timeout, cancellation.cancel);
    var result = FiniteQueueAdmissionResult.unavailable(
      flight.references.length,
    );
    try {
      result = await cancellation.run(() async {
        while (_pending.isNotEmpty) {
          await _pendingChanged.future;
          cancellation.check();
        }
        if (!_current(flight.capture)) {
          cancellation.cancel();
          cancellation.check();
        }
        await authority.assertCurrent(flight.capture.fence);
        cancellation.check();
        if (!_current(flight.capture)) {
          cancellation.cancel();
          cancellation.check();
        }
        final states = <FiniteQueueAdmissionState>[];
        for (var start = 0; start < flight.references.length; start += 100) {
          cancellation.check();
          if (!_current(flight.capture)) {
            cancellation.cancel();
            cancellation.check();
          }
          final end = start + 100 < flight.references.length
              ? start + 100
              : flight.references.length;
          final batch = await api.admit(
            flight.references.sublist(start, end),
            fence: flight.capture.fence,
            cancellation: cancellation,
          );
          cancellation.check();
          if (batch.mode != FiniteQueueAdmissionMode.authoritative) {
            return FiniteQueueAdmissionResult(
              batch.mode,
              List.filled(
                flight.references.length,
                FiniteQueueAdmissionState.unavailable,
              ),
            );
          }
          states.addAll(batch.states);
          // Automatic selection needs the first usable occurrence. Remaining
          // queue rows are checked only when they become actual candidates.
          if (batch.states.contains(FiniteQueueAdmissionState.allowed)) break;
        }
        states.addAll(
          List.filled(
            flight.references.length - states.length,
            FiniteQueueAdmissionState.unavailable,
          ),
        );
        return FiniteQueueAdmissionResult(
          FiniteQueueAdmissionMode.authoritative,
          states,
        );
      });
    } catch (_) {
      // Cancellation/timeout never schedule another attempt or retain a grant.
    } finally {
      timer.cancel();
      _flights.remove(flight);
    }
    return FiniteQueueAdmissionEvaluation._(
      result,
      () => !cancellation.isCancelled && _current(flight.capture),
    );
  }

  static bool _sameRefs(
    List<FiniteQueueAdmissionReference> a,
    List<FiniteQueueAdmissionReference> b,
  ) =>
      a.length == b.length &&
      List.generate(a.length, (i) => a[i] == b[i]).every((equal) => equal);

  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    _cancelAll();
    await _sessions.cancel();
    await _snapshots?.cancel();
    await _changes.close();
  }
}

final class _Flight {
  _Flight(this.capture, this.references);
  final _Capture capture;
  final List<FiniteQueueAdmissionReference> references;
  final cancellation = MediaCancellation();
  late final Future<FiniteQueueAdmissionEvaluation> future;
}
