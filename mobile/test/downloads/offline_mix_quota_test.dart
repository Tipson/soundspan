import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/downloads/download_models.dart';
import 'package:soundspan/downloads/download_repository.dart';
import 'package:soundspan/downloads/offline_mix_quota.dart';
import 'package:soundspan/features/downloads/storage_status_card.dart';

import 'download_fixture.dart';

void main() {
  const mib = 1024 * 1024;
  const auto = DownloadOrigin.offlineMix;
  Future<DeviceDownload> claimed(DownloadHarness h, String id) async {
    final job = await h.repo.enqueue(
      Track(ref: LibraryTrackRef(id), title: id, artist: 'Test'),
      'original',
      h.fence,
      origin: auto,
    );
    return (await h.repo.claim(job.id, h.fence, job.generation))!;
  }

  test(
    'default quota is bounded and malformed or future policy fails closed',
    () async {
      final h = await DownloadHarness.create();
      addTearDown(h.close);
      final quota = OfflineMixQuota(repository: h.repo, fence: h.fence);
      expect((await quota.usage()).limitBytes, 1024 * mib);
      await h.store.transaction(
        h.fence,
        (tx) => tx.write(OfflineMixQuota.policyNamespace, 'control', {
          'version': 2,
          'maxBytes': 16 * mib,
        }),
      );
      await expectLater(quota.usage(), throwsA(isA<FormatException>()));
    },
  );
  test('two worker instances reserve one shared budget atomically', () async {
    final h = await DownloadHarness.create();
    addTearDown(h.close);
    final a = OfflineMixQuota(repository: h.repo, fence: h.fence);
    final b = OfflineMixQuota(repository: h.repo, fence: h.fence);
    await a.setLimit(16 * mib);
    final first = await claimed(h, 'one');
    final second = await claimed(h, 'two');
    await Future.wait([a.reserveWrite(first, 1), b.reserveWrite(second, 1)]);
    expect((await a.usage()).usedBytes, 16 * mib);
    await expectLater(
      a.reserveWrite(first, 9 * mib),
      throwsA(
        isA<AppFailure>().having(
          (x) => x.code,
          'code',
          'offline_mix_quota_exceeded',
        ),
      ),
    );
    expect((await b.usage()).usedBytes, 16 * mib);
  });
  test('legacy file bytes are measured before accounting and manual files stay exempt', () async {
    final h = await DownloadHarness.create();
    addTearDown(h.close);
    final job = await claimed(h, 'legacy-part');
    final cp = job.files.single;
    final file = await h.paths.file(
      h.fence.owner,
      job.id,
      cp.generation,
      cp.claim,
    );
    await file.writeAsBytes(List.filled(4096, 0));
    final quota = OfflineMixQuota(repository: h.repo, fence: h.fence);
    expect((await quota.usage()).usedBytes, 4096);
    final manual = await h.repo.enqueue(
      DownloadHarness.track,
      'original',
      h.fence,
    );
    expect(
      await h.runner.run(manual.id, h.fence, manual.generation),
      DownloadRunResult.ready,
    );
    expect((await quota.usage()).usedBytes, 4096);
    expect(
      await h.repo.openReady(manual.track.ref, 'original', h.fence),
      isNotNull,
    );
  });
  test('coarse reservations survive restart, and vanished inventory is released only after finalization', () async {
    final h = await DownloadHarness.create();
    addTearDown(h.close);
    final first = await claimed(h, 'one');
    var quota = OfflineMixQuota(repository: h.repo, fence: h.fence);
    await quota.reserveWrite(first, 4096);
    quota = OfflineMixQuota(repository: h.repo, fence: h.fence);
    expect((await quota.usage()).usedBytes, 8 * mib);
    await h.repo.cancel(first.id, h.fence);
    expect((await quota.usage()).usedBytes, 8 * mib);
    // Models the post-unlink inventory contract; reader/eviction tests exercise
    // the repository finalizer itself. No quota code may delete these files.
    await h.store.transaction(h.fence, (tx) async {
      final row = (await tx.read(DownloadRepository.namespace, first.id))!;
      await tx.write(DownloadRepository.namespace, first.id, {
        ...row,
        'files': <Object?>[],
        'checkpoint': null,
      });
    });
    expect((await quota.usage()).usedBytes, 0);
  });
  test('quota eviction callback is outside SQL and absence of eligible files fails safely', () async {
    final h = await DownloadHarness.create();
    addTearDown(h.close);
    final ready = await h.repo.enqueue(
      DownloadHarness.track,
      'original',
      h.fence,
      origin: auto,
    );
    expect(
      await h.runner.run(ready.id, h.fence, ready.generation),
      DownloadRunResult.ready,
    );
    final saved = (await h.repo.openReady(
      ready.track.ref,
      'original',
      h.fence,
    ))!;
    var attempted = 0;
    final quota = OfflineMixQuota(
      repository: h.repo,
      fence: h.fence,
      evict: (candidate) async {
        attempted++;
        // A nested transaction would deadlock if callback ran inside admission.
        expect(await h.repo.status(candidate.id, h.fence), isNotNull);
        return false; // An active/previous snapshot protects this captured file.
      },
    );
    await quota.setLimit(16 * mib);
    final first = await claimed(h, 'next');
    await expectLater(
      quota.reserveWrite(first, 16 * mib),
      throwsA(isA<AppFailure>()),
    );
    expect(attempted, 1);
    expect(await saved.exists(), isTrue);
    expect(
      await h.repo.openReady(ready.track.ref, 'original', h.fence),
      isNotNull,
    );
  });
  test(
    'retired owner cannot change quota or reserve a different worker claim',
    () async {
      final h = await DownloadHarness.create();
      addTearDown(h.close);
      final first = await claimed(h, 'one');
      final quota = OfflineMixQuota(repository: h.repo, fence: h.fence);
      await quota.reserveWrite(first, 1);
      await h.authority.invalidate();
      await expectLater(
        quota.reserveWrite(first, 2),
        throwsA(isA<AppFailure>()),
      );
      await expectLater(quota.setLimit(16 * mib), throwsA(isA<AppFailure>()));
    },
  );
  test('actual writer reserves before IO and settles unused grant only after completion', () async {
    final h = await DownloadHarness.create();
    addTearDown(h.close);
    final quota = OfflineMixQuota(repository: h.repo, fence: h.fence);
    int? firstGrant;
    var drained = 0;
    final runner = h.newRunner(
      h.repo,
      reserveWrite: (claim, size) async {
        await quota.reserveWrite(claim, size);
        firstGrant ??= (await quota.usage()).usedBytes;
      },
      onWriterDrained: (claim) async {
        drained++;
        await quota.writerDrained(claim);
      },
    );
    addTearDown(runner.close);
    final job = await h.repo.enqueue(
      DownloadHarness.track,
      'original',
      h.fence,
      origin: auto,
    );
    expect(
      await runner.run(job.id, h.fence, job.generation),
      DownloadRunResult.ready,
    );
    expect(firstGrant, 8 * mib);
    expect(drained, 1);
    expect((await quota.usage()).usedBytes, wavBytes().length);
  });
  test(
    'drained accounting failure cannot turn a ready file into a new download',
    () async {
      final h = await DownloadHarness.create();
      addTearDown(h.close);
      var called = false;
      final runner = h.newRunner(
        h.repo,
        onWriterDrained: (_) async {
          called = true;
          throw StateError('quota SQL unavailable');
        },
      );
      addTearDown(runner.close);
      final job = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
      );
      expect(
        await runner.run(job.id, h.fence, job.generation),
        DownloadRunResult.ready,
      );
      expect(called, isTrue);
      expect(
        await h.repo.openReady(job.track.ref, 'original', h.fence),
        isNotNull,
      );
      expect(h.requests, hasLength(1));
    },
  );
  test(
    'a completed file recovers unused reservation after a missed drain receipt',
    () async {
      final h = await DownloadHarness.create();
      addTearDown(h.close);
      final quota = OfflineMixQuota(repository: h.repo, fence: h.fence);
      final runner = h.newRunner(h.repo, reserveWrite: quota.reserveWrite);
      addTearDown(runner.close);
      final job = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
        origin: auto,
      );
      expect(
        await runner.run(job.id, h.fence, job.generation),
        DownloadRunResult.ready,
      );
      final ready = (await h.repo.status(job.id, h.fence))!;
      final cp = ready.checkpoint!;
      await h.store.transaction(
        h.fence,
        (tx) => tx.write(
          OfflineMixQuota.ledgerNamespace,
          '${job.id}:${cp.generation}:${cp.claim}',
          {
            'version': 1,
            'id': job.id,
            'generation': cp.generation,
            'claim': cp.claim,
            'bytes': 8 * mib,
          },
        ),
      );
      final reopened = OfflineMixQuota(repository: h.repo, fence: h.fence);
      expect((await reopened.usage()).usedBytes, wavBytes().length);
    },
  );
  test(
    'quota failure points to its setting instead of a generic transfer error',
    () async {
      final h = await DownloadHarness.create();
      addTearDown(h.close);
      final job = await claimed(h, 'status');
      final status = downloadStatus(
        job.patch({
          'state': 'failed',
          'errorCode': 'offline_mix_quota_exceeded',
        }),
      ).toLowerCase();
      expect(status, contains('лимит'));
      expect(status, contains('настройк'));
    },
  );
  test('real eligible eviction finalizes inventory before granting its freed budget', () async {
    final h = await DownloadHarness.create();
    addTearDown(h.close);
    final old = await h.repo.enqueue(
      DownloadHarness.track,
      'original',
      h.fence,
      origin: auto,
    );
    expect(
      await h.runner.run(old.id, h.fence, old.generation),
      DownloadRunResult.ready,
    );
    final file = (await h.repo.openReady(old.track.ref, 'original', h.fence))!;
    final quota = OfflineMixQuota(
      repository: h.repo,
      fence: h.fence,
      evict: (job) => h.repo.evictIfUnprotected(job, h.fence),
    );
    await quota.setLimit(16 * mib);
    final next = await claimed(h, 'replacement');
    await quota.reserveWrite(next, 16 * mib);
    expect(await file.exists(), isFalse);
    final finalized = (await h.repo.status(old.id, h.fence))!;
    expect(finalized.files, isEmpty);
    expect(finalized.checkpoint, isNull);
    expect((await quota.usage()).usedBytes, 16 * mib);
  });
  test(
    'a missed deletion finalization is recovered before quota admission',
    () async {
      final h = await DownloadHarness.create();
      addTearDown(h.close);
      final old = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
        origin: auto,
      );
      expect(
        await h.runner.run(old.id, h.fence, old.generation),
        DownloadRunResult.ready,
      );
      final quota = OfflineMixQuota(
        repository: h.repo,
        fence: h.fence,
        recover: () => h.repo.recoverRemovals(h.fence),
      );
      await quota.setLimit(16 * mib);
      expect((await quota.usage()).usedBytes, wavBytes().length);
      h.store.failState = 'deleted';
      final captured = (await h.repo.status(old.id, h.fence))!;
      await expectLater(
        h.repo.evictIfUnprotected(captured, h.fence),
        throwsA(isA<Exception>()),
      );
      h.store.failState = null;
      expect((await h.repo.status(old.id, h.fence))!.files, isNotEmpty);
      final next = await claimed(h, 'replacement');
      await quota.reserveWrite(next, 16 * mib);
      expect((await h.repo.status(old.id, h.fence))!.files, isEmpty);
      expect((await quota.usage()).usedBytes, 16 * mib);
    },
  );
}
