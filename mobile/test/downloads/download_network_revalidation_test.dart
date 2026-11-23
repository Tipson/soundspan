import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/core/network/dart_api_transport.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/playback/playback_resolver.dart';
import 'package:soundspan/downloads/download_coordinator.dart';
import 'package:soundspan/downloads/download_models.dart';

import 'download_fixture.dart';
import '../support/media_fixtures.dart';

const restricted = AppFailure(
  code: 'download_network_restricted',
  message: 'Загрузка ожидает подходящую сеть.',
  retryable: true,
);

DownloadCoordinator guarded(
  DownloadHarness h,
  Future<void> Function(DeviceDownload) validate,
) => DownloadCoordinator(
  repository: h.repo,
  resolverForQuality: h.runner.resolverForQuality,
  fetcher: h.runner.fetcher,
  networkPolicy: const NetworkPolicy.online(),
  revalidateNetwork: validate,
);

void main() {
  late DownloadHarness h;
  setUp(() async => h = await DownloadHarness.create());
  tearDown(() async => h.close());

  test(
    'headless admission rejects restricted route before any audio request',
    () async {
      final job = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
      );
      final runner = guarded(h, (claim) async {
        expect(claim.id, job.id);
        expect(claim.originalFence, job.originalFence);
        expect(claim.generation, job.generation);
        throw restricted;
      });
      addTearDown(runner.close);
      expect(
        await runner.run(job.id, job.originalFence, job.generation),
        DownloadRunResult.retry,
      );
      expect(h.requests, isEmpty);
      final latest = (await h.repo.status(job.id, job.originalFence))!;
      expect(latest.state, isNot(DownloadState.ready));
      expect(latest.errorCode, restricted.code);
      expect(latest.writer, isNull);
    },
  );

  test(
    'route change after upstream response cannot commit received bytes ready',
    () async {
      var allowed = true;
      h.handler = (request) async {
        allowed = false;
        await h.send(request);
      };
      final job = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
      );
      final runner = guarded(h, (_) async {
        if (!allowed) throw restricted;
      });
      addTearDown(runner.close);
      expect(
        await runner.run(job.id, job.originalFence, job.generation),
        DownloadRunResult.retry,
      );
      expect(h.requests, hasLength(1));
      final latest = (await h.repo.status(job.id, job.originalFence))!;
      expect(latest.state, isNot(DownloadState.ready));
      expect(latest.bytes, 0);
      expect(
        await h.repo.openReady(job.track.ref, job.quality, job.originalFence),
        isNull,
      );
    },
  );

  test('a valid route retains verified bytes and the same recording', () async {
    final job = await h.repo.enqueue(
      DownloadHarness.track,
      'original',
      h.fence,
    );
    final identities = <String>{};
    final runner = guarded(h, (claim) async {
      identities.add(claim.track.ref.identityKey);
    });
    addTearDown(runner.close);
    expect(
      await runner.run(job.id, job.originalFence, job.generation),
      DownloadRunResult.ready,
    );
    expect(identities, {job.track.ref.identityKey});
    expect(h.requests, hasLength(1));
    expect(
      await h.repo.openReady(job.track.ref, job.quality, job.originalFence),
      isNotNull,
    );
  });

  test('a native route-loss signal aborts a pending transfer and releases its claim', () async {
    final received = Completer<void>(), release = Completer<void>();
    h.handler = (request) async {
      received.complete();
      await release.future;
      await h.send(request);
    };
    final job = await h.repo.enqueue(
      DownloadHarness.track,
      'original',
      h.fence,
    );
    final runner = guarded(h, (_) async {});
    addTearDown(runner.close);
    final running = runner.run(job.id, job.originalFence, job.generation);
    try {
      await received.future.timeout(const Duration(seconds: 2));
      runner.cancelNetworkTransfers();
      expect(
        await running.timeout(const Duration(seconds: 2)),
        DownloadRunResult.cancelled,
      );
      final current = (await h.repo.status(job.id, job.originalFence))!;
      expect(current.state, DownloadState.paused);
      expect(current.writer, isNull);
      expect(h.requests, hasLength(1));
    } finally {
      release.complete();
    }
  });

  test(
    'route deferral retries later without converting it into a manual pause',
    () async {
      final received = Completer<void>(), release = Completer<void>();
      h.handler = (request) async {
        received.complete();
        await release.future;
        await h.send(request);
      };
      final job = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
      );
      final runner = guarded(h, (_) async {});
      addTearDown(runner.close);
      final running = runner.run(job.id, job.originalFence, job.generation);
      try {
        await received.future.timeout(const Duration(seconds: 2));
        runner.cancelNetworkTransfers(retryWhenAllowed: true);
        expect(
          await running.timeout(const Duration(seconds: 2)),
          DownloadRunResult.retry,
        );
        final current = (await h.repo.status(job.id, job.originalFence))!;
        expect(current.state, DownloadState.failed);
        expect(current.errorCode, 'download_network_restricted');
        expect(current.writer, isNull);
        h.handler = null;
        expect(
          await runner.run(job.id, job.originalFence, job.generation),
          DownloadRunResult.ready,
        );
      } finally {
        release.complete();
      }
    },
  );

  test('route deferral aborts a pending native resolver instead of waiting for its deadline', () async {
    final received = Completer<void>(), release = Completer<void>();
    h.handler = (request) async {
      await request.drain<void>();
      request.response.headers.contentType = ContentType.json;
      request.response.write('{');
      await request.response.flush();
      received.complete();
      await release.future;
      await request.response.close();
    };
    final client = DartJsonHttpClient(securityContext: h.server.clientContext);
    final runner = DownloadCoordinator(
      repository: h.repo,
      resolverForQuality: (quality) => PlaybackResolver(
        authority: h.authority,
        transport: DartApiTransport(client: client, authority: h.authority),
      ),
      fetcher: h.runner.fetcher,
      networkPolicy: const NetworkPolicy.online(),
    );
    addTearDown(runner.close);
    final job = await h.repo.enqueue(
      Track(ref: recordingRef, title: 'Native', artist: 'Exact'),
      'original',
      h.fence,
    );
    final pending = runner.run(job.id, h.fence, job.generation);
    try {
      await received.future.timeout(const Duration(seconds: 2));
      runner.cancelNetworkTransfers(retryWhenAllowed: true);
      expect(
        await pending.timeout(const Duration(seconds: 2)),
        DownloadRunResult.retry,
      );
      expect((await h.repo.status(job.id, h.fence))!.writer, isNull);
      expect(h.requests, hasLength(1));
    } finally {
      release.complete();
      await client.close();
    }
  });

  test(
    'route loss after complete bytes does not cancel local verification',
    () async {
      final verifying = Completer<void>(), release = Completer<void>();
      var allowed = true;
      h.probe.before = () async {
        verifying.complete();
        await release.future;
      };
      final job = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
      );
      final runner = guarded(h, (_) async {
        if (!allowed) throw restricted;
      });
      addTearDown(runner.close);
      final running = runner.run(job.id, job.originalFence, job.generation);
      await verifying.future.timeout(const Duration(seconds: 2));
      allowed = false;
      runner.cancelNetworkTransfers();
      release.complete();
      expect(await running, DownloadRunResult.ready);
      h.probe.before = null;
      expect(
        await h.repo.openReady(job.track.ref, job.quality, job.originalFence),
        isNotNull,
      );
      expect(h.requests, hasLength(1));
    },
  );
}
