import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/downloads/download_models.dart';

import 'download_fixture.dart';

void main() {
  for (final command in ['pause', 'resume', 'retry', 'cancel', 'remove']) {
    test(
      '$command ignores an intent captured before a replacement generation',
      () async {
        final h = await DownloadHarness.create();
        addTearDown(h.close);
        final first = await h.repo.enqueue(
          DownloadHarness.track,
          'original',
          h.fence,
        );
        final latest = await h.repo.retry(first.id, h.fence);
        var releases = 0;
        h.beforeRemove = (_) async {
          releases++;
        };
        final dynamic repo = h.repo;
        switch (command) {
          case 'pause':
            await repo.pause(
              first.id,
              h.fence,
              expectedGeneration: first.generation,
            );
          case 'resume':
            await repo.resume(
              first.id,
              h.fence,
              expectedGeneration: first.generation,
            );
          case 'retry':
            await repo.retry(
              first.id,
              h.fence,
              expectedGeneration: first.generation,
            );
          case 'cancel':
            await repo.cancel(
              first.id,
              h.fence,
              expectedGeneration: first.generation,
            );
          case 'remove':
            await repo.remove(
              first.id,
              h.fence,
              expectedGeneration: first.generation,
            );
        }
        final retained = await h.repo.status(first.id, h.fence);
        expect(retained!.toJson(), latest.toJson());
        expect(releases, 0);
        expect(h.requests, isEmpty);
      },
    );
  }

  test(
    'unlike cancellation cannot cancel a same-generation manual promotion',
    () async {
      final h = await DownloadHarness.create();
      addTearDown(h.close);
      final automatic = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
        manual: false,
      );
      final promoted = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
      );
      expect(promoted.generation, automatic.generation);
      final dynamic repo = h.repo;
      expect(
        await repo.cancel(
          automatic.id,
          h.fence,
          expectedGeneration: automatic.generation,
          automaticOnly: true,
        ),
        isFalse,
      );
      expect(
        (await h.repo.status(automatic.id, h.fence))!.toJson(),
        promoted.toJson(),
      );
      expect(h.requests, isEmpty);
    },
  );

  test('matching automatic generation can be cancelled without deleting ready music', () async {
    final h = await DownloadHarness.create();
    addTearDown(h.close);
    final automatic = await h.repo.enqueue(
      DownloadHarness.track,
      'original',
      h.fence,
      manual: false,
    );
    final dynamic repo = h.repo;
    expect(
      await repo.cancel(
        automatic.id,
        h.fence,
        expectedGeneration: automatic.generation,
        automaticOnly: true,
      ),
      isTrue,
    );
    final paused = (await h.repo.status(automatic.id, h.fence))!;
    expect(paused.state, DownloadState.paused);
    expect(paused.errorCode, 'download_cancelled');
    expect(paused.generation, automatic.generation + 1);
    final next = await h.repo.retry(automatic.id, h.fence);
    await h.runner.run(next.id, h.fence, next.generation);
    final ready = (await h.repo.status(next.id, h.fence))!;
    expect(
      await repo.cancel(
        ready.id,
        h.fence,
        expectedGeneration: ready.generation,
        automaticOnly: true,
      ),
      isFalse,
    );
    expect((await h.repo.status(ready.id, h.fence))!.toJson(), ready.toJson());
    expect(
      await h.repo.openReady(ready.track.ref, ready.quality, h.fence),
      isNotNull,
    );
  });
}
