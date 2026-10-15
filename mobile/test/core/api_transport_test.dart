import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/dart_api_transport.dart';
import 'package:soundspan/core/session/credential_vault.dart';
import 'package:soundspan/core/session/local_session_authority.dart';

import '../support/auth_fakes.dart';
import '../support/fake_tls_server.dart';

void main() {
  test(
    'invite registration uses explicit public POST without an access grant',
    () async {
      var calls = 0;
      final source = await FakeTlsServer.start((request) async {
        calls++;
        expect(request.method, 'POST');
        expect(request.uri.path, '/api/auth/register');
        expect(request.headers.value(HttpHeaders.authorizationHeader), isNull);
        request.response.headers.contentType = ContentType.json;
        request.response.write('{"success":true}');
        await request.response.close();
      });
      addTearDown(source.close);
      final authority = LocalSessionAuthority(
        vault: MemoryVault(),
        fenceStore: MemoryFenceStore(),
        refreshTokens: (_, _) => throw StateError('No refresh allowed'),
      );
      final transport = DartApiTransport(
        authority: authority,
        client: DartJsonHttpClient(securityContext: source.clientContext),
      );
      final result = await transport.send(
        ApiRequest(
          origin: source.origin,
          method: ApiMethod.post,
          path: '/api/auth/register',
          authenticated: false,
          body: {
            'inviteCode': 'test-invite',
            'username': 'test-user',
            'password': 'test-password',
          },
        ),
      );
      expect(result.data, {'success': true});
      expect(calls, 1);
      for (final request in [
        () => ApiRequest(
          origin: source.origin,
          method: ApiMethod.get,
          path: '/api/auth/register',
          authenticated: false,
        ),
        () => ApiRequest(
          origin: source.origin,
          method: ApiMethod.post,
          path: '/api/auth/change-password',
          authenticated: false,
        ),
      ]) {
        expect(request, throwsA(isA<AppFailure>()));
      }
    },
  );

  test('real TLS redirects never send Bearer to the target', () async {
    var foreignRequests = 0;
    final foreign = await FakeTlsServer.start((request) async {
      foreignRequests++;
      request.response.headers.contentType = ContentType.json;
      request.response.write('{}');
      await request.response.close();
    });
    addTearDown(foreign.close);
    final source = await FakeTlsServer.start((request) async {
      expect(
        request.headers.value(HttpHeaders.authorizationHeader),
        'Bearer exact-origin',
      );
      request.response.statusCode = 307;
      request.response.headers.set(
        HttpHeaders.locationHeader,
        '${foreign.origin}/api/auth/me',
      );
      await request.response.close();
    });
    addTearDown(source.close);
    final client = DartJsonHttpClient(securityContext: source.clientContext);
    await expectLater(
      client.send(
        ApiRequest(
          origin: source.origin,
          method: ApiMethod.get,
          path: '/api/auth/me',
        ),
        accessToken: 'exact-origin',
      ),
      throwsA(
        isA<AppFailure>().having(
          (e) => e.code,
          'code',
          'api_redirect_rejected',
        ),
      ),
    );
    expect(foreignRequests, 0);
  });

  test(
    'real TLS rejects unknown certificate and accepts explicit test CA',
    () async {
      var accepted = 0;
      final source = await FakeTlsServer.start((request) async {
        accepted++;
        request.response.headers.contentType = ContentType.json;
        request.response.write('{"ok":true}');
        await request.response.close();
      });
      addTearDown(source.close);
      final request = ApiRequest(
        origin: source.origin,
        method: ApiMethod.get,
        path: '/api/auth/config',
        authenticated: false,
      );
      await expectLater(
        DartJsonHttpClient().send(request),
        throwsA(isA<AppFailure>().having((e) => e.code, 'code', 'tls_failed')),
      );
      final response = await DartJsonHttpClient(
        securityContext: source.clientContext,
      ).send(request);
      expect(response.data, {'ok': true});
      expect(accepted, 1);
    },
  );

  test('real TLS bounds streamed response size and total timeout', () async {
    final source = await FakeTlsServer.start((request) async {
      request.response.headers.contentType = ContentType.json;
      if (request.uri.path.endsWith('/slow')) {
        await Future<void>.delayed(const Duration(milliseconds: 200));
      }
      request.response.write('{"large":"${'x' * 1024}"}');
      try {
        await request.response.close();
      } on SocketException {
        /* timeout aborted socket */
      }
    });
    addTearDown(source.close);
    final client = DartJsonHttpClient(
      securityContext: source.clientContext,
      maxResponseBytes: 100,
    );
    await expectLater(
      client.send(
        ApiRequest(
          origin: source.origin,
          method: ApiMethod.get,
          path: '/api/auth/me',
        ),
      ),
      throwsA(
        isA<AppFailure>().having((e) => e.code, 'code', 'response_too_large'),
      ),
    );
    final bounded = DartJsonHttpClient(
      securityContext: source.clientContext,
      timeout: const Duration(milliseconds: 50),
    );
    await expectLater(
      bounded.send(
        ApiRequest(
          origin: source.origin,
          method: ApiMethod.get,
          path: '/api/slow',
        ),
      ),
      throwsA(
        isA<AppFailure>().having((e) => e.code, 'code', 'network_timeout'),
      ),
    );
    await Future<void>.delayed(const Duration(milliseconds: 250));
  });

  test(
    '401 replays a mutation once with new token; second 401 stops',
    () async {
      var refreshes = 0;
      final seen = <String?>[];
      final authority = LocalSessionAuthority(
        vault: MemoryVault(),
        fenceStore: MemoryFenceStore(),
        refreshTokens: (_, _) async {
          refreshes++;
          return const TokenPair(accessToken: 'a2', refreshToken: 'r2');
        },
      );
      await authority.establish(
        owner,
        const TokenPair(accessToken: 'a1', refreshToken: 'r1'),
      );
      final client = ScriptedJsonClient((request, token) async {
        seen.add(token);
        return const ApiResponse(401, {});
      });
      final transport = DartApiTransport(client: client, authority: authority);
      await expectLater(
        transport.send(
          ApiRequest(
            origin: origin,
            method: ApiMethod.post,
            path: '/api/plays',
            body: {'trackId': 'x'},
          ),
        ),
        throwsA(isA<AppFailure>()),
      );
      expect(seen, ['a1', 'a2']);
      expect(refreshes, 1);
    },
  );

  for (final status in [424, 429, 503]) {
    test('$status never refreshes or retries mutations', () async {
      final authority = LocalSessionAuthority(
        vault: MemoryVault(),
        fenceStore: MemoryFenceStore(),
        refreshTokens: (_, _) => throw StateError('unexpected refresh'),
      );
      await authority.establish(
        owner,
        const TokenPair(accessToken: 'a', refreshToken: 'r'),
      );
      final client = ScriptedJsonClient(
        (_, _) async => ApiResponse(status, {}),
      );
      final transport = DartApiTransport(client: client, authority: authority);
      await expectLater(
        transport.send(
          ApiRequest(
            origin: origin,
            method: ApiMethod.post,
            path: '/api/plays',
          ),
        ),
        throwsA(isA<AppFailure>()),
      );
      expect(client.calls, 1);
    });
  }

  test('logout during response prevents publication', () async {
    final gate = Completer<ApiResponse>();
    final started = Completer<void>();
    final authority = LocalSessionAuthority(
      vault: MemoryVault(),
      fenceStore: MemoryFenceStore(),
      refreshTokens: (_, _) => throw StateError('unused'),
    );
    await authority.establish(
      owner,
      const TokenPair(accessToken: 'a', refreshToken: 'r'),
    );
    final client = ScriptedJsonClient((_, _) {
      started.complete();
      return gate.future;
    });
    final transport = DartApiTransport(client: client, authority: authority);
    final result = transport.send(
      ApiRequest(origin: origin, method: ApiMethod.get, path: '/api/auth/me'),
    );
    final failed = expectLater(result, throwsA(isA<AppFailure>()));
    await started.future;
    await authority.invalidate();
    gate.complete(const ApiResponse(200, {'id': 'alice'}));
    await failed;
  });

  test(
    'URL credentials, path traversal and non-API paths fail before network',
    () {
      for (final path in [
        '/api/../admin',
        '//evil.example/api',
        '/api/x%2fy',
        '/api/auth/me?token=secret',
        '/anything',
        '/api/a\\b',
      ]) {
        expect(
          () => ApiRequest(origin: origin, method: ApiMethod.get, path: path),
          throwsA(isA<AppFailure>()),
        );
      }
      for (final uri in [
        'http://music.example',
        'https://user@music.example',
        'https://music.example/path',
        'https://music.example.',
      ]) {
        expect(
          () => ApiRequest(
            origin: Uri.parse(uri),
            method: ApiMethod.get,
            path: '/api/auth/me',
          ),
          throwsA(isA<AppFailure>()),
        );
      }
      expect(
        () => ApiRequest(
          origin: origin,
          method: ApiMethod.get,
          path: '/api/auth/me',
          query: {'refreshToken': 'secret'},
        ),
        throwsA(isA<AppFailure>()),
      );
    },
  );
}
