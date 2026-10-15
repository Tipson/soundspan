import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/session/broker_client.dart';
import 'package:soundspan/core/session/session_broker_protocol.dart';
import 'package:soundspan/core/session/session_broker_rpc_server.dart';
import 'package:soundspan/core/session/native_session_authority_proxy.dart';
import 'package:soundspan/core/session/native_auth_repository_proxy.dart';
import 'package:soundspan/core/session/local_session_authority.dart';
import 'package:soundspan/core/session/auth_repository.dart';
import 'package:soundspan/core/session/credential_vault.dart';
import 'package:soundspan/core/session/session_authority.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/network/api_transport.dart';

import '../support/auth_fakes.dart';

final class Loopback implements BrokerTransport {
  Loopback(this.server, this.id);
  final SessionBrokerRpcServer server;
  final String id;
  final injected = StreamController<Object?>.broadcast(sync: true);
  @override
  Stream<Object?> get events => injected.stream;
  @override
  Future<Object?> invoke(Map<String, Object?> request) =>
      server.dispatch(id, request);
  @override
  Future<void> close() async {}
}

void main() {
  for (final sameOwner in [false, true]) {
    test(
      'cold stale worker preserves durable credentials (sameOwner=$sameOwner) and valid worker can follow',
      () async {
        final vault = MemoryVault();
        final store = MemoryFenceStore();
        LocalSessionAuthority create() => LocalSessionAuthority(
          vault: vault,
          fenceStore: store,
          refreshTokens: (_, _) async => throw StateError('no network'),
        );
        final live = create();
        await live.establish(
          owner,
          const TokenPair(accessToken: 'old', refreshToken: 'old-r'),
        );
        final old = live.requireFence();
        final currentOwner = sameOwner
            ? owner
            : OwnerKey(
                serverOrigin: Uri.parse('https://b.example'),
                userId: 'bob',
              );
        await live.establish(
          currentOwner,
          const TokenPair(accessToken: 'current', refreshToken: 'current-r'),
        );
        final current = live.requireFence();
        final persisted = store.value;
        final stored = vault.value;
        final writes = vault.writes;
        final cold = create();
        final server = SessionBrokerRpcServer(
          restoreCapturedFence: cold.restoreCapturedFence,
          authority: cold,
          auth: LocalAuthRepository(
            authority: cold,
            client: ScriptedJsonClient(
              (_, _) async => throw StateError('no network'),
            ),
          ),
        );
        final events = <Map<String, Object?>>[];
        final subscription = server.events.listen(events.add);
        final stale = await server.dispatch('old-worker', {
          'v': 1,
          'method': 'attach',
          'args': {
            'role': 'download',
            'expectedFence': BrokerCodec.encodeFence(old),
          },
        });
        expect(stale['ok'], isFalse);
        expect((stale['error'] as Map)['code'], 'session_revoked');
        expect(store.value, same(persisted));
        expect(vault.value, same(stored));
        expect(vault.writes, writes);
        expect(cold.state.status, SessionStatus.signedOut);
        expect(events, isEmpty);
        final valid = await server.dispatch('current-worker', {
          'v': 1,
          'method': 'attach',
          'args': {
            'role': 'download',
            'expectedFence': BrokerCodec.encodeFence(current),
          },
        });
        expect(valid['ok'], isTrue);
        expect(cold.requireFence(), current);
        expect(store.value, same(persisted));
        expect(vault.value, same(stored));
        await subscription.cancel();
        await server.close();
      },
    );
  }

  for (final stage in ['firstFence', 'vault', 'lastFence']) {
    for (final intent in ['login', 'logout']) {
      test(
        'pending cold worker $stage read cannot override newer UI $intent',
        () async {
          final vault = MemoryVault();
          final store = MemoryFenceStore();
          LocalSessionAuthority create() => LocalSessionAuthority(
            vault: vault,
            fenceStore: store,
            refreshTokens: (_, _) async => throw StateError('no refresh'),
          );
          final previous = create();
          await previous.establish(
            owner,
            const TokenPair(accessToken: 'old', refreshToken: 'old-r'),
          );
          final captured = previous.requireFence();
          final cold = create();
          final client = ScriptedJsonClient(
            (request, _) async => switch (request.path) {
              '/api/auth/config' => const ApiResponse(200, {
                'localLoginEnabled': true,
                'oidcEnabled': false,
                'oidcProviderName': '',
              }),
              '/api/auth/login' => const ApiResponse(200, {
                'token': 'b-token',
                'refreshToken': 'b-refresh',
                'user': {'id': 'bob'},
              }),
              _ => throw StateError('unexpected request'),
            },
          );
          final server = SessionBrokerRpcServer(
            restoreCapturedFence: cold.restoreCapturedFence,
            authority: cold,
            auth: LocalAuthRepository(authority: cold, client: client),
          );
          await server.dispatch('ui', {
            'v': 1,
            'method': 'attach',
            'args': {'role': 'ui', 'expectedFence': null},
          });
          final gate = Completer<void>();
          final started = Completer<void>();
          if (stage == 'firstFence') {
            store.readGate = gate;
            store.readStarted = started;
          } else {
            vault.readGate = gate;
            vault.readStarted = started;
          }
          final pending = server.dispatch('worker', {
            'v': 1,
            'method': 'attach',
            'args': {
              'role': 'download',
              'expectedFence': BrokerCodec.encodeFence(captured),
            },
          });
          await started.future;
          var release = gate;
          if (stage == 'lastFence') {
            release = Completer<void>();
            final lastStarted = Completer<void>();
            store.readGate = release;
            store.readStarted = lastStarted;
            gate.complete();
            await lastStarted.future;
          }
          final userAction = server.dispatch('ui', {
            'v': 1,
            'method': intent,
            'args': intent == 'login'
                ? {
                    'origin': 'https://b.example',
                    'username': 'bob',
                    'password': 'fixture',
                    'token': null,
                  }
                : <String, Object?>{},
          });
          release.complete();
          expect((await pending)['ok'], isFalse);
          expect((await userAction)['ok'], isTrue);
          if (intent == 'login') {
            expect(
              cold.requireFence().owner.serverOrigin,
              Uri.parse('https://b.example'),
            );
            expect(store.value.admits(cold.requireFence()), isTrue);
            expect(vault.value!.tokens.refreshToken, 'b-refresh');
          } else {
            expect(cold.state.status, SessionStatus.signedOut);
            expect(store.value.tombstone, isTrue);
            expect(vault.value, isNull);
          }
          await server.close();
        },
      );
    }
  }

  test(
    'local logout hides an authenticated event queued before revocation',
    () async {
      final authority = LocalSessionAuthority(
        vault: MemoryVault(),
        fenceStore: MemoryFenceStore(),
        refreshTokens: (_, _) async =>
            const TokenPair(accessToken: 'a2', refreshToken: 'r2'),
      );
      await authority.establish(
        owner,
        const TokenPair(accessToken: 'a', refreshToken: 'r'),
      );
      final server = SessionBrokerRpcServer(
        restoreCapturedFence: authority.restoreCapturedFence,
        authority: authority,
        auth: LocalAuthRepository(
          authority: authority,
          client: ScriptedJsonClient(
            (_, _) async => throw StateError('unused'),
          ),
        ),
      );
      final wire = Loopback(server, 'ui');
      final proxy = await NativeSessionAuthorityProxy.attach(
        BrokerClient(wire),
        ClientRole.ui,
      );
      await authority.after401(
        (await authority.grantAccess(
          authority.requireFence(),
          origin,
        )).authStamp,
      );
      final queued = server.snapshot;
      final logout = proxy.invalidate();
      wire.injected.add(queued);
      expect(proxy.state.status, SessionStatus.signedOut);
      await logout;
      wire.injected.add(server.snapshot);
      expect(proxy.state.status, SessionStatus.signedOut);
      await proxy.close();
      await server.close();
    },
  );
  test('cold download restores only its original durable fence', () async {
    final vault = MemoryVault();
    final store = MemoryFenceStore();
    LocalSessionAuthority create() => LocalSessionAuthority(
      vault: vault,
      fenceStore: store,
      refreshTokens: (_, _) async => throw StateError('must stay offline'),
    );
    final previous = create();
    await previous.establish(
      owner,
      const TokenPair(accessToken: 'expired', refreshToken: 'refresh'),
    );
    final captured = previous.requireFence();
    final cold = create();
    final server = SessionBrokerRpcServer(
      restoreCapturedFence: cold.restoreCapturedFence,
      authority: cold,
      auth: LocalAuthRepository(
        authority: cold,
        client: ScriptedJsonClient(
          (_, _) async => throw StateError('must stay offline'),
        ),
      ),
    );
    final worker = await NativeSessionAuthorityProxy.attach(
      BrokerClient(Loopback(server, 'worker')),
      ClientRole.download,
      expectedFence: captured,
    );
    await worker.assertCurrent(captured);
    expect(worker.state.status, SessionStatus.offlineValidated);
    await cold.invalidate();
    await cold.establish(
      owner,
      const TokenPair(accessToken: 'fresh', refreshToken: 'refresh2'),
    );
    await expectLater(
      worker.assertCurrent(cold.requireFence()),
      throwsA(isA<AppFailure>()),
    );
    await worker.close();
    await server.close();
  });

  test(
    'strict codec rejects extra secrets, wrong version and malformed state',
    () {
      expect(
        () => BrokerCodec.event({
          'v': 1.0,
          'sequence': 0,
          'state': {'status': 'signedOut', 'fence': null, 'tokenRevision': 0},
        }),
        throwsA(isA<AppFailure>()),
      );
      expect(
        () => BrokerCodec.event({'v': 2, 'sequence': 0, 'state': {}}),
        throwsA(isA<AppFailure>()),
      );
      expect(
        () => BrokerCodec.event({
          'v': 1,
          'sequence': 0,
          'state': {'status': 'signedOut', 'fence': null, 'tokenRevision': 0},
          'refreshToken': 'secret',
        }),
        throwsA(isA<AppFailure>()),
      );
    },
  );

  test(
    'two clients share refresh and reject stale epoch after same owner login',
    () async {
      final vault = MemoryVault();
      var refreshes = 0;
      final authority = LocalSessionAuthority(
        vault: vault,
        fenceStore: MemoryFenceStore(),
        refreshTokens: (_, _) async {
          refreshes++;
          await Future<void>.delayed(Duration.zero);
          return const TokenPair(
            accessToken: 'next',
            refreshToken: 'refresh-next',
          );
        },
      );
      await authority.establish(
        owner,
        const TokenPair(accessToken: 'first', refreshToken: 'refresh-first'),
      );
      final server = SessionBrokerRpcServer(
        restoreCapturedFence: authority.restoreCapturedFence,
        authority: authority,
        auth: LocalAuthRepository(
          authority: authority,
          client: ScriptedJsonClient(
            (_, _) async => throw StateError('unused'),
          ),
        ),
      );
      final aWire = Loopback(server, 'a');
      final bWire = Loopback(server, 'b');
      final relay = server.events.listen((event) {
        aWire.injected.add(event);
        bWire.injected.add(event);
      });
      final a = await NativeSessionAuthorityProxy.attach(
        BrokerClient(aWire),
        ClientRole.ui,
      );
      final b = await NativeSessionAuthorityProxy.attach(
        BrokerClient(bWire),
        ClientRole.playback,
      );
      final fence = a.requireFence();
      final grant = await a.grantAccess(fence, origin);
      final writes = vault.writes;
      final results = await Future.wait([
        a.after401(grant.authStamp),
        b.after401(grant.authStamp),
      ]);
      expect(refreshes, 1);
      expect(vault.writes, writes + 1);
      expect(results.map((s) => s.tokenRevision), [2, 2]);
      final oldEvent = server.snapshot;
      await NativeAuthRepositoryProxy(a.client).logout();
      expect(a.state.status, SessionStatus.signedOut);
      expect(b.state.status, SessionStatus.signedOut);
      bWire.injected.add(oldEvent);
      expect(b.state.status, SessionStatus.signedOut);
      await authority.establish(
        owner,
        const TokenPair(accessToken: 'new', refreshToken: 'new-r'),
      );
      await expectLater(
        b.grantAccess(fence, origin),
        throwsA(isA<AppFailure>()),
      );
      await expectLater(
        a.grantAccess(a.requireFence(), Uri.parse('https://foreign.example')),
        throwsA(isA<AppFailure>()),
      );
      expect(server.snapshot.toString(), isNot(contains('new-r')));
      bWire.injected.add({'v': 1, 'gone': true});
      expect(b.state.status, SessionStatus.signedOut);
      await expectLater(
        b.assertCurrent(a.requireFence()),
        throwsA(isA<AppFailure>()),
      );
      await relay.cancel();
      await a.close();
      await b.close();
      await server.close();
    },
  );
}
