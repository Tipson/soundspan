import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/dart_api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';

import '../support/fake_tls_server.dart';

void main() {
  test('offline policy blocks authenticated and public sockets', () async {
    var requests = 0;
    final server = await FakeTlsServer.start((r) async {
      requests++;
      r.response.headers.contentType = ContentType.json;
      r.response.write('{}');
      await r.response.close();
    });
    addTearDown(server.close);
    final policy = _Policy()..online = false;
    final client = DartJsonHttpClient(
      securityContext: server.clientContext,
      networkPolicy: policy,
    );
    addTearDown(client.close);
    for (final authenticated in [false, true]) {
      await expectLater(
        client.send(_request(server.origin, authenticated: authenticated)),
        throwsA(isA<AppFailure>()),
      );
    }
    expect(requests, 0);
  });

  test(
    'offline cancellation survives immediate online toggle without replay',
    () async {
      final started = Completer<void>();
      var requests = 0;
      final server = await FakeTlsServer.start((r) async {
        requests++;
        r.response.headers.contentType = ContentType.json;
        r.response.write('{');
        await r.response.flush();
        started.complete();
      });
      addTearDown(server.close);
      final policy = _Policy();
      final client = DartJsonHttpClient(
        securityContext: server.clientContext,
        networkPolicy: policy,
      );
      addTearDown(client.close);
      final pending = client.send(_request(server.origin));
      final rejected = expectLater(
        pending,
        throwsA(
          isA<AppFailure>().having((e) => e.code, 'code', 'network_cancelled'),
        ),
      );
      await started.future.timeout(const Duration(seconds: 5));
      policy.setOnline(false);
      policy.setOnline(true);
      await rejected.timeout(const Duration(seconds: 5));
      expect(requests, 1);
    },
  );

  test(
    'client close aborts pending mutation and permanently closes admission',
    () async {
      final started = Completer<void>();
      var requests = 0;
      final server = await FakeTlsServer.start((r) async {
        requests++;
        await r.drain<void>();
        r.response.headers.contentType = ContentType.json;
        r.response.write('{');
        await r.response.flush();
        started.complete();
      });
      addTearDown(server.close);
      final client = DartJsonHttpClient(securityContext: server.clientContext);
      final request = ApiRequest(
        origin: server.origin,
        method: ApiMethod.post,
        path: '/api/auth/register',
        authenticated: false,
        body: {'fixture': true},
      );
      final pending = client.send(request);
      final rejected = expectLater(pending, throwsA(isA<AppFailure>()));
      await started.future.timeout(const Duration(seconds: 5));
      await client.close().timeout(const Duration(seconds: 5));
      await rejected;
      await expectLater(client.send(request), throwsA(isA<AppFailure>()));
      await client.close();
      expect(requests, 1);
    },
  );

  test(
    'explicit cancel drains requests but permits a later explicit request',
    () async {
      final started = Completer<void>();
      var requests = 0;
      final server = await FakeTlsServer.start((r) async {
        requests++;
        r.response.headers.contentType = ContentType.json;
        if (requests == 1) {
          r.response.write('{');
          await r.response.flush();
          started.complete();
        } else {
          r.response.write('{"fresh":true}');
          await r.response.close();
        }
      });
      addTearDown(server.close);
      final client = DartJsonHttpClient(securityContext: server.clientContext);
      addTearDown(client.close);
      final pending = client.send(_request(server.origin));
      final rejected = expectLater(pending, throwsA(isA<AppFailure>()));
      await started.future.timeout(const Duration(seconds: 5));
      await client.cancelPending().timeout(const Duration(seconds: 5));
      await rejected;
      expect((await client.send(_request(server.origin))).data, {
        'fresh': true,
      });
      expect(requests, 2);
    },
  );
}

ApiRequest _request(Uri origin, {bool authenticated = false}) => ApiRequest(
  origin: origin,
  method: ApiMethod.get,
  path: authenticated ? '/api/auth/me' : '/api/auth/config',
  authenticated: authenticated,
);

class _Policy extends ChangeNotifier implements NetworkPolicy {
  bool online = true;
  void setOnline(bool value) {
    online = value;
    notifyListeners();
  }

  @override
  bool get networkAllowed => online;
  @override
  void requireNetwork() {
    if (!online) {
      throw const AppFailure(code: 'offline_mode', message: 'offline');
    }
  }
}
