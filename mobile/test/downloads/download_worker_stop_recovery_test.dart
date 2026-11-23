import 'dart:async';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/downloads/download_models.dart';
import 'package:soundspan/downloads/download_worker_entrypoint.dart';

import 'download_fixture.dart';

void main() {
  late DownloadHarness h;
  setUp(() async => h = await DownloadHarness.create());
  tearDown(() async => h.close());

  for (final status in [503, 429]) {
    test(
      'HTTP$status retains a claimable same-generation retry and holdoff',
      () async {
        h.handler = (request) async {
          request.response.statusCode = status;
          request.response.headers.set('retry-after', '2');
          await request.response.close();
        };
        final job = await h.repo.enqueue(
          DownloadHarness.track,
          'original',
          h.fence,
          manual: false,
        );
        expect(
          await h.runner.run(job.id, h.fence, job.generation),
          DownloadRunResult.retry,
        );
        final failed = (await h.repo.status(job.id, h.fence))!;
        expect(failed.state, DownloadState.failed);
        expect(failed.writer, isNull);
        expect(failed.retryNotBefore, greaterThan(h.repo.now));
        expect(h.requests, hasLength(1));
        h.handler = null;
        expect(
          await h.runner.run(job.id, h.fence, job.generation),
          DownloadRunResult.retry,
        );
        expect(
          h.requests,
          hasLength(1),
          reason: 'The old server holdoff still prevents HTTP',
        );
        h.currentTime = h.currentTime.add(const Duration(seconds: 3));
        expect(
          await h.runner.run(job.id, h.fence, job.generation),
          DownloadRunResult.ready,
        );
        expect(h.requests, hasLength(2));
        expect(
          (await h.repo.status(job.id, h.fence))!.generation,
          job.generation,
        );
        expect(
          await h.repo.openReady(job.track.ref, job.quality, h.fence),
          isNotNull,
        );
      },
    );
  }

  Future<void> stoppedTransfer({
    required bool retry,
    bool userPause = false,
    bool logout = false,
  }) async {
    final payload = wavBytes(400000);
    final release = Completer<void>();
    h.handler = (request) async {
      request.response.headers.set('content-type', 'audio/wav');
      request.response.headers.set('etag', '"v1"');
      request.response.contentLength = payload.length;
      request.response.add(payload.sublist(0, 256 * 1024));
      await request.response.flush();
      await release.future;
      request.response.add(payload.sublist(256 * 1024));
      await request.response.close();
    };
    final fence = h.fence;
    final job = await h.repo.enqueue(
      DownloadHarness.track,
      'original',
      fence,
      manual: false,
    );
    final runner = h.newRunner(h.repo);
    addTearDown(runner.close);
    final running = runner.run(job.id, fence, job.generation);
    try {
      final deadline = DateTime.now().add(const Duration(seconds: 4));
      while ((await h.repo.status(job.id, fence))!.bytes < 256 * 1024) {
        if (DateTime.now().isAfter(deadline)) {
          fail('No flushed prefix checkpoint');
        }
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }
      if (userPause) {
        await h.repo.pause(job.id, fence, expectedGeneration: job.generation);
      }
      if (logout) await h.authority.invalidate();
      runner.cancelNetworkTransfers(retryWhenAllowed: retry);
      final draining = runner.close(retryWhenAllowed: retry);
      expect(
        await running.timeout(const Duration(seconds: 3)),
        retry && !userPause && !logout
            ? DownloadRunResult.retry
            : DownloadRunResult.cancelled,
      );
      await draining;
      release.complete();
      h.handler = (request) => h.send(request, bytes: payload);
      final replacement = h.newRunner(h.newRepository());
      addTearDown(replacement.close);
      if (logout) {
        expect(
          await replacement.run(job.id, fence, job.generation),
          DownloadRunResult.cancelled,
        );
        expect(h.requests, hasLength(1));
        return;
      }
      final saved = (await h.repo.status(job.id, fence))!;
      expect(saved.writer, isNull);
      expect(saved.checkpoint!.bytes, 256 * 1024);
      expect(saved.generation, job.generation + (userPause ? 1 : 0));
      if (!retry || userPause) {
        expect(saved.state, DownloadState.paused);
        expect(
          await replacement.run(job.id, fence, job.generation),
          DownloadRunResult.cancelled,
        );
        expect(h.requests, hasLength(1));
        return;
      }
      expect(saved.state, DownloadState.failed);
      expect(
        await replacement.run(job.id, fence, job.generation),
        DownloadRunResult.ready,
      );
      expect(h.requests, [null, 'bytes=${256 * 1024}-']);
      expect(h.validators.last, '"v1"');
      final ready = (await h.repo.status(job.id, fence))!;
      expect(ready.generation, job.generation);
      expect(ready.sha256, sha256.convert(payload).toString());
      final file = (await h.repo.openReady(job.track.ref, job.quality, fence))!;
      expect(await file.readAsBytes(), payload);
    } finally {
      if (!release.isCompleted) release.complete();
    }
  }

  test(
    'route deferral survives scheduler drain and resumes the exact checkpoint generation',
    () => stoppedTransfer(retry: true),
  );
  test(
    'notification or unknown cancellation stays paused and does not resume',
    () => stoppedTransfer(retry: false),
  );
  test(
    'a user pause generation wins over a late system retry intent',
    () => stoppedTransfer(retry: true, userPause: true),
  );
  test(
    'logout cannot turn a system retry intent into old-owner HTTP',
    () => stoppedTransfer(retry: true, logout: true),
  );
  for (final explicitCancel in [false, true]) {
    test(
      'scheduler drain fences a held claim; later explicitCancel=$explicitCancel wins',
      () async {
        final job = await h.repo.enqueue(
          DownloadHarness.track,
          'original',
          h.fence,
        );
        final release = Completer<void>();
        h.store.tail = release.future;
        final runner = h.newRunner(h.repo);
        addTearDown(runner.close);
        final pending = runner.run(job.id, h.fence, job.generation);
        final stops = [runner.close(retryWhenAllowed: true)];
        if (explicitCancel) stops.add(runner.close());
        release.complete();
        expect(
          await pending,
          explicitCancel
              ? DownloadRunResult.cancelled
              : DownloadRunResult.retry,
        );
        await Future.wait(stops);
        expect(h.requests, isEmpty);
        final replacement = h.newRunner(h.repo);
        addTearDown(replacement.close);
        expect(
          await replacement.run(job.id, h.fence, job.generation),
          explicitCancel
              ? DownloadRunResult.cancelled
              : DownloadRunResult.ready,
        );
        expect(h.requests.length, explicitCancel ? 0 : 1);
      },
    );
  }
  test(
    'runtime stop signal admits only the closed affirmative scheduler cause',
    () {
      expect(retryDownloadWorkerStop({'retryWhenAllowed': true}), isTrue);
      for (final value in [
        null,
        {},
        {'retryWhenAllowed': false},
        {'retryWhenAllowed': 1},
        {'retryWhenAllowed': 'true'},
        {'retryWhenAllowed': true, 'token': 'secret'},
        ['retryWhenAllowed'],
        {'stopReason': 7},
      ]) {
        expect(retryDownloadWorkerStop(value), isFalse);
      }
    },
  );
}
