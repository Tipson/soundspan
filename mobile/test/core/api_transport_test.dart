import 'dart:async';
import 'dart:io';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/dart_api_transport.dart';
import 'package:soundspan/core/session/credential_vault.dart';
import 'package:soundspan/core/session/local_session_authority.dart';

import '../support/auth_fakes.dart';
import '../support/fake_tls_server.dart';
import '../support/media_fixtures.dart' show mediaAuthority;
import '../playback/play_create_journal_test.dart'
    show JournalStore, createFeatures, journalEntry;

import 'package:soundspan/app/server_capabilities.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/features/recommendations/recommendation_repository.dart';
import 'package:soundspan/playback/feedback_outbox.dart';
import 'package:soundspan/playback/play_create_journal.dart';
import 'package:soundspan/playback/play_create_protocol.dart';
import 'package:soundspan/playback/playback_event_models.dart';

void main() {
  test('TLS peer accepts a create then destroys ACK; restart replays one receipt and durable final', () async {
    var now = 1700000000000;
    var elapsed = Duration.zero;
    final accepted = <String, String>{};
    final bodies = <String>[];
    final source = await FakeTlsServer.start((request) async {
      if (request.method == 'GET') {
        request.response.headers.contentType = ContentType.json;
        request.response.write(jsonEncode(createFeatures(now)));
        await request.response.close();
        return;
      }
      if (request.method == 'PATCH') {
        await request.drain<void>();
        request.response.headers.contentType = ContentType.json;
        request.response.write('{"success":true}');
        await request.response.close();
        return;
      }
      final body = await utf8.decoder.bind(request).join();
      bodies.add(body);
      final decoded = jsonDecode(body) as Map;
      final key = decoded['clientPlaybackId'] as String;
      accepted.putIfAbsent(key, () => 'accepted-play');
      if (bodies.length == 1) {
        final socket = await request.response.detachSocket(writeHeaders: false);
        socket.destroy();
        return;
      }
      request.response.headers.contentType = ContentType.json;
      request.response.write(
        jsonEncode({
          'id': accepted[key],
          'playCreation': {
            'version': 1,
            'clientPlaybackId': key,
            'disposition': 'replayed',
            'replayExpiresAt': DateTime.fromMillisecondsSinceEpoch(
              PlayCreateKey.parse(key).expiresAtMs,
              isUtc: true,
            ).toIso8601String(),
          },
        }),
      );
      await request.response.close();
    });
    final authority = await mediaAuthority(source.origin);
    final fence = authority.requireFence();
    final client = DartJsonHttpClient(securityContext: source.clientContext);
    final transport = DartApiTransport(client: client, authority: authority);
    final store = JournalStore();
    final repo = RecommendationRepository(transport: transport);
    final outbox = FeedbackOutbox(
      store: store,
      repository: repo,
      authority: authority,
    );
    final caps = ServerCapabilitiesRepository(
      transport: transport,
      store: store,
      authority: authority,
      fence: fence,
      policy: const NetworkPolicy.online(),
      elapsed: () => elapsed,
    );
    PlayCreateJournal makeJournal() => PlayCreateJournal(
      store: store,
      repository: repo,
      outbox: outbox,
      capabilities: caps,
      authority: authority,
      fence: fence,
    );
    var journal = makeJournal();
    try {
      await caps.refresh();
      final ticket = journal.begin(
        journalEntry('ack-loss'),
        caps.playCreationGrant!,
        playbackRunId: 'run_ack_loss',
      );
      await ticket.persisted;
      await journal.flush(refresh: false);
      expect(
        bodies.length,
        1,
        reason: 'no transport retry after an unknown POST',
      );
      await journal.checkpoint(
        ticket,
        const PlayEngagement(
          listenedSeconds: 200,
          completionRatio: 1,
          outcome: PlayOutcome.completed,
        ),
        finalTotals: true,
      );
      await journal.close();
      journal = makeJournal();
      now += 1000;
      elapsed += const Duration(seconds: 1);
      await journal.recover();
      expect(bodies.length, 2);
      expect(bodies[1], bodies[0]);
      expect(accepted.length, 1);
      expect(
        await store.transaction(
          fence,
          (tx) => tx.list(PlayCreateJournal.namespace),
        ),
        isEmpty,
      );
      final finalRow = await store.transaction(
        fence,
        (tx) => tx.read(FeedbackOutbox.namespace, 'accepted-play'),
      );
      expect(finalRow, containsPair('listenedSeconds', 200));
      expect(finalRow, containsPair('outcome', 'completed'));
    } finally {
      await journal.close();
      await caps.close();
      await client.close();
      await source.close();
    }
  });
  test('three durable create operations permit only their six conditional401 TLS wire sends', () async {
    var now = 1700000000000, wire = 0, refreshes = 0;
    var elapsed = Duration.zero;
    final bodies = <String>[], attempts = <String?>[], runs = <String?>[];
    final source = await FakeTlsServer.start((request) async {
      request.response.headers.contentType = ContentType.json;
      if (request.method == 'GET') {
        expect(request.uri.path, '/api/system/features');
        request.response.write(jsonEncode(createFeatures(now)));
      } else {
        expect(request.uri.path, '/api/plays/idempotent');
        wire++;
        bodies.add(await utf8.decoder.bind(request).join());
        attempts.add(request.headers.value('X-Soundspan-Play-Attempt'));
        runs.add(request.headers.value('X-Soundspan-Playback-Run'));
        request.response.statusCode = wire.isOdd ? 401 : 503;
        if (wire.isEven) {
          request.response.headers.set(HttpHeaders.retryAfterHeader, '1');
        }
        request.response.write('{}');
      }
      await request.response.close();
    });
    final authority = await mediaAuthority(
      source.origin,
      refresh: (_, _) async {
        refreshes++;
        return TokenPair(
          accessToken: 'fresh-$refreshes',
          refreshToken: 'refresh-$refreshes',
        );
      },
    );
    final fence = authority.requireFence();
    final client = DartJsonHttpClient(securityContext: source.clientContext);
    final transport = DartApiTransport(client: client, authority: authority);
    final store = JournalStore();
    final repo = RecommendationRepository(transport: transport);
    final caps = ServerCapabilitiesRepository(
      transport: transport,
      store: store,
      authority: authority,
      fence: fence,
      policy: const NetworkPolicy.online(),
      elapsed: () => elapsed,
    );
    final journal = PlayCreateJournal(
      store: store,
      repository: repo,
      outbox: FeedbackOutbox(
        store: store,
        repository: repo,
        authority: authority,
      ),
      capabilities: caps,
      authority: authority,
      fence: fence,
    );
    try {
      await caps.refresh();
      final ticket = journal.begin(
        journalEntry('wire'),
        caps.playCreationGrant!,
        playbackRunId: 'stable_run',
      );
      await ticket.persisted;
      await journal.flush(refresh: false);
      expect(wire, 2);
      for (var i = 0; i < 3; i++) {
        now += 1000;
        elapsed += const Duration(seconds: 1);
        await journal.recover();
      }
      expect(wire, 6);
      expect(refreshes, 3);
      expect(bodies.toSet().length, 1);
      expect(runs, everyElement('stable_run'));
      expect(attempts.toSet().length, 6);
      expect(attempts, everyElement(matches(RegExp(r'^[A-Za-z0-9_-]{32}$'))));
    } finally {
      await journal.close();
      await caps.close();
      await client.close();
      await source.close();
    }
  });
  test(
    'play correlation reaches TLS headers with a fresh dispatch attempt',
    () async {
      final runs = <String?>[];
      final attempts = <String?>[];
      final source = await FakeTlsServer.start((request) async {
        runs.add(request.headers.value('X-Soundspan-Playback-Run'));
        attempts.add(request.headers.value('X-Soundspan-Play-Attempt'));
        expect(
          request.headers.value(HttpHeaders.authorizationHeader),
          'Bearer exact-origin',
        );
        request.response.headers.contentType = ContentType.json;
        request.response.write('{"id":"play-1"}');
        await request.response.close();
      });
      addTearDown(source.close);
      final client = DartJsonHttpClient(securityContext: source.clientContext);
      addTearDown(client.close);
      final request = ApiRequest(
        origin: source.origin,
        method: ApiMethod.post,
        path: '/api/plays',
        playbackRunId: 'run_stable',
      );
      await client.send(request, accessToken: 'exact-origin');
      await client.send(request, accessToken: 'exact-origin');
      await client.send(
        ApiRequest(
          origin: source.origin,
          method: ApiMethod.post,
          path: '/api/plays',
          playbackRunId: 'invalid\r\nsecret',
        ),
        accessToken: 'exact-origin',
      );
      expect(runs, ['run_stable', 'run_stable', null]);
      expect(attempts[0], matches(RegExp(r'^[A-Za-z0-9_-]{1,64}$')));
      expect(attempts[1], isNot(attempts[0]));
      expect(attempts[2], isNull);
      expect(request.toString(), isNot(contains('run_stable')));
    },
  );
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
