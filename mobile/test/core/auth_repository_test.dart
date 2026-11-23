import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/session/auth_models.dart';
import 'package:soundspan/core/session/auth_repository.dart';
import 'package:soundspan/core/session/local_session_authority.dart';
import 'package:soundspan/core/session/session_authority.dart';
import 'package:soundspan/core/session/credential_vault.dart';
import 'package:soundspan/core/session/secure_storage_credential_vault.dart';

import '../support/auth_fakes.dart';

void main() {
  test(
    'public config preview on another server preserves the current session',
    () async {
      final vault = MemoryVault();
      final store = MemoryFenceStore();
      final authority = LocalSessionAuthority(
        vault: vault,
        fenceStore: store,
        refreshTokens: (_, _) => throw StateError('unused'),
      );
      await authority.establish(
        owner,
        const TokenPair(accessToken: 'a', refreshToken: 'r'),
      );
      final fence = authority.requireFence();
      final other = Uri.parse('https://other.example');
      final client = ScriptedJsonClient((request, token) async {
        expect(request.origin, other);
        expect(token, isNull);
        return const ApiResponse(200, {
          'localLoginEnabled': true,
          'oidcEnabled': false,
          'oidcProviderName': '',
        });
      });
      await LocalAuthRepository(
        authority: authority,
        client: client,
      ).config(other);
      expect(authority.requireFence(), fence);
      expect(store.value.admits(fence), isTrue);
      expect(vault.value!.tokens.refreshToken, 'r');
    },
  );
  group('secure storage adapter', () {
    setUp(() {
      TestWidgetsFlutterBinding.ensureInitialized();
      FlutterSecureStorage.setMockInitialValues({});
    });

    test(
      'corrupt secure record can be removed during logout recovery',
      () async {
        const storage = FlutterSecureStorage();
        final vault = SecureStorageCredentialVault(storage: storage);
        await vault.write(
          StoredCredentials(
            fence: SessionFence(owner: owner, epoch: 1),
            tokenRevision: 1,
            tokens: const TokenPair(accessToken: 'a', refreshToken: 'r'),
          ),
        );
        final key = (await storage.readAll()).keys.single;
        await storage.write(key: key, value: '{broken');
        await vault.delete(owner);
        expect(await vault.read(origin), isNull);
      },
    );

    test(
      'one stamped pair roundtrips and a different owner cannot delete it',
      () async {
        final vault = SecureStorageCredentialVault();
        await vault.write(
          StoredCredentials(
            fence: SessionFence(owner: owner, epoch: 7),
            tokenRevision: 3,
            tokens: const TokenPair(accessToken: 'a', refreshToken: 'r'),
          ),
        );
        final read = await vault.read(origin);
        expect(read!.fence.epoch, 7);
        expect(read.tokenRevision, 3);
        expect(read.tokens.accessToken, 'a');
        expect(read.tokens.refreshToken, 'r');
        await vault.delete(OwnerKey(serverOrigin: origin, userId: 'bob'));
        expect(await vault.read(origin), isNotNull);
        await vault.delete(owner);
        expect(await vault.read(origin), isNull);
      },
    );
  });

  test(
    'logout while config is pending prevents late password submission',
    () async {
      final configGate = Completer<ApiResponse>();
      final configStarted = Completer<void>();
      final client = ScriptedJsonClient((request, _) {
        if (request.path == '/api/auth/config') {
          configStarted.complete();
          return configGate.future;
        }
        return Future.value(const ApiResponse(200, {'requires2FA': true}));
      });
      final authority = LocalSessionAuthority(
        vault: MemoryVault(),
        fenceStore: MemoryFenceStore(),
        refreshTokens: (_, _) => throw StateError('unused'),
      );
      final auth = LocalAuthRepository(authority: authority, client: client);
      final login = auth.login(
        LoginInput(origin: origin, username: 'alice', password: 'secret'),
      );
      final failure = expectLater(login, throwsA(isA<AppFailure>()));
      await configStarted.future;
      await auth.logout();
      configGate.complete(
        const ApiResponse(200, {
          'localLoginEnabled': true,
          'oidcEnabled': false,
          'oidcProviderName': '',
        }),
      );
      await failure;
      expect(client.calls, 1);
    },
  );

  test(
    'disabled local config does not send password or write credentials',
    () async {
      final vault = MemoryVault();
      final client = ScriptedJsonClient((request, _) async {
        expect(request.path, '/api/auth/config');
        return const ApiResponse(200, {
          'localLoginEnabled': false,
          'oidcEnabled': true,
          'oidcProviderName': 'SSO',
        });
      });
      final authority = LocalSessionAuthority(
        vault: vault,
        fenceStore: MemoryFenceStore(),
        refreshTokens: (_, _) => throw StateError('unused'),
      );
      final auth = LocalAuthRepository(authority: authority, client: client);
      await expectLater(
        auth.login(
          LoginInput(origin: origin, username: 'alice', password: 'secret'),
        ),
        throwsA(
          isA<AppFailure>().having(
            (e) => e.code,
            'code',
            'local_login_disabled',
          ),
        ),
      );
      expect(vault.writes, 0);
      expect(client.calls, 1);
    },
  );

  test(
    '200 requires2FA stores zero tokens then valid code stores complete pair',
    () async {
      final vault = MemoryVault();
      final client = ScriptedJsonClient((request, _) async {
        if (request.path == '/api/auth/config') {
          return const ApiResponse(200, {
            'localLoginEnabled': true,
            'oidcEnabled': false,
            'oidcProviderName': '',
          });
        }
        if (request.body!['token'] == null) {
          return const ApiResponse(200, {'requires2FA': true});
        }
        expect(request.body!['token'], '123456');
        return const ApiResponse(200, {
          'token': 'a',
          'refreshToken': 'r',
          'user': {'id': 'alice', 'username': 'alice'},
        });
      });
      final authority = LocalSessionAuthority(
        vault: vault,
        fenceStore: MemoryFenceStore(),
        refreshTokens: (_, _) => throw StateError('unused'),
      );
      final auth = LocalAuthRepository(authority: authority, client: client);
      expect(
        (await auth.login(
          LoginInput(origin: origin, username: 'alice', password: 'secret'),
        )).requires2FA,
        isTrue,
      );
      expect(vault.writes, 0);
      final result = await auth.login(
        LoginInput(
          origin: origin,
          username: 'alice',
          password: 'secret',
          token: '123456',
        ),
      );
      expect(result.requires2FA, isFalse);
      expect(vault.value!.tokens.refreshToken, 'r');
      final calls = client.calls;
      expect(
        (await auth.restore(origin)).status,
        SessionStatus.offlineValidated,
      );
      expect(client.calls, calls);
    },
  );

  for (final body in <Map<String, Object?>>[
    {
      'token': 'a',
      'user': {'id': 'alice'},
    },
    {'token': 'a', 'refreshToken': 'r', 'user': {}},
    {'requires2FA': true, 'token': 'a', 'refreshToken': 'r'},
  ]) {
    test(
      'malformed login response cannot establish credentials: $body',
      () async {
        final vault = MemoryVault();
        final client = ScriptedJsonClient(
          (request, _) async => ApiResponse(
            200,
            request.path == '/api/auth/config'
                ? {
                    'localLoginEnabled': true,
                    'oidcEnabled': false,
                    'oidcProviderName': '',
                  }
                : body,
          ),
        );
        final authority = LocalSessionAuthority(
          vault: vault,
          fenceStore: MemoryFenceStore(),
          refreshTokens: (_, _) => throw StateError('unused'),
        );
        final auth = LocalAuthRepository(authority: authority, client: client);
        await expectLater(
          auth.login(
            LoginInput(origin: origin, username: 'alice', password: 'secret'),
          ),
          throwsA(isA<AppFailure>()),
        );
        expect(vault.writes, 0);
      },
    );
  }
}
