import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/session/credential_vault.dart';
import 'package:soundspan/core/session/local_session_authority.dart';
import 'package:soundspan/core/session/persisted_session_store.dart';
import 'package:soundspan/core/session/session_authority.dart';

import '../support/auth_fakes.dart';

final class FaultStore implements PersistedSessionStore {
  final backing = MemoryFenceStore();
  Object? nextReadFailure;
  Object? nextRevokeFailure;
  int revokeAttempts = 0;

  @override
  Future<PersistedSession> read() async {
    final failure = nextReadFailure;
    nextReadFailure = null;
    if (failure != null) throw failure;
    return backing.read();
  }

  @override
  Future<PersistedSession> advance(OwnerKey? value) async {
    if (value == null) {
      revokeAttempts++;
      final failure = nextRevokeFailure;
      nextRevokeFailure = null;
      if (failure != null) throw failure;
    }
    return backing.advance(value);
  }
}

final class FaultVault implements CredentialVault {
  final backing = MemoryVault();
  final deleted = <OwnerKey>[];
  final deleteFailures = <OwnerKey, Object>{};
  Completer<void>? deleteGate;
  Completer<void>? deleteStarted;

  @override
  Future<StoredCredentials?> read(Uri origin) => backing.read(origin);
  @override
  Future<void> write(StoredCredentials value) => backing.write(value);
  @override
  Future<void> delete(OwnerKey owner) async {
    deleted.add(owner);
    final gate = deleteGate;
    deleteGate = null;
    deleteStarted?.complete();
    deleteStarted = null;
    await gate?.future;
    final failure = deleteFailures[owner];
    if (failure != null) throw failure;
    await backing.delete(owner);
  }
}

void main() {
  const tokens = TokenPair(accessToken: 'fixture-a', refreshToken: 'fixture-r');
  final other = OwnerKey(serverOrigin: origin, userId: 'bob');
  late FaultStore store;
  late FaultVault vault;
  late LocalSessionAuthority authority;
  LocalSessionAuthority create() => LocalSessionAuthority(
    vault: vault,
    fenceStore: store,
    refreshTokens: (_, _) async => tokens,
  );
  setUp(() {
    store = FaultStore();
    vault = FaultVault();
    authority = create();
  });
  void failRevoke(String step, Object error) {
    if (step == 'read') {
      store.nextReadFailure = error;
    } else {
      store.nextRevokeFailure = error;
    }
  }

  for (final step in ['read', 'advance']) {
    test('logout $step failure still deletes known credentials', () async {
      await authority.establish(owner, tokens);
      final original = authority.requireFence();
      final failure = StateError('injected $step');
      failRevoke(step, failure);
      await expectLater(authority.invalidate(), throwsA(same(failure)));
      expect(authority.state.status, SessionStatus.signedOut);
      expect(store.backing.value.admits(original), isTrue);
      expect(vault.deleted, contains(owner));
      expect(vault.backing.value, isNull);
      expect((await create().restore(origin)).status, SessionStatus.signedOut);
    });

    test('logout reports both $step and credential deletion failures', () async {
      await authority.establish(owner, tokens);
      final failure = StateError('injected $step');
      final deleteFailure = StateError('injected delete');
      failRevoke(step, failure);
      vault.deleteFailures[owner] = deleteFailure;
      Object? caught;
      try {
        await authority.invalidate();
      } catch (error) {
        caught = error;
      }
      expect(vault.deleted, contains(owner));
      expect(caught, isA<SessionInvalidationFailure>());
      // Both causes must remain inspectable without logging credential content.
      final combined = caught! as SessionInvalidationFailure;
      expect(combined.revocationError, same(failure));
      expect(combined.credentialDeletionErrors, [same(deleteFailure)]);
      expect(authority.state.status, SessionStatus.signedOut);
    });
  }

  test(
    'durable revoke blocks cold restore when credential deletion fails',
    () async {
      await authority.establish(owner, tokens);
      final original = authority.requireFence();
      final failure = StateError('injected delete');
      vault.deleteFailures[owner] = failure;
      await expectLater(authority.invalidate(), throwsA(same(failure)));
      expect(store.backing.value.admits(original), isFalse);
      expect(store.backing.value.tombstone, isTrue);
      expect(vault.backing.value, isNotNull);
      expect((await create().restore(origin)).status, SessionStatus.signedOut);
    },
  );

  test(
    'one owner deletion failure does not skip remaining known owners',
    () async {
      await authority.establish(owner, tokens);
      await authority.establish(other, tokens);
      vault.deleted.clear();
      final failure = StateError('injected first owner delete');
      vault.deleteFailures[owner] = failure;
      await expectLater(authority.invalidate(), throwsA(same(failure)));
      expect(vault.deleted, [owner, other]);
      expect(vault.backing.value, isNull);
    },
  );

  for (final pendingKind in ['login', 'refresh']) {
    test(
      'failed logout waits late $pendingKind write before newer login',
      () async {
        Future<Object?> pending;
        AuthStamp? stamp;
        if (pendingKind == 'refresh') {
          await authority.establish(owner, tokens);
          stamp = (await authority.grantAccess(
            authority.requireFence(),
            origin,
          )).authStamp;
        }
        final writeGate = Completer<void>();
        final writeStarted = Completer<void>();
        vault.backing.writeGate = writeGate;
        vault.backing.writeStarted = writeStarted;
        pending = pendingKind == 'login'
            ? authority.establish(owner, tokens)
            : authority.after401(stamp!);
        final stale = expectLater(pending, throwsA(isA<AppFailure>()));
        await writeStarted.future;
        final failure = StateError('injected revoke');
        store.nextRevokeFailure = failure;
        final logout = expectLater(
          authority.invalidate(),
          throwsA(same(failure)),
        );
        final newer = authority.establish(other, tokens);
        vault.backing.writeStarted = null;
        vault.backing.writeGate = null;
        writeGate.complete();
        await stale;
        await logout;
        await newer;
        expect(authority.requireFence().owner, other);
        expect(vault.backing.value!.fence, authority.requireFence());
        expect(store.backing.value.admits(authority.requireFence()), isTrue);
      },
    );
  }

  for (final sameOwner in [false, true]) {
    test(
      'failed revoke deletion barrier precedes newer login sameOwner=$sameOwner',
      () async {
        await authority.establish(owner, tokens);
        final gate = Completer<void>();
        final started = Completer<void>();
        vault.deleteGate = gate;
        vault.deleteStarted = started;
        final failure = StateError('injected revoke');
        store.nextRevokeFailure = failure;
        final logout = expectLater(
          authority.invalidate(),
          throwsA(same(failure)),
        );
        await started.future.timeout(const Duration(seconds: 2));
        final newerOwner = sameOwner ? owner : other;
        final newer = authority.establish(newerOwner, tokens);
        expect(authority.state.status, SessionStatus.signedOut);
        gate.complete();
        await logout;
        await newer;
        expect(vault.backing.value!.fence, authority.requireFence());
        expect(authority.requireFence().owner, newerOwner);
      },
    );
  }
}
