import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/session/credential_vault.dart';
import 'package:soundspan/core/session/local_session_authority.dart';
import 'package:soundspan/core/session/persisted_session_store.dart';
import 'package:soundspan/core/session/session_authority.dart';

import '../support/auth_fakes.dart';

void main() {
  late MemoryVault vault;
  late MemoryFenceStore store;
  late LocalSessionAuthority authority;
  setUp(() {
    vault = MemoryVault();
    store = MemoryFenceStore();
    authority = LocalSessionAuthority(
      vault: vault,
      fenceStore: store,
      refreshTokens: (_, _) async =>
          const TokenPair(accessToken: 'a2', refreshToken: 'r2'),
    );
  });

  void seedPersistedOwner() {
    store.value = PersistedSession(epoch: 1, tombstone: false, owner: owner);
    vault.value = StoredCredentials(
      fence: SessionFence(owner: owner, epoch: 1),
      tokenRevision: 1,
      tokens: const TokenPair(accessToken: 'a1', refreshToken: 'r1'),
    );
  }

  test(
    'cold restore of another server durably revokes the previous owner',
    () async {
      seedPersistedOwner();
      final old = vault.value!.fence;
      expect(
        (await authority.restore(Uri.parse('https://other.example'))).status,
        SessionStatus.signedOut,
      );
      expect(store.value.admits(old), isFalse);
      expect(store.value.tombstone, isTrue);
      expect(vault.value, isNull);
      expect((await authority.restore(origin)).status, SessionStatus.signedOut);
      expect(store.value.admits(old), isFalse);
    },
  );

  test(
    'pending A restore cannot republish A after a B restore revokes it',
    () async {
      seedPersistedOwner();
      final old = vault.value!.fence;
      final gate = Completer<void>();
      final started = Completer<void>();
      vault.readGate = gate;
      vault.readStarted = started;
      final restoreA = authority.restore(origin);
      final rejectedA = expectLater(restoreA, throwsA(isA<AppFailure>()));
      await started.future;
      final restoreB = authority.restore(Uri.parse('https://other.example'));
      await Future<void>.delayed(Duration.zero);
      expect(store.value.admits(old), isFalse);
      gate.complete();
      await rejectedA;
      expect((await restoreB).status, SessionStatus.signedOut);
      expect(vault.value, isNull);
    },
  );

  test('late durable read from restore cannot revoke a newer login', () async {
    seedPersistedOwner();
    final gate = Completer<void>();
    final started = Completer<void>();
    store.readGate = gate;
    store.readStarted = started;
    final restoreB = authority.restore(Uri.parse('https://other.example'));
    final rejectedB = expectLater(restoreB, throwsA(isA<AppFailure>()));
    await started.future;
    final login = authority.establish(
      owner,
      const TokenPair(accessToken: 'new-a', refreshToken: 'new-r'),
    );
    gate.complete();
    await rejectedB;
    await login;
    expect(authority.state.status, SessionStatus.authenticated);
    expect(store.value.admits(authority.requireFence()), isTrue);
    expect(vault.value!.tokens.refreshToken, 'new-r');
  });

  test('late durable read from restore cannot undo a newer logout', () async {
    seedPersistedOwner();
    final gate = Completer<void>();
    final started = Completer<void>();
    store.readGate = gate;
    store.readStarted = started;
    final restoreB = authority.restore(Uri.parse('https://other.example'));
    final rejectedB = expectLater(restoreB, throwsA(isA<AppFailure>()));
    await started.future;
    final logout = authority.invalidate();
    gate.complete();
    await rejectedB;
    await logout;
    expect(authority.state.status, SessionStatus.signedOut);
    expect(store.value.tombstone, isTrue);
    expect(vault.value, isNull);
  });

  test(
    'uncertain secure write failure is tombstoned before reporting failure',
    () async {
      vault.failAfterWrite = true;
      await expectLater(
        authority.establish(
          owner,
          const TokenPair(accessToken: 'a', refreshToken: 'r'),
        ),
        throwsA(anything),
      );
      expect(store.value.tombstone, isTrue);
      expect(vault.value, isNull);
      expect(authority.state.status, SessionStatus.signedOut);
    },
  );

  test(
    'logout closes admission immediately and delete wins an in-flight write',
    () async {
      vault.writeGate = Completer<void>();
      vault.writeStarted = Completer<void>();
      final pending = authority.establish(
        owner,
        const TokenPair(accessToken: 'a', refreshToken: 'r'),
      );
      final failure = expectLater(pending, throwsA(isA<AppFailure>()));
      await vault.writeStarted!.future;
      final logout = authority.invalidate();
      expect(authority.state.status, SessionStatus.signedOut);
      await Future<void>.delayed(Duration.zero);
      expect(store.value.tombstone, isTrue);
      vault.writeGate!.complete();
      await failure;
      await logout;
      expect(vault.value, isNull);
      expect((await authority.restore(origin)).status, SessionStatus.signedOut);
    },
  );

  test('same-owner relogin and server switch reject previous epoch', () async {
    await authority.establish(
      owner,
      const TokenPair(accessToken: 'a', refreshToken: 'r'),
    );
    final old = authority.requireFence();
    await authority.invalidate();
    await authority.establish(
      owner,
      const TokenPair(accessToken: 'b', refreshToken: 's'),
    );
    expect(authority.requireFence().epoch, greaterThan(old.epoch));
    await expectLater(
      authority.grantAccess(old, origin),
      throwsA(isA<AppFailure>()),
    );
    final current = authority.requireFence();
    final other = OwnerKey(
      serverOrigin: Uri.parse('https://other.example'),
      userId: 'alice',
    );
    await authority.establish(
      other,
      const TokenPair(accessToken: 'c', refreshToken: 't'),
    );
    await expectLater(
      authority.assertCurrent(current),
      throwsA(isA<AppFailure>()),
    );
    expect(vault.value!.fence.owner, other);
  });

  test('cold restore trusts matching persisted fence even with expired access token', () async {
    await authority.establish(
      owner,
      const TokenPair(accessToken: 'expired.jwt', refreshToken: 'r'),
    );
    final restored = LocalSessionAuthority(
      vault: vault,
      fenceStore: store,
      refreshTokens: (_, _) => throw StateError('offline cannot refresh'),
    );
    expect(
      (await restored.restore(origin)).status,
      SessionStatus.offlineValidated,
    );
    await store.advance(
      null,
    ); // crash after durable revoke, before vault deletion
    final crashed = LocalSessionAuthority(
      vault: vault,
      fenceStore: store,
      refreshTokens: (_, _) => throw StateError('offline cannot refresh'),
    );
    expect((await crashed.restore(origin)).status, SessionStatus.signedOut);
  });

  test('access grants reject foreign origin and public state contains no credentials', () async {
    await authority.establish(
      owner,
      const TokenPair(accessToken: 'secret-a', refreshToken: 'secret-r'),
    );
    await expectLater(
      authority.grantAccess(
        authority.requireFence(),
        Uri.parse('https://music.example:444'),
      ),
      throwsA(isA<AppFailure>()),
    );
    expect(authority.state.toString(), isNot(contains('secret')));
    expect(
      (await authority.grantAccess(
        authority.requireFence(),
        origin,
      )).toString(),
      isNot(contains('secret')),
    );
  });
}
