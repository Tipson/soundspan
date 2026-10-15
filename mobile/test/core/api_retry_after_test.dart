import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/dart_api_transport.dart';

import '../support/fake_tls_server.dart';

void main() {
  final now = DateTime.utc(2026, 10, 15, 8);
  for (final status in [429, 503]) {
    for (final dateHeader in [false, true]) {
      test(
        'TLS $status retains ${dateHeader ? 'HTTP-date' : 'delta'} holdoff without retry',
        () async {
          var calls = 0;
          final server = await FakeTlsServer.start((request) async {
            calls++;
            request.response.statusCode = status;
            request.response.headers.set(
              HttpHeaders.retryAfterHeader,
              dateHeader
                  ? HttpDate.format(now.add(const Duration(seconds: 120)))
                  : '120',
            );
            request.response.write('temporary non-JSON error');
            await request.response.close();
          });
          addTearDown(server.close);
          final response =
              await DartJsonHttpClient(
                securityContext: server.clientContext,
                now: () => now,
              ).send(
                ApiRequest(
                  origin: server.origin,
                  method: ApiMethod.get,
                  path: '/api/auth/config',
                  authenticated: false,
                ),
              );
          expect(response.retryAfter, const Duration(seconds: 120));
          expect(
            response.requireSuccess,
            throwsA(
              isA<AppFailure>()
                  .having((e) => e.statusCode, 'status', status)
                  .having(
                    (e) => e.retryAfter,
                    'holdoff',
                    const Duration(seconds: 120),
                  ),
            ),
          );
          expect(calls, 1);
        },
      );
    }
  }

  for (final value in [
    'nonsense',
    '-10',
    '9' * 1000,
    'Thu, 99 Oct 2026 25:99:99 GMT',
    'Mon, 30 Feb 2026 08:02:00 GMT',
  ]) {
    test(
      'invalid Retry-After is ignored safely: ${value.length} bytes',
      () async {
        final server = await FakeTlsServer.start((request) async {
          request.response.statusCode = 503;
          request.response.headers.set(HttpHeaders.retryAfterHeader, value);
          await request.response.close();
        });
        addTearDown(server.close);
        final response =
            await DartJsonHttpClient(
              securityContext: server.clientContext,
              now: () => now,
            ).send(
              ApiRequest(
                origin: server.origin,
                method: ApiMethod.get,
                path: '/api/auth/config',
                authenticated: false,
              ),
            );
        expect(response.retryAfter, isNull);
      },
    );
  }

  for (final value in [
    'Thursday, 15-Oct-26 08:02:00 GMT',
    'Thu Oct 15 08:02:00 2026',
  ]) {
    test('valid legacy HTTP-date retains its holdoff: $value', () async {
      final server = await FakeTlsServer.start((request) async {
        request.response.statusCode = 503;
        request.response.headers.set(HttpHeaders.retryAfterHeader, value);
        await request.response.close();
      });
      addTearDown(server.close);
      final response =
          await DartJsonHttpClient(
            securityContext: server.clientContext,
            now: () => now,
          ).send(
            ApiRequest(
              origin: server.origin,
              method: ApiMethod.get,
              path: '/api/auth/config',
              authenticated: false,
            ),
          );
      expect(response.retryAfter, const Duration(seconds: 120));
    });
  }

  test('past HTTP-date produces no negative wait', () async {
    final server = await FakeTlsServer.start((request) async {
      request.response.statusCode = 429;
      request.response.headers.set(
        HttpHeaders.retryAfterHeader,
        HttpDate.format(now.subtract(const Duration(seconds: 1))),
      );
      await request.response.close();
    });
    addTearDown(server.close);
    final response =
        await DartJsonHttpClient(
          securityContext: server.clientContext,
          now: () => now,
        ).send(
          ApiRequest(
            origin: server.origin,
            method: ApiMethod.get,
            path: '/api/auth/config',
            authenticated: false,
          ),
        );
    expect(response.retryAfter, Duration.zero);
  });
}
