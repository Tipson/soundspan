import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/session/auth_repository.dart';
import 'package:soundspan/core/session/broker_client.dart';
import 'package:soundspan/core/session/local_session_authority.dart';
import 'package:soundspan/core/session/native_auth_repository_proxy.dart';
import 'package:soundspan/core/session/session_broker_protocol.dart';
import 'package:soundspan/core/session/session_broker_rpc_server.dart';

import '../support/auth_fakes.dart';
import 'session_broker_test.dart' show Loopback;

void main() {
  for (final delay in [-1, 1.5, '120', 1000000000000000]) {
    test('broker rejects malformed retry deadline $delay', () async {
      final client = BrokerClient(
        _ReplyTransport({
          'code': 'http_error',
          'retryable': true,
          'statusCode': 429,
          'retryAfterMillis': delay,
        }),
      );
      addTearDown(client.close);
      await expectLater(
        client.call('config'),
        throwsA(
          isA<AppFailure>().having((e) => e.code, 'code', 'broker_protocol'),
        ),
      );
    });
  }
  test('legacy broker error stays compatible without delay', () async {
    final client = BrokerClient(
      _ReplyTransport({
        'code': 'http_error',
        'retryable': true,
        'statusCode': 429,
      }),
    );
    addTearDown(client.close);
    await expectLater(
      client.call('config'),
      throwsA(
        isA<AppFailure>()
            .having((e) => e.statusCode, 'status', 429)
            .having((e) => e.retryAfter, 'delay', isNull),
      ),
    );
  });
  for (final status in [429, 503]) {
    test(
      'broker keeps $status holdoff without exposing response body',
      () async {
        final authority = LocalSessionAuthority(
          vault: MemoryVault(),
          fenceStore: MemoryFenceStore(),
          refreshTokens: (_, _) => throw StateError('No refresh'),
        );
        final socket = ScriptedJsonClient(
          (_, _) async => ApiResponse(status, const {
            'private': 'must-not-be-exposed',
          }, retryAfter: const Duration(seconds: 137)),
        );
        final server = SessionBrokerRpcServer(
          authority: authority,
          auth: LocalAuthRepository(authority: authority, client: socket),
          restoreCapturedFence: authority.restoreCapturedFence,
        );
        addTearDown(server.close);
        final client = BrokerClient(Loopback(server, 'holdoff-ui'));
        addTearDown(client.close);
        await client.attach(ClientRole.ui);
        await expectLater(
          NativeAuthRepositoryProxy(client).config(origin),
          throwsA(
            isA<AppFailure>()
                .having((e) => e.statusCode, 'status', status)
                .having(
                  (e) => e.retryAfter,
                  'holdoff',
                  const Duration(seconds: 137),
                )
                .having(
                  (e) => e.message,
                  'safe message',
                  isNot(contains('must-not-be-exposed')),
                ),
          ),
        );
        expect(socket.calls, 1);
      },
    );
  }
}

final class _ReplyTransport implements BrokerTransport {
  _ReplyTransport(this.error);
  final Map<String, Object?> error;
  final controller = StreamController<Object?>.broadcast();
  @override
  Stream<Object?> get events => controller.stream;
  @override
  Future<Object?> invoke(Map<String, Object?> request) async => {
    'v': 1,
    'ok': false,
    'error': error,
  };
  @override
  Future<void> close() => controller.close();
}
