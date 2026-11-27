import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/session/session_authority.dart';
import 'package:soundspan/core/session/credential_vault.dart';
import 'package:soundspan/downloads/protected_media_fetcher.dart';
import 'package:soundspan/playback/media_gateway.dart';
import 'package:soundspan/playback/playback_command.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/playback_resolver.dart';
import 'package:soundspan/playback/queue_coordinator.dart';
import 'package:soundspan/playback/queue_snapshot.dart';

import '../support/fake_tls_server.dart';
import '../support/media_fixtures.dart';

class _ResolverTransport implements ApiTransport {
  int calls = 0;
  @override
  Future<ApiResponse> send(ApiRequest request, {SessionFence? fence}) async {
    calls++;
    return ApiResponse(200, {
      'playback': {
        'provider': 'yandex',
        'leaseId': leasePath.split('/')[4],
        'streamPath': leasePath,
      },
    });
  }
}

class _GatewayEngine implements PlaybackEngine {
  _GatewayEngine({this.requestDuringLoad = true});
  final bool requestDuringLoad;
  final controller = StreamController<EngineEvent>.broadcast(sync: true);
  final bytes = <int>[];
  Uri? source;
  int generation = -1, loads = 0;
  @override
  Stream<EngineEvent> get events => controller.stream;
  @override
  Future<void> load(Uri uri, int generation) async {
    source = uri;
    this.generation = generation;
    loads++;
    if (requestDuringLoad) await consume();
  }

  Future<void> consume() async {
    final client = HttpClient();
    try {
      final response = await (await client.getUrl(source!)).close();
      await for (final chunk in response) {
        bytes.addAll(chunk);
      }
      if (response.statusCode != 200) throw StateError('Native load failed');
    } finally {
      client.close(force: true);
    }
  }

  Future<void> failFromCurrentGateway() async {
    final capturedGeneration = generation;
    try {
      await consume();
    } catch (_) {
      controller.add(
        EngineEvent(
          generation: capturedGeneration,
          position: Duration.zero,
          processing: PlaybackProcessing.failed,
          playing: false,
          failed: true,
        ),
      );
    }
  }

  @override
  Future<void> play() async {}
  @override
  Future<void> pause() async {}
  @override
  Future<void> stop() async {}
  @override
  Future<void> seek(Duration position) async {}
  @override
  Future<void> setVolume(double volume) async {}
  @override
  Future<void> dispose() => controller.close();
}

QueueEntry _entry(String id) => QueueEntry(
  entryId: id,
  track: Track(ref: recordingRef, title: 'Synthetic', artist: 'Fixture'),
  context: const PlayContext(surface: PlaySurface.playlist),
);

Future<
  ({
    QueueCoordinator queue,
    _GatewayEngine engine,
    _ResolverTransport transport,
    MediaGateway gateway,
  })
>
_rig(
  FakeTlsServer server,
  SessionAuthority authority, {
  bool requestDuringLoad = true,
  bool trustFixture = true,
  Duration idleTimeout = const Duration(seconds: 2),
}) async {
  final gateway = MediaGateway(
    authority: authority,
    fetcher: ProtectedMediaFetcher(
      authority: authority,
      securityContext: trustFixture ? server.clientContext : null,
      idleTimeout: idleTimeout,
    ),
  );
  final engine = _GatewayEngine(requestDuringLoad: requestDuringLoad);
  final transport = _ResolverTransport();
  final queue = QueueCoordinator(
    authority: authority,
    engine: engine,
    prepare: protectedAudioPreparation(
      PlaybackResolver(transport: transport, authority: authority),
      gateway,
    ),
  );
  addTearDown(gateway.close);
  addTearDown(queue.dispose);
  return (queue: queue, engine: engine, transport: transport, gateway: gateway);
}

void main() {
  for (final duringLoad in [true, false]) {
    test(
      'gateway typed503 survives ${duringLoad ? 'load throw' : 'engine event'} and retains queue',
      () async {
        var requests = 0;
        final server = await FakeTlsServer.start((r) async {
          requests++;
          r.response.statusCode = 503;
          r.response.headers.set('retry-after', '17');
          await r.response.close();
        });
        addTearDown(server.close);
        final authority = await mediaAuthority(server.origin);
        final rig = await _rig(
          server,
          authority,
          requestDuringLoad: duringLoad,
        );
        await rig.queue.dispatch(
          ReplaceQueue([
            _entry('one'),
            _entry('two'),
          ], fence: authority.requireFence()),
        );
        if (!duringLoad) await rig.engine.failFromCurrentGateway();
        expect(rig.queue.snapshot.failure?.code, 'http_error');
        expect(rig.queue.snapshot.failure?.statusCode, 503);
        expect(
          rig.queue.snapshot.failure?.retryAfter,
          const Duration(seconds: 17),
        );
        expect(rig.queue.snapshot.currentEntryId, 'one');
        expect(rig.queue.snapshot.entries.map((e) => e.entryId), [
          'one',
          'two',
        ]);
        expect(requests, 1);
        expect(rig.transport.calls, 1);
      },
    );
  }

  for (final status in [502, 503, 504]) {
    test(
      'gateway retries transient$status once before committing headers or bytes',
      () async {
        var requests = 0;
        final seen = <String>[];
        final server = await FakeTlsServer.start((r) async {
          seen.add(
            '${r.method} ${r.uri.path} ${r.headers.value('range')} ${r.headers.value('if-range')}',
          );
          if (++requests == 1) {
            r.response.statusCode = status;
            await r.response.close();
          } else {
            await sendAudio(r);
          }
        });
        addTearDown(server.close);
        final authority = await mediaAuthority(server.origin);
        final rig = await _rig(server, authority);
        await rig.queue.dispatch(
          ReplaceQueue([_entry('one')], fence: authority.requireFence()),
        );
        expect(rig.queue.snapshot.failure, isNull);
        expect(rig.engine.bytes, audioBytes);
        expect(requests, 2);
        expect(seen[0], seen[1]);
        expect(rig.engine.loads, 1);
        expect(rig.transport.calls, 1);
      },
    );
  }

  for (final method in ['GET', 'HEAD']) {
    test(
      'one recovery preserves $method range and If-Range with one truthful response',
      () async {
        final seen = <String>[];
        final server = await FakeTlsServer.start((r) async {
          seen.add(
            '${r.method} ${r.uri.path} ${r.headers.value('range')} ${r.headers.value('if-range')}',
          );
          if (seen.length == 1) {
            r.response.statusCode = 503;
            await r.response.close();
          } else {
            await sendAudio(r);
          }
        });
        addTearDown(server.close);
        final authority = await mediaAuthority(server.origin);
        final rig = await _rig(server, authority);
        final handle = await rig.gateway.open(
          nativeMedia(authority, path: leasePath),
          authority.requireFence(),
        );
        final client = HttpClient();
        addTearDown(() => client.close(force: true));
        final request = await client.openUrl(method, handle.uri);
        request.headers.set('range', 'bytes=2-79');
        request.headers.set('if-range', '"v1"');
        final response = await request.close();
        expect(response.statusCode, 206);
        expect(response.contentLength, 78);
        expect(
          await response.expand((e) => e).toList(),
          method == 'HEAD' ? <int>[] : audioBytes.sublist(2, 80),
        );
        expect(seen.length, 2);
        expect(seen.first, seen.last);
        expect(handle.failure, isNull);
      },
    );
  }

  test('network close before upstream headers recovers once without a second queue load', () async {
    var requests = 0;
    final server = await FakeTlsServer.start((r) async {
      if (++requests == 1) {
        (await r.response.detachSocket(writeHeaders: false)).destroy();
      } else {
        await sendAudio(r);
      }
    });
    addTearDown(server.close);
    final authority = await mediaAuthority(server.origin);
    final rig = await _rig(server, authority);
    await rig.queue.dispatch(
      ReplaceQueue([_entry('one')], fence: authority.requireFence()),
    );
    expect(rig.queue.snapshot.failure, isNull);
    expect(rig.engine.bytes, audioBytes);
    expect(requests, 2);
    expect(rig.engine.loads, 1);
  });

  test(
    'second transient failure stops at two attempts and keeps its typed status',
    () async {
      var requests = 0;
      final server = await FakeTlsServer.start((r) async {
        requests++;
        r.response.statusCode = 502;
        await r.response.close();
      });
      addTearDown(server.close);
      final authority = await mediaAuthority(server.origin);
      final rig = await _rig(server, authority);
      await rig.queue.dispatch(
        ReplaceQueue([_entry('one')], fence: authority.requireFence()),
      );
      expect(requests, 2);
      expect(rig.queue.snapshot.failure?.statusCode, 502);
      expect(rig.queue.snapshot.failure?.retryable, true);
      expect(rig.engine.loads, 1);
      expect(rig.transport.calls, 1);
    },
  );

  for (final status in [400, 401, 404, 429, 451, 500]) {
    test('permanent/status$status does not acquire a transient retry budget', () async {
      var requests = 0;
      final server = await FakeTlsServer.start((r) async {
        requests++;
        r.response.statusCode = status;
        if (status == 429) r.response.headers.set('retry-after', '17');
        await r.response.close();
      });
      addTearDown(server.close);
      final authority = await mediaAuthority(server.origin);
      final rig = await _rig(server, authority);
      await rig.queue.dispatch(
        ReplaceQueue([_entry('one')], fence: authority.requireFence()),
      );
      expect(rig.queue.snapshot.failure?.statusCode, status);
      if (status == 451) {
        expect(rig.queue.snapshot.failure?.code, 'media_restricted');
        expect(
          rig.queue.snapshot.failure?.message,
          contains('Источник ограничил доступ'),
        );
        expect(rig.queue.snapshot.failure?.retryable, isFalse);
      }
      // Existing one401 refresh and one404 native lease renewal remain intact.
      expect(requests, const {401, 404}.contains(status) ? 2 : 1);
    });
  }

  test('retry does not reset the operation-wide401 replay budget', () async {
    var requests = 0, refreshes = 0;
    final server = await FakeTlsServer.start((r) async {
      requests++;
      r.response.statusCode = requests == 2 ? 503 : 401;
      await r.response.close();
    });
    addTearDown(server.close);
    final authority = await mediaAuthority(
      server.origin,
      refresh: (_, _) async {
        refreshes++;
        return const TokenPair(accessToken: 'fresh', refreshToken: 'new');
      },
    );
    final rig = await _rig(server, authority);
    await rig.queue.dispatch(
      ReplaceQueue([_entry('one')], fence: authority.requireFence()),
    );
    expect(requests, 3);
    expect(refreshes, 1);
    expect(rig.queue.snapshot.failure?.statusCode, 401);
  });

  test(
    'retry does not reset the operation-wide404 lease renewal budget',
    () async {
      final paths = <String>[];
      final server = await FakeTlsServer.start((r) async {
        paths.add(r.uri.path);
        if (paths.length == 2) {
          r.response.statusCode = 307;
          r.response.headers.set('location', renewedLeasePath);
        } else {
          r.response.statusCode = paths.length == 3 ? 503 : 404;
        }
        await r.response.close();
      });
      addTearDown(server.close);
      final authority = await mediaAuthority(server.origin);
      final rig = await _rig(server, authority);
      await rig.queue.dispatch(
        ReplaceQueue([_entry('one')], fence: authority.requireFence()),
      );
      expect(paths, [
        leasePath,
        recordingPath,
        renewedLeasePath,
        renewedLeasePath,
      ]);
      expect(rig.queue.snapshot.failure?.statusCode, 404);
    },
  );

  test('retry retains redirect hop count and cannot reopen a cycle', () async {
    var requests = 0;
    final server = await FakeTlsServer.start((r) async {
      requests++;
      if (requests == 2) {
        r.response.statusCode = 503;
      } else {
        r.response.statusCode = 307;
        r.response.headers.set(
          'location',
          '/api/music-sources/leases/${requests.toRadixString(16).padLeft(48, '0')}/stream',
        );
      }
      await r.response.close();
    });
    addTearDown(server.close);
    final authority = await mediaAuthority(server.origin);
    final rig = await _rig(server, authority);
    await rig.queue.dispatch(
      ReplaceQueue([_entry('one')], fence: authority.requireFence()),
    );
    expect(requests, 5);
    expect(rig.queue.snapshot.failure?.code, 'invalid_media');
  });

  test('invalid media and untrusted TLS are terminal without retry', () async {
    var requests = 0;
    final server = await FakeTlsServer.start((r) async {
      requests++;
      r.response.headers.set('content-type', 'audio/mpeg');
      r.response.write('{"not":"audio"}');
      await r.response.close();
    });
    addTearDown(server.close);
    final authority = await mediaAuthority(server.origin);
    final rig = await _rig(server, authority);
    await rig.queue.dispatch(
      ReplaceQueue([_entry('one')], fence: authority.requireFence()),
    );
    expect(requests, 1);
    expect(rig.queue.snapshot.failure?.code, 'invalid_media');
    final tls = await _rig(server, authority, trustFixture: false);
    await tls.queue.dispatch(
      ReplaceQueue([_entry('tls')], fence: authority.requireFence()),
    );
    expect(requests, 1);
    expect(tls.queue.snapshot.failure?.code, 'tls_failed');
  });

  test(
    'truncation after downstream headers never replays committed bytes',
    () async {
      var requests = 0;
      final server = await FakeTlsServer.start((r) async {
        requests++;
        r.response.headers.set('content-type', 'audio/mpeg');
        r.response.contentLength = 512;
        final socket = await r.response.detachSocket();
        socket.add(audioBytes);
        await socket.flush();
        socket.destroy();
      });
      addTearDown(server.close);
      final authority = await mediaAuthority(server.origin);
      final rig = await _rig(server, authority);
      await rig.queue.dispatch(
        ReplaceQueue([_entry('one')], fence: authority.requireFence()),
      );
      expect(requests, 1);
      expect(rig.engine.bytes, audioBytes);
      expect(rig.queue.snapshot.failure, isA<AppFailure>());
      expect(rig.queue.snapshot.failure?.code, isNot('playback_failed'));
    },
  );

  for (final ownerChange in [false, true]) {
    test(
      '${ownerChange ? 'owner change' : 'handle cancellation'} suppresses retry of pending503',
      () async {
        var requests = 0;
        final entered = Completer<void>(), release = Completer<void>();
        final server = await FakeTlsServer.start((r) async {
          requests++;
          if (!entered.isCompleted) entered.complete();
          await release.future;
          try {
            r.response.statusCode = 503;
            await r.response.close();
          } catch (_) {}
        });
        addTearDown(server.close);
        addTearDown(() {
          if (!release.isCompleted) release.complete();
        });
        final authority = await mediaAuthority(server.origin);
        final rig = await _rig(server, authority);
        final handle = await rig.gateway.open(
          nativeMedia(authority, path: leasePath),
          authority.requireFence(),
        );
        final client = HttpClient();
        addTearDown(() => client.close(force: true));
        final pending = (await client.getUrl(handle.uri))
            .close()
            .then((r) => r.drain<void>())
            .catchError((Object _) {});
        await entered.future;
        if (ownerChange) {
          await authority.invalidate();
          await authority.establish(
            OwnerKey(serverOrigin: server.origin, userId: 'other'),
            const TokenPair(
              accessToken: 'other',
              refreshToken: 'other-refresh',
            ),
          );
        } else {
          await handle.revoke();
        }
        release.complete();
        await pending;
        await pumpEventQueue();
        expect(requests, 1);
        expect(handle.failure, isNull);
      },
    );
  }

  test('downloads retain the default one-shot status policy', () async {
    var requests = 0;
    final server = await FakeTlsServer.start((r) async {
      requests++;
      r.response.statusCode = 502;
      await r.response.close();
    });
    addTearDown(server.close);
    final authority = await mediaAuthority(server.origin);
    await expectLater(
      ProtectedMediaFetcher(
        authority: authority,
        securityContext: server.clientContext,
      ).open(nativeMedia(authority, path: leasePath), authority.requireFence()),
      throwsA(
        isA<AppFailure>()
            .having((e) => e.statusCode, 'status', 502)
            .having((e) => e.retryable, 'default retryable', false),
      ),
    );
    expect(requests, 1);
  });
}
