import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/network/dart_api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/downloads/download_coordinator.dart';
import 'package:soundspan/downloads/download_models.dart';
import 'package:soundspan/downloads/download_repository.dart';
import 'package:soundspan/downloads/download_verifier.dart';
import 'package:soundspan/downloads/private_media_paths.dart';
import 'package:soundspan/downloads/protected_media_fetcher.dart';
import 'package:soundspan/playback/playback_resolver.dart';

import '../support/auth_fakes.dart';
import '../support/fake_tls_server.dart';
import '../support/media_fixtures.dart';
import 'download_fixture.dart';

void main() {
  const track = Track(
    ref: LibraryTrackRef('local1'),
    title: 'Тест',
    artist: 'Автор',
  );
  Future<void> scenario(
    Future<void> Function(
      DownloadRepository,
      DownloadCoordinator,
      DownloadTestStore,
      WavProbe,
      FakeTlsServer,
      List<String?>,
    )
    check, {
    List<int>? bytes,
    NetworkPolicy network = const NetworkPolicy.online(),
  }) async {
    final requests = <String?>[];
    final payload = bytes ?? wavBytes();
    final server = await FakeTlsServer.start((request) async {
      requests.add(request.headers.value('range'));
      request.response.headers.set('content-type', 'audio/wav');
      request.response.headers.set('etag', '"v1"');
      request.response.contentLength = payload.length;
      request.response.add(payload);
      await request.response.close();
    });
    final authority = await mediaAuthority(server.origin);
    final store = DownloadTestStore(authority);
    final root = await Directory.systemTemp.createTemp('t07-');
    final paths = await PrivateMediaPaths.create(root);
    final probe = WavProbe();
    final repo = DownloadRepository(
      store: store,
      authority: authority,
      paths: paths,
      verifier: DownloadVerifier(probe: probe),
      beforeRemove: (_) async {},
    );
    final coordinator = DownloadCoordinator(
      repository: repo,
      resolverForQuality: (quality) => PlaybackResolver(
        authority: authority,
        transport: DartApiTransport(
          authority: authority,
          client: ScriptedJsonClient(
            (_, _) => throw StateError('unexpected JSON'),
          ),
        ),
        quality: quality,
      ),
      fetcher: ProtectedMediaFetcher(
        authority: authority,
        securityContext: server.clientContext,
      ),
      networkPolicy: network,
    );
    try {
      await check(repo, coordinator, store, probe, server, requests);
    } finally {
      await coordinator.close();
      await server.close();
      await authority.invalidate();
      await root.delete(recursive: true);
    }
  }

  test(
    'duplicate enqueue and workers share one durable verified file',
    () async {
      await scenario((repo, runner, store, probe, server, requests) async {
        final fence = repo.authority.requireFence();
        final jobs = await Future.wait([
          repo.enqueue(track, 'original', fence, manual: false),
          repo.enqueue(track, 'original', fence),
        ]);
        expect(jobs[0].id, jobs[1].id);
        expect((await repo.status(jobs[0].id, fence))!.manual, true);
        await Future.wait(
          jobs.map((j) => runner.run(j.id, fence, j.generation)),
        );
        final ready = (await repo.status(jobs[0].id, fence))!;
        expect(ready.state, DownloadState.ready);
        expect(requests.length, 1);
        final file = (await repo.openReady(track.ref, 'original', fence))!;
        expect(await file.readAsBytes(), wavBytes());
        expect(ready.sha256, sha256.convert(wavBytes()).toString());
        await file.writeAsBytes([0, 1, 2]);
        expect(await repo.openReady(track.ref, 'original', fence), isNull);
      });
    },
  );
  for (final bytes in [
    <int>[],
    List<int>.filled(128, 0),
    [60, 104, 116, 109, 108, 62],
    wavBytes().sublist(0, 100),
  ]) {
    test('invalid complete body ${bytes.length} is not ready', () async {
      await scenario((repo, runner, store, probe, server, requests) async {
        final f = repo.authority.requireFence();
        final j = await repo.enqueue(track, 'original', f);
        await runner.run(j.id, f, j.generation);
        expect((await repo.status(j.id, f))!.state, DownloadState.failed);
        expect(await repo.openReady(track.ref, 'original', f), isNull);
      }, bytes: bytes);
    });
  }
  test(
    'offline admission and cancelled generation perform zero HTTP',
    () async {
      await scenario((repo, runner, store, probe, server, requests) async {
        final f = repo.authority.requireFence();
        final j = await repo.enqueue(track, 'original', f);
        await runner.run(j.id, f, j.generation);
        expect(requests, isEmpty);
        await repo.cancel(j.id, f);
        await runner.run(j.id, f, j.generation);
        expect(requests, isEmpty);
      }, network: const NetworkPolicy.offline());
    },
  );
  test(
    'cancel in probe cannot publish and new generation can complete',
    () async {
      await scenario((repo, runner, store, probe, server, requests) async {
        final f = repo.authority.requireFence();
        final j = await repo.enqueue(track, 'original', f);
        probe.before = () async {
          await repo.cancel(j.id, f);
        };
        await runner.run(j.id, f, j.generation);
        expect(await repo.openReady(track.ref, 'original', f), isNull);
        probe.before = null;
        final retry = await repo.retry(j.id, f);
        await runner.run(retry.id, f, retry.generation);
        expect(await repo.openReady(track.ref, 'original', f), isNotNull);
      });
    },
  );
  test('failed ready SQL commit never exposes finalized orphan', () async {
    await scenario((repo, runner, store, probe, server, requests) async {
      final f = repo.authority.requireFence();
      final j = await repo.enqueue(track, 'original', f);
      store.failState = 'ready';
      await runner.run(j.id, f, j.generation);
      expect(await repo.openReady(track.ref, 'original', f), isNull);
      store.failState = null;
      final retry = await repo.retry(j.id, f);
      await runner.run(retry.id, f, retry.generation);
      expect(await repo.openReady(track.ref, 'original', f), isNotNull);
    });
  });
}
