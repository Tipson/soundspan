import 'dart:async';

import 'package:flutter/foundation.dart';

import '../model/app_failure.dart';
import '../model/owner_key.dart';
import '../session/session_authority.dart';
import '../storage/owner_store.dart';
import 'network_policy.dart';

/// One mutable, owner-fenced admission policy shared by all foreground clients.
/// The Android worker reads the same settings/network record before admission.
/// Credential freshness and temporary connectivity never change this setting.
final class StoredNetworkPolicy extends ChangeNotifier
    implements NetworkPolicy {
  StoredNetworkPolicy._({
    required this.store,
    required this.authority,
    required this.fence,
    required this.onOffline,
  }) {
    _session = authority.changes.listen((_) {
      if (!authority.isCurrent(fence)) {
        _revoked = true;
        _revision++;
        _offline = true;
        _notify();
      }
    });
  }

  final OwnerStore store;
  final SessionAuthority authority;
  final SessionFence fence;

  /// Root cancels this owner's native workers and foreground network transfers.
  /// A failing cancellation is reported; it never silently enables networking.
  final Future<void> Function(SessionFence) onOffline;
  late final StreamSubscription<SessionState> _session;
  Future<void> _tail = Future.value();
  bool _offline = true, _busy = false, _disposed = false, _revoked = false;
  int _revision = 0;
  AppFailure? _failure;
  bool get offline => _offline;
  bool get busy => _busy;
  AppFailure? get failure => _failure;
  bool get _current => !_disposed && !_revoked && authority.isCurrent(fence);

  @override
  bool get networkAllowed =>
      _current && !_offline && !_busy && _failure == null;

  static Future<StoredNetworkPolicy> restore({
    required OwnerStore store,
    required SessionAuthority authority,
    required SessionFence fence,
    required Future<void> Function(SessionFence) onOffline,
  }) async {
    final policy = StoredNetworkPolicy._(
      store: store,
      authority: authority,
      fence: fence,
      onOffline: onOffline,
    );
    try {
      await authority.assertCurrent(fence);
      final row = await store.transaction(
        fence,
        (tx) => tx.read('settings', 'network'),
      );
      await authority.assertCurrent(fence);
      if (!policy._current) return policy;
      if (row == null) {
        policy._offline = false;
      } else if (row.length != 2 ||
          row['version'] != 1 ||
          row['offline'] is! bool) {
        policy._failure = const AppFailure(
          code: 'invalid_network_preference',
          message:
              'Настройка сети повреждена. Выберите режим подключения снова.',
        );
      } else {
        policy._offline = row['offline'] as bool;
      }
    } catch (_) {
      policy._failure = _storageFailure;
    }
    return policy;
  }

  @override
  void requireNetwork() {
    if (!_current) throw _stale;
    if (!networkAllowed) {
      throw _failure ??
          const AppFailure(
            code: 'offline_mode',
            message: 'Включён офлайн-режим. Откройте загруженную музыку.',
          );
    }
  }

  /// Closing admission is synchronous. Opening it waits for durable commit and
  /// all earlier cancellation/write commands; only the latest choice publishes.
  Future<void> setOffline(bool value) {
    if (!_current) return Future.error(_stale);
    if (!_busy && _failure == null && _offline == value) return Future.value();
    final revision = ++_revision;
    _offline = value;
    _busy = true;
    _failure = null;
    final result = _tail.then((_) async {
      try {
        if (!_current) throw _stale;
        await authority.assertCurrent(fence);
        await Future.wait<void>([
          store.transaction(
            fence,
            (tx) => tx.write('settings', 'network', {
              'version': 1,
              'offline': value,
            }),
          ),
          if (value) Future.sync(() => onOffline(fence)),
        ]);
        await authority.assertCurrent(fence);
        if (!_current) throw _stale;
        if (revision == _revision) {
          _offline = value;
          _busy = false;
          _notify();
        }
      } catch (error) {
        final failure = !_current ? _stale : _storageFailure;
        if (_current && revision == _revision) {
          _offline = true;
          _busy = false;
          _failure = failure;
          _notify();
        }
        throw failure;
      }
    });
    _tail = result.then<void>((_) {}, onError: (Object _) {});
    // Reserve durable ordering before synchronous listeners can issue another
    // command. Otherwise nested callbacks enqueue ahead of this older intent.
    _notify();
    return result;
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  static const _storageFailure = AppFailure(
    code: 'network_preference_unavailable',
    message:
        'Не удалось сохранить режим подключения. Сеть остаётся отключённой.',
    retryable: true,
  );
  static const _stale = AppFailure(
    code: 'stale_session',
    message: 'Сеанс завершён.',
  );

  /// Owner composition awaits this before admitting jobs for a replacement
  /// scope. Native WorkManager cancellation acknowledgment alone is not a
  /// physical worker drain; this waits this policy's own callbacks and writes.
  Future<void> close() {
    if (!_disposed) dispose();
    return _tail;
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _revision++;
    _session.cancel();
    super.dispose();
  }
}
