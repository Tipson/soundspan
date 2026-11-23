import 'dart:async';

import '../model/app_failure.dart';
import '../model/owner_key.dart';
import '../network/refresh_coordinator.dart';
import 'credential_vault.dart';
import 'persisted_session_store.dart';
import 'session_authority.dart';

/// Multiple independent storage operations failed during logout. Single failures
/// retain their original error and stack; this preserves every cause otherwise.
/// The summary deliberately excludes platform error text and credential data.
final class SessionInvalidationFailure implements Exception {
  SessionInvalidationFailure({
    required this.revocationError,
    required List<Object> credentialDeletionErrors,
  }) : credentialDeletionErrors = List.unmodifiable(credentialDeletionErrors);

  final Object? revocationError;
  final List<Object> credentialDeletionErrors;

  @override
  String toString() => 'Session invalidation storage operations failed';
}

/// The sole credential owner/writer. Android constructs this only in the broker
/// engine; UI, audio and worker engines use a native SessionAuthority proxy.
final class LocalSessionAuthority implements SessionAuthority {
  LocalSessionAuthority({
    required this.vault,
    required this.fenceStore,
    required this.refreshTokens,
  }) {
    _refresh = RefreshCoordinator(
      currentStamp: _stamp,
      performRefresh: _performRefresh,
    );
  }

  final CredentialVault vault;
  final PersistedSessionStore fenceStore;
  final Future<TokenPair> Function(Uri origin, String refreshToken)
  refreshTokens;
  late final RefreshCoordinator _refresh;
  final _events = StreamController<SessionState>.broadcast(sync: true);
  final Set<OwnerKey> _knownOwners = {};
  StoredCredentials? _credentials;
  SessionState _state = const SessionState.signedOut();
  int _generation = 0;
  Future<void> _vaultTail = Future<void>.value();
  Future<void> _fenceTail = Future<void>.value();
  Future<void> _barrier = Future<void>.value();

  @override
  SessionState get state => _state;
  @override
  Stream<SessionState> get changes => _events.stream;
  @override
  SessionFence requireFence() => _state.fence ?? (throw _stale);
  @override
  bool isCurrent(SessionFence fence) =>
      _credentials?.fence == fence && _state.fence == fence;

  static const _stale = AppFailure(
    code: 'session_revoked',
    message: 'Сессия завершена',
  );

  void _publish(SessionState value) {
    _state = value;
    _events.add(value);
  }

  void _checkGeneration(int generation) {
    if (generation != _generation) throw _stale;
  }

  Future<T> _vaultOperation<T>(Future<T> Function() operation) {
    final result = _vaultTail.then((_) => operation());
    _vaultTail = result.then<void>(
      (_) {},
      onError: (Object _, StackTrace _) {},
    );
    return result;
  }

  Future<T> _fenceOperation<T>(Future<T> Function() operation) {
    final result = _fenceTail.then((_) => operation());
    _fenceTail = result.then<void>(
      (_) {},
      onError: (Object _, StackTrace _) {},
    );
    return result;
  }

  /// Invalidates synchronous admission before any storage/network await. Durable
  /// revocation has its own queue, so a stalled vault write cannot delay it.
  @override
  Future<void> invalidate() {
    _generation++;
    _credentials = null;
    _publish(const SessionState.signedOut());
    final owners = Set<OwnerKey>.of(_knownOwners);
    ({Object error, StackTrace stack})? revocationFailure;
    final revoke =
        _fenceOperation(() async {
          final previous = await fenceStore.read();
          if (previous.owner != null) owners.add(previous.owner!);
          await fenceStore.advance(null);
        }).then<void>(
          (_) {},
          // Observe immediately, even while an older write blocks the vault queue.
          // The removal barrier below reports this failure after attempting cleanup.
          onError: (Object error, StackTrace stack) {
            revocationFailure = (error: error, stack: stack);
          },
        );
    final remove = _vaultOperation(() async {
      await revoke;
      final deletionFailures = <({Object error, StackTrace stack})>[];
      for (final owner in owners) {
        try {
          await vault.delete(owner);
        } catch (error, stack) {
          deletionFailures.add((error: error, stack: stack));
        }
      }
      final revoked = revocationFailure;
      if (deletionFailures.length + (revoked == null ? 0 : 1) > 1) {
        throw SessionInvalidationFailure(
          revocationError: revoked?.error,
          credentialDeletionErrors: [
            for (final failure in deletionFailures) failure.error,
          ],
        );
      }
      final failure = revoked ?? deletionFailures.firstOrNull;
      if (failure != null) {
        Error.throwWithStackTrace(failure.error, failure.stack);
      }
    });
    // Queued before any later login can write, so this cleanup cannot delete a
    // newer credential, even if revocation or an older vault write has failed.
    _barrier = remove;
    return _barrier;
  }

  /// Reserves one login attempt before sending a password. A late login response
  /// may commit only against this ticket; another login/logout revokes it.
  Future<int> beginAuthentication() {
    final barrier = invalidate();
    final generation = _generation;
    return barrier.then((_) {
      _checkGeneration(generation);
      return generation;
    });
  }

  /// Fences password submission and 2FA results as well as token persistence.
  void assertAuthenticationCurrent(int generation) =>
      _checkGeneration(generation);

  Future<SessionState> establish(
    OwnerKey owner,
    TokenPair tokens, {
    int? expectedGeneration,
  }) async {
    tokens.validate();
    final generation = expectedGeneration ?? await beginAuthentication();
    _checkGeneration(generation);
    await _barrier;
    _checkGeneration(generation);
    _knownOwners.add(owner);
    final persisted = await _fenceOperation(() async {
      _checkGeneration(generation);
      return fenceStore.advance(owner);
    });
    _checkGeneration(generation);
    if (persisted.owner != owner || persisted.tombstone) throw _stale;
    final stored = StoredCredentials(
      fence: SessionFence(owner: owner, epoch: persisted.epoch),
      tokenRevision: 1,
      tokens: tokens,
    );
    await _writeGuarded(stored, generation);
    _checkGeneration(generation);
    _credentials = stored;
    _publish(
      SessionState(
        status: SessionStatus.authenticated,
        fence: stored.fence,
        tokenRevision: 1,
      ),
    );
    return state;
  }

  /// No HTTP or JWT expiry gate: the private offline namespace is validated by
  /// the secure record and durable fence, not by access-token freshness.
  Future<SessionState> restore(Uri origin) async {
    var generation = ++_generation;
    _credentials = null;
    _publish(const SessionState.signedOut());
    await _barrier;
    _checkGeneration(generation);
    final previous = await _fenceOperation(() async {
      _checkGeneration(generation);
      final persisted = await fenceStore.read();
      _checkGeneration(generation);
      return persisted;
    });
    _checkGeneration(generation);
    // A cold broker has no in-memory credentials. The persisted owner is the
    // authority for server switching, including an older pending restore.
    // Check generation after the read before revoking: a late result must not
    // invalidate a newer login/logout. The normal barrier also deletes A's
    // credentials before this operation may attempt to restore B.
    if (previous.owner != null && previous.owner!.serverOrigin != origin) {
      final barrier = invalidate();
      generation = _generation;
      await barrier;
      _checkGeneration(generation);
    }
    final stored = await _vaultOperation(() => vault.read(origin));
    final persisted = await _fenceOperation(() => fenceStore.read());
    _checkGeneration(generation);
    if (stored == null ||
        !persisted.admits(stored.fence) ||
        stored.tokenRevision < 1 ||
        stored.fence.owner.serverOrigin != origin) {
      return state;
    }
    stored.tokens.validate();
    _knownOwners.add(stored.fence.owner);
    _credentials = stored;
    _publish(
      SessionState(
        status: SessionStatus.offlineValidated,
        fence: stored.fence,
        tokenRevision: stored.tokenRevision,
      ),
    );
    return state;
  }

  /// Hydrates a cold broker for an existing job, without creating user intent.
  /// Unlike UI restore, a rejected captured fence never changes generation,
  /// public state, durable epoch or credentials. Any newer UI intent wins.
  Future<SessionState> restoreCapturedFence(SessionFence captured) async {
    final generation = _generation;
    // Only an untouched cold authority may hydrate. A pending/failed UI action
    // must not be followed by an implicit worker-driven session resurrection.
    if (generation != 0 || _credentials != null) {
      await assertCurrent(captured);
      return state;
    }
    await _barrier;
    _checkGeneration(generation);
    final before = await _fenceOperation(() async {
      _checkGeneration(generation);
      return fenceStore.read();
    });
    _checkGeneration(generation);
    if (!before.admits(captured)) throw _stale;

    final stored = await _vaultOperation(() async {
      _checkGeneration(generation);
      return vault.read(captured.owner.serverOrigin);
    });
    _checkGeneration(generation);
    final after = await _fenceOperation(() async {
      _checkGeneration(generation);
      return fenceStore.read();
    });
    _checkGeneration(generation);
    if (!after.admits(captured) ||
        stored == null ||
        stored.fence != captured ||
        stored.tokenRevision < 1) {
      throw _stale;
    }
    stored.tokens.validate();
    // A concurrent accepted cold attach/refresh may already have published a
    // newer credential revision while this read was pending. Never downgrade it.
    if (_credentials != null) {
      if (!isCurrent(captured)) throw _stale;
      return state;
    }
    _knownOwners.add(captured.owner);
    _credentials = stored;
    _publish(
      SessionState(
        status: SessionStatus.offlineValidated,
        fence: captured,
        tokenRevision: stored.tokenRevision,
      ),
    );
    return state;
  }

  @override
  Future<void> assertCurrent(SessionFence fence) async {
    if (!isCurrent(fence)) throw _stale;
    final persisted = await fenceStore.read();
    if (!persisted.admits(fence) || !isCurrent(fence)) throw _stale;
  }

  @override
  Future<AccessGrant> grantAccess(SessionFence fence, Uri exactOrigin) async {
    if (exactOrigin != fence.owner.serverOrigin) {
      throw const AppFailure(
        code: 'origin_mismatch',
        message: 'Недопустимый сервер',
      );
    }
    await assertCurrent(fence);
    final stored = _credentials!;
    return AccessGrant(
      authStamp: _stamp(fence),
      accessToken: stored.tokens.accessToken,
    );
  }

  AuthStamp _stamp(SessionFence fence) {
    if (!isCurrent(fence)) throw _stale;
    return AuthStamp(fence: fence, tokenRevision: _credentials!.tokenRevision);
  }

  @override
  Future<AuthStamp> after401(AuthStamp rejected) => _refresh.after401(rejected);

  Future<AuthStamp> _performRefresh(AuthStamp rejected) async {
    await assertCurrent(rejected.fence);
    final previous = _credentials!;
    if (rejected.tokenRevision < previous.tokenRevision) {
      return _stamp(rejected.fence);
    }
    if (rejected.tokenRevision != previous.tokenRevision) throw _stale;
    final generation = _generation;
    TokenPair tokens;
    try {
      tokens = await refreshTokens(
        rejected.fence.owner.serverOrigin,
        previous.tokens.refreshToken,
      );
    } on AppFailure catch (error) {
      if (error.statusCode == 401 &&
          isCurrent(rejected.fence) &&
          _credentials?.tokenRevision == rejected.tokenRevision) {
        await invalidate();
      }
      rethrow;
    }
    tokens.validate();
    _checkGeneration(generation);
    await assertCurrent(rejected.fence);
    final stored = StoredCredentials(
      fence: rejected.fence,
      tokenRevision: previous.tokenRevision + 1,
      tokens: tokens,
    );
    await _writeGuarded(stored, generation);
    _checkGeneration(generation);
    _credentials = stored;
    _publish(
      SessionState(
        status: SessionStatus.authenticated,
        fence: stored.fence,
        tokenRevision: stored.tokenRevision,
      ),
    );
    return _stamp(stored.fence);
  }

  Future<void> _writeGuarded(StoredCredentials stored, int generation) async {
    try {
      await _vaultOperation(() async {
        _checkGeneration(generation);
        await vault.write(stored);
        if (generation != _generation) {
          await vault.delete(stored.fence.owner);
          throw _stale;
        }
      });
    } catch (error) {
      // A platform write may have persisted before its result failed. Revoke
      // the durable row before reporting failure so cold restore cannot accept
      // such an uncertain commit. Never revoke a newer generation here.
      if (generation == _generation) await invalidate();
      if (error is AppFailure) rethrow;
      throw const AppFailure(
        code: 'credential_storage_unavailable',
        message: 'Не удалось сохранить сессию',
      );
    }
  }
}
