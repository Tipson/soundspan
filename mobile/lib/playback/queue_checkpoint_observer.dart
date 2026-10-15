import 'dart:async';

import 'package:flutter/foundation.dart';

import '../core/model/app_failure.dart';
import '../core/model/owner_key.dart';
import '../core/session/session_authority.dart';
import 'playback_controller.dart';

/// The only caller of the service's QueueSnapshotStore.save. Position traffic
/// is coalesced; explicit controls/lifecycle checkpoints capture current truth.
final class QueueCheckpointObserver {
  QueueCheckpointObserver({
    required this.playback,
    required this.authority,
    required this.fence,
    required this.save,
    this.interval = const Duration(seconds: 5),
  }) {
    if (interval <= Duration.zero) {
      throw ArgumentError('Invalid checkpoint interval');
    }
    _events = playback.events.listen(_onEvent);
  }

  final PlaybackController playback;
  final SessionAuthority authority;
  final SessionFence fence;
  final Future<void> Function(QueueSnapshot, SessionFence) save;
  final Duration interval;
  final failure = ValueNotifier<AppFailure?>(null);
  late final StreamSubscription<PlaybackEvent> _events;
  final _pending = <Future<void>>{};
  Duration? _lastElapsed;
  bool _closed = false;
  Future<void>? _closing;

  void _onEvent(PlaybackEvent event) {
    if (_closed || !authority.isCurrent(fence)) return;
    if (event.kind == PlaybackEventKind.position &&
        _lastElapsed != null &&
        event.elapsed - _lastElapsed! < interval) {
      return;
    }
    _lastElapsed = event.elapsed;
    // _saveCurrent attaches an error observer; automatic saves never create an
    // unhandled future or interrupt the audible queue on a storage failure.
    _saveCurrent();
  }

  Future<void> checkpoint() => _closed ? Future.value() : _saveCurrent();

  Future<void> _saveCurrent() {
    if (!authority.isCurrent(fence)) return Future.value();
    final snapshot = playback.snapshot;
    if (snapshot.fence != null && snapshot.fence != fence) {
      return Future.value();
    }
    // Future.sync invokes capture/encode now and also routes synchronous store
    // failures through the same observed error path as asynchronous failures.
    final operation = Future<void>.sync(() => save(snapshot, fence));
    _pending.add(operation);
    unawaited(
      operation.then<void>(
        (_) {
          _pending.remove(operation);
          if (!_closed) failure.value = null;
        },
        onError: (Object _) {
          _pending.remove(operation);
          if (!_closed && authority.isCurrent(fence)) {
            failure.value = const AppFailure(
              code: 'queue_checkpoint_failed',
              message: 'Не удалось сохранить очередь на устройстве.',
              retryable: true,
            );
          }
        },
      ),
    );
    return operation;
  }

  /// Flush while the service queue still contains paused metadata, before
  /// Clear/dispose. Revoked sessions perform no new private-data writes.
  Future<void> close() {
    if (_closing != null) return _closing!;
    final completion = Completer<void>();
    _closing = completion.future;
    _closed = true;
    final flush = _saveCurrent();
    final pending = {..._pending, flush}.toList(growable: false);
    completion.complete(_finish(pending));
    return completion.future;
  }

  Future<void> _finish(List<Future<void>> pending) async {
    try {
      await _events.cancel();
      await Future.wait<void>(pending);
    } finally {
      failure.dispose();
    }
  }
}
