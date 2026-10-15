import 'dart:async';

import 'package:flutter/foundation.dart';

import '../core/model/app_failure.dart';
import '../core/model/owner_key.dart';
import '../core/session/session_authority.dart';
import '../playback/playback_controller.dart';
import '../playback/playback_engine.dart';
import 'app_environment.dart';

enum AppPhase { booting, signedOut, changingOwner, ready, failed, closed }

/// Process lifetime differs from owner lifetime. Auth token refresh leaves the
/// handler, queue, feature controllers and navigation stacks in place.
final class AppComposition extends ChangeNotifier {
  AppComposition._(this.environment) : _origin = environment.origin {
    _session = environment.authority.changes.listen((_) {
      if (!_booting) _requestOwner();
    });
  }

  final AppEnvironment environment;
  late final StreamSubscription<SessionState> _session;
  PlaybackController? _playback;
  AppOwnerScope? _owned;
  SessionFence? _requestedFence;
  Uri _origin;
  AppPhase _phase = AppPhase.booting;
  AppFailure? _failure;
  bool _booting = true, _closing = false, _hasRequest = false;
  bool _cleanupBlocked = false;
  int _revision = 0;
  Future<void> _tail = Future.value();
  Future<void>? _closeFuture;

  AppPhase get phase => _phase;
  AppFailure? get failure => _failure;
  Uri get origin => _origin;
  PlaybackController get playback => _playback!;
  AppOwnerScope? get owner =>
      !_closing &&
          _phase == AppPhase.ready &&
          _owned != null &&
          environment.authority.isCurrent(_owned!.fence)
      ? _owned
      : null;

  static Future<AppComposition> create(AppEnvironment environment) async {
    final app = AppComposition._(environment);
    try {
      final initialFence = environment.authority.state.fence;
      app._playback = await environment.createPlayback(app._prepare);
      if (environment.authority.state.fence != initialFence) throw _stale;
      // An existing live broker/foreground service is already authoritative.
      // Calling restore again would transiently revoke and stop its queue.
      final bootstrapFence =
          initialFence ??
          (await environment.auth.restore(environment.origin)).fence;
      if (environment.authority.state.fence != bootstrapFence) throw _stale;
      app._requestOwner();
      await app.settled;
      if (app._phase == AppPhase.failed) throw _bootstrapFailure;
      if (environment.authority.state.fence != bootstrapFence) throw _stale;
      // Native configure flushes pending media commands. Keep replacement
      // suspended until those callbacks can see this admitted owner/queue.
      // Revocation still closes admission synchronously through authority.
      await environment.processReady?.call();
      if (environment.authority.state.fence != bootstrapFence) throw _stale;
      app._booting = false;
      return app;
    } catch (_) {
      app._booting = false;
      app._cleanupBlocked = true;
      app._phase = AppPhase.failed;
      app._failure = _bootstrapFailure;
      // Startup failure is final. Drain once without logging out a replacement
      // account; a later explicit close observes the same cleanup future.
      app._closeFuture = app._finishClose();
      try {
        await app._closeFuture;
      } catch (_) {
        app._failure = _cleanupFailure;
      }
      return app;
    }
  }

  Future<PreparedAudio> _prepare(QueueEntry entry, SessionFence fence) async {
    final captured = owner;
    if (captured == null || captured.fence != fence) throw _stale;
    await environment.authority.assertCurrent(fence);
    if (!identical(owner, captured)) throw _stale;
    final result = await captured.prepare(entry, fence);
    if (!identical(owner, captured) ||
        !environment.authority.isCurrent(fence)) {
      await result.revoke();
      throw _stale;
    }
    return result;
  }

  void _requestOwner() {
    if (_closing || _cleanupBlocked) return;
    final desired = environment.authority.state.fence;
    if (_hasRequest && desired == _requestedFence) return;
    _hasRequest = true;
    _requestedFence = desired;
    if (desired != null) _origin = desired.owner.serverOrigin;
    final revision = ++_revision;
    _phase = AppPhase.changingOwner;
    _failure = null;
    // Reserve order before a synchronous UI listener can trigger another auth
    // change. Old owner-tag cancellations must finish before new jobs exist.
    _tail = _tail.then((_) => _replaceOwner(desired, revision));
    notifyListeners();
  }

  Future<void> _replaceOwner(SessionFence? desired, int revision) async {
    if (_closing || revision != _revision || _cleanupBlocked) return;
    final old = _owned;
    try {
      if (old != null) {
        await playback.dispatch(const Clear());
        await old.close();
        _owned = null;
      }
    } catch (_) {
      _cleanupBlocked = true;
      _phase = AppPhase.failed;
      _failure = _cleanupFailure;
      if (!_closing) notifyListeners();
      return;
    }
    if (_closing || revision != _revision) return;
    if (desired == null) {
      _phase = AppPhase.signedOut;
      notifyListeners();
      return;
    }
    AppOwnerScope? created;
    try {
      await environment.authority.assertCurrent(desired);
      created = await environment.createOwner(desired, playback);
      if (created.fence != desired) throw _stale;
      await environment.authority.assertCurrent(desired);
      if (_closing || revision != _revision) throw _stale;
      _owned = created;
      _phase = AppPhase.ready;
      notifyListeners();
    } catch (_) {
      if (created != null) {
        try {
          await created.close();
        } catch (_) {
          // Keep the retiring scope for final close; admitting another owner
          // after a failed drain could cancel that new owner's workers.
          _owned = created;
          _cleanupBlocked = true;
        }
      }
      if (!_closing && (revision == _revision || _cleanupBlocked)) {
        _phase = AppPhase.failed;
        _failure = _cleanupBlocked ? _cleanupFailure : _bootstrapFailure;
        notifyListeners();
      }
    }
  }

  /// A testing/lifecycle barrier; it also observes transitions enqueued while
  /// an earlier factory or cancellation is awaiting IO.
  Future<void> get settled async {
    while (true) {
      final pending = _tail;
      await pending;
      if (identical(pending, _tail)) return;
    }
  }

  Future<void> logout() => environment.auth.logout();

  Future<void> close() {
    dispose();
    return _closeFuture!;
  }

  Future<void> _finishClose() async {
    await _session.cancel();
    await settled;
    try {
      await _playback?.dispatch(const Pause());
    } finally {
      try {
        // Owner checkpointing sees paused metadata before Clear can erase it.
        await _owned?.close();
        _owned = null;
      } finally {
        try {
          await _playback?.dispatch(const Clear());
        } finally {
          try {
            await _playback?.dispose();
          } finally {
            await environment.release?.call();
          }
        }
      }
    }
  }

  @override
  void dispose() {
    if (_closing) return;
    _closing = true;
    _revision++;
    _phase = AppPhase.closed;
    super.dispose();
    // Process disposal retains credentials/downloads. Framework callers cannot
    // await dispose; observe its failure while close() still exposes the error.
    _closeFuture ??= _finishClose();
    unawaited(_closeFuture!.then<void>((_) {}, onError: (Object _) {}));
  }

  static const _stale = AppFailure(
    code: 'stale_session',
    message: 'Сеанс завершён.',
  );
  static const _bootstrapFailure = AppFailure(
    code: 'app_start_unavailable',
    message: 'Не удалось открыть приложение. Повторите запуск.',
    retryable: true,
  );
  static const _cleanupFailure = AppFailure(
    code: 'owner_cleanup_failed',
    message: 'Не удалось безопасно завершить прошлый сеанс. Перезапустите приложение.',
  );
}
