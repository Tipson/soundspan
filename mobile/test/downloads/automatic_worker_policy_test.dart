import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/downloads/download_models.dart';

import 'download_fixture.dart';

const _controlNamespace = 'likedDownloadAutomation.v1';
const _nextTrack = Track(
  ref: LibraryTrackRef('second'),
  title: 'Второй',
  artist: 'Автор',
);

void main() {
  Future<void> control(DownloadHarness h, Map<String, Object?> row) =>
      h.store.transaction(
        h.fence,
        (tx) => tx.write(_controlNamespace, 'control', row),
      );

  for (final row in [
    {'version': 1, 'paused': true},
    {'version': 3, 'paused': false},
    {'version': 1, 'paused': 'false'},
  ]) {
    test(
      'queued automatic worker reads durable control $row without UI',
      () async {
        final h = await DownloadHarness.create();
        addTearDown(h.close);
        final job = await h.repo.enqueue(
          DownloadHarness.track,
          'original',
          h.fence,
          manual: false,
        );
        await control(h, row);
        final reopened = h.newRepository();
        final runner = h.newRunner(reopened);
        try {
          expect(
            await runner.run(job.id, h.fence, job.generation),
            DownloadRunResult.cancelled,
          );
          expect(h.requests, isEmpty);
          expect((await reopened.status(job.id, h.fence))!.writer, isNull);
        } finally {
          await runner.close();
        }
      },
    );
  }

  for (final promote in [false, true]) {
    test(
      'paused automation permits ${promote ? 'same-generation manual promotion' : 'manual download'}',
      () async {
        final h = await DownloadHarness.create();
        addTearDown(h.close);
        var job = await h.repo.enqueue(
          DownloadHarness.track,
          'original',
          h.fence,
          manual: !promote,
        );
        final generation = job.generation;
        await control(h, {'version': 1, 'paused': true});
        if (promote) {
          job = await h.repo.enqueue(
            DownloadHarness.track,
            'original',
            h.fence,
          );
        }
        expect(job.generation, generation);
        expect(
          await h.runner.run(job.id, h.fence, job.generation),
          DownloadRunResult.ready,
        );
        expect(h.requests, hasLength(1));
      },
    );
  }

  test(
    'active auto observes pause while cleanup may still release its claim',
    () async {
      final h = await DownloadHarness.create();
      addTearDown(h.close);
      final job = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
        manual: false,
      );
      final claim = (await h.repo.claim(job.id, h.fence, job.generation))!;
      await control(h, {'version': 1, 'paused': true});
      await expectLater(h.repo.assertClaim(claim), throwsA(isA<AppFailure>()));
      await h.repo.updateClaim(
        claim,
        state: DownloadState.paused,
        release: true,
      );
      expect((await h.repo.status(job.id, h.fence))!.writer, isNull);
      expect(h.requests, isEmpty);
    },
  );

  test(
    'current row manual promotion permits an already captured auto claim',
    () async {
      final h = await DownloadHarness.create();
      addTearDown(h.close);
      final job = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
        manual: false,
      );
      final claim = (await h.repo.claim(job.id, h.fence, job.generation))!;
      await control(h, {'version': 1, 'paused': true});
      await h.repo.enqueue(DownloadHarness.track, 'original', h.fence);
      await h.repo.assertClaim(claim);
      await h.repo.heartbeat(claim);
      expect((await h.repo.status(job.id, h.fence))!.manual, isTrue);
    },
  );

  test(
    'headless ENOSPC pauses queued automatic jobs before another HTTP',
    () async {
      final io = FaultMediaIo()..fault = 'full';
      final h = await DownloadHarness.create(io: io);
      addTearDown(h.close);
      final first = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
        manual: false,
      );
      final second = await h.repo.enqueue(
        _nextTrack,
        'original',
        h.fence,
        manual: false,
      );
      await h.runner.run(first.id, h.fence, first.generation);
      expect(
        (await h.repo.status(first.id, h.fence))!.errorCode,
        'download_storage_full',
      );
      expect(
        await h.store.transaction(
          h.fence,
          (tx) => tx.read(_controlNamespace, 'control'),
        ),
        {'version': 2, 'paused': true},
      );
      io.fault = null;
      final reopened = h.newRepository();
      final runner = h.newRunner(reopened);
      try {
        expect(
          await runner.run(second.id, h.fence, second.generation),
          DownloadRunResult.cancelled,
        );
        expect(h.requests, hasLength(1));
        final promoted = await reopened.enqueue(
          _nextTrack,
          'original',
          h.fence,
        );
        expect(
          await runner.run(promoted.id, h.fence, promoted.generation),
          DownloadRunResult.ready,
        );
        expect(h.requests, hasLength(2));
      } finally {
        await runner.close();
      }
    },
  );
}
