import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/session/credential_vault.dart';
import 'package:soundspan/core/session/local_session_authority.dart';
import 'package:soundspan/core/session/session_authority.dart';

import '../support/auth_fakes.dart';

void main() {
  test(
    'logout during refresh write blocks relogin until delete wins',
    () async {
      final vault = MemoryVault();
      final store = MemoryFenceStore();
      final authority = LocalSessionAuthority(
        vault: vault,
        fenceStore: store,
        refreshTokens: (_, _) async => const TokenPair(
          accessToken: 'rotated-a',
          refreshToken: 'rotated-r',
        ),
      );
      await authority.establish(
        owner,
        const TokenPair(accessToken: 'a', refreshToken: 'r'),
      );
      final oldFence = authority.requireFence();
      final stamp = (await authority.grantAccess(oldFence, origin)).authStamp;
      vault.writeGate = Completer<void>();
      vault.writeStarted = Completer<void>();
      final refreshing = authority.after401(stamp);
      final failed = expectLater(refreshing, throwsA(isA<AppFailure>()));
      await vault.writeStarted!.future;
      final logout = authority.invalidate();
      var relogged = false;
      final relogin = authority
          .establish(
            owner,
            const TokenPair(accessToken: 'new-a', refreshToken: 'new-r'),
          )
          .then((_) {
            relogged = true;
          });
      await Future<void>.delayed(Duration.zero);
      expect(store.value.tombstone, isTrue);
      expect(relogged, isFalse);
      vault.writeStarted = null;
      vault.writeGate!.complete();
      await failed;
      await logout;
      await relogin;
      expect(vault.value!.tokens.refreshToken, 'new-r');
      expect(vault.value!.fence.epoch, greaterThan(oldFence.epoch));
      await expectLater(
        authority.grantAccess(oldFence, origin),
        throwsA(isA<AppFailure>()),
      );
    },
  );

  test(
    'current revision refresh 401 revokes admission and persisted credentials',
    () async {
      final vault = MemoryVault();
      final store = MemoryFenceStore();
      final authority = LocalSessionAuthority(
        vault: vault,
        fenceStore: store,
        refreshTokens: (_, _) async => throw const AppFailure(
          code: 'unauthorized',
          message: 'expired',
          statusCode: 401,
        ),
      );
      await authority.establish(
        owner,
        const TokenPair(accessToken: 'a', refreshToken: 'r'),
      );
      final stamp = (await authority.grantAccess(
        authority.requireFence(),
        origin,
      )).authStamp;
      await expectLater(authority.after401(stamp), throwsA(isA<AppFailure>()));
      expect(authority.state.status, SessionStatus.signedOut);
      expect(store.value.tombstone, isTrue);
      expect(vault.value, isNull);
    },
  );

  test('ten same revision 401s share refresh and a late old 401 reuses the saved pair', () async {
    final vault = MemoryVault();
    final gate = Completer<TokenPair>();
    var calls = 0;
    final authority = LocalSessionAuthority(
      vault: vault,
      fenceStore: MemoryFenceStore(),
      refreshTokens: (_, refresh) {
        expect(refresh, 'r1');
        calls++;
        return gate.future;
      },
    );
    await authority.establish(
      owner,
      const TokenPair(accessToken: 'a1', refreshToken: 'r1'),
    );
    final stamp = (await authority.grantAccess(
      authority.requireFence(),
      origin,
    )).authStamp;
    final requests = List.generate(10, (_) => authority.after401(stamp));
    await Future<void>.delayed(Duration.zero);
    expect(calls, 1);
    gate.complete(const TokenPair(accessToken: 'a2', refreshToken: 'r2'));
    final results = await Future.wait(requests);
    expect(results.every((r) => r.tokenRevision == 2), isTrue);
    expect(vault.writes, 2);
    expect(vault.value!.tokens.refreshToken, 'r2');
    expect((await authority.after401(stamp)).tokenRevision, 2);
    expect(calls, 1);
  });

  test('refresh grant waits for secure-store commit', () async {
    final vault = MemoryVault();
    final authority = LocalSessionAuthority(
      vault: vault,
      fenceStore: MemoryFenceStore(),
      refreshTokens: (_, _) async =>
          const TokenPair(accessToken: 'a2', refreshToken: 'r2'),
    );
    await authority.establish(
      owner,
      const TokenPair(accessToken: 'a1', refreshToken: 'r1'),
    );
    final stamp = (await authority.grantAccess(
      authority.requireFence(),
      origin,
    )).authStamp;
    vault.writeGate = Completer<void>();
    vault.writeStarted = Completer<void>();
    var completed = false;
    final refreshing = authority.after401(stamp).then((v) {
      completed = true;
      return v;
    });
    await vault.writeStarted!.future;
    expect(completed, isFalse);
    vault.writeGate!.complete();
    await refreshing;
    expect(vault.value!.tokenRevision, 2);
  });

  for (final status in [429, 503]) {
    test('refresh $status is transient and preserves credentials', () async {
      final vault = MemoryVault();
      final authority = LocalSessionAuthority(
        vault: vault,
        fenceStore: MemoryFenceStore(),
        refreshTokens: (_, _) async => throw AppFailure(
          code: 'http_error',
          message: 'retry',
          statusCode: status,
          retryable: true,
        ),
      );
      await authority.establish(
        owner,
        const TokenPair(accessToken: 'a', refreshToken: 'r'),
      );
      final stamp = (await authority.grantAccess(
        authority.requireFence(),
        origin,
      )).authStamp;
      await expectLater(authority.after401(stamp), throwsA(isA<AppFailure>()));
      expect(authority.state.status, SessionStatus.authenticated);
      expect(vault.value!.tokens.refreshToken, 'r');
    });
  }

  for (final lateError in [false, true]) {
    test(
      'late refresh ${lateError ? '401' : 'success'} cannot revive or delete a newer login',
      () async {
        final gate = Completer<TokenPair>();
        final started = Completer<void>();
        final vault = MemoryVault();
        final authority = LocalSessionAuthority(
          vault: vault,
          fenceStore: MemoryFenceStore(),
          refreshTokens: (_, _) {
            started.complete();
            return gate.future;
          },
        );
        await authority.establish(
          owner,
          const TokenPair(accessToken: 'a1', refreshToken: 'r1'),
        );
        final stamp = (await authority.grantAccess(
          authority.requireFence(),
          origin,
        )).authStamp;
        final pending = authority.after401(stamp);
        final failed = expectLater(pending, throwsA(isA<AppFailure>()));
        await started.future;
        await authority.invalidate();
        await authority.establish(
          owner,
          const TokenPair(accessToken: 'new-a', refreshToken: 'new-r'),
        );
        if (lateError) {
          gate.completeError(
            const AppFailure(
              code: 'unauthorized',
              message: 'expired',
              statusCode: 401,
            ),
          );
        } else {
          gate.complete(
            const TokenPair(accessToken: 'late-a', refreshToken: 'late-r'),
          );
        }
        await failed;
        expect(vault.value!.tokens.refreshToken, 'new-r');
        expect(authority.state.status, SessionStatus.authenticated);
      },
    );
  }
}
