import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/downloads/download_models.dart';

import 'download_fixture.dart';

void main() {
  for (final status in [429, 503]) {
    test(
      '$status holdoff survives coordinator recreation and explicit retry',
      () async {
        final h = await DownloadHarness.create();
        addTearDown(h.close);
        h.handler = (request) async {
          if (h.requests.length == 1) {
            request.response.statusCode = status;
            request.response.headers.set('retry-after', '120');
            await request.response.close();
          } else {
            await h.send(request);
          }
        };
        final job = await h.repo.enqueue(
          DownloadHarness.track,
          'original',
          h.fence,
        );
        expect(
          await h.runner.run(job.id, h.fence, job.generation),
          DownloadRunResult.retry,
        );
        final held = (await h.repo.status(job.id, h.fence))!;
        expect(
          held.toJson()['retryNotBefore'],
          h.currentTime
              .add(const Duration(seconds: 120))
              .millisecondsSinceEpoch,
        );
        final secondRepo = h.newRepository();
        final secondRunner = h.newRunner(secondRepo);
        addTearDown(secondRunner.close);
        final retried = await secondRepo.retry(job.id, h.fence);
        expect(
          await secondRunner.run(job.id, h.fence, retried.generation),
          DownloadRunResult.retry,
        );
        expect(h.requests, hasLength(1));
        expect(
          (await secondRepo.status(job.id, h.fence))!.state,
          DownloadState.queued,
        );
        h.currentTime = h.currentTime.add(const Duration(seconds: 121));
        expect(
          await secondRunner.run(job.id, h.fence, retried.generation),
          DownloadRunResult.ready,
        );
        expect(h.requests, hasLength(2));
      },
    );
  }
}
