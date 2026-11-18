import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/downloads/download_models.dart';
import 'package:soundspan/downloads/download_repository.dart';
import 'package:soundspan/downloads/device_media_barrier.dart';
import 'package:soundspan/downloads/offline_mix_repository.dart';
import 'package:soundspan/features/home/home_models.dart';

import 'download_fixture.dart';
import 'download_manifest_reservation_test.dart' show HeldRemovalStore;

void main() {
  late DownloadHarness h;
  late OfflineMixRepository offline;
  setUp(() async {
    h = await DownloadHarness.create();
    offline = OfflineMixRepository(downloads: h.repo, fence: h.fence);
  });
  tearDown(() => h.close());
  Future<DeviceDownload> ready([Track track = DownloadHarness.track]) async {
    final job = await h.repo.enqueue(
      track,
      'original',
      h.fence,
      manual: false,
      origin: DownloadOrigin.offlineMix,
    );
    expect(
      await h.runner.run(job.id, h.fence, job.generation),
      DownloadRunResult.ready,
    );
    return (await h.repo.status(job.id, h.fence))!;
  }

  MusicMix mix(Track track) => MusicMix(
    id: track.ref.identityKey,
    title: 'Mix',
    description: '',
    kind: MusicMixKind.daily,
    tracks: [track],
    loaded: true,
  );
  Future<int> install(Track track) async {
    final staged = await offline.stage(mix(track));
    expect(await offline.bind(staged.generation, [await ready(track)]), isTrue);
    expect(await offline.commit(staged.generation), isTrue);
    return staged.generation;
  }

  const second = Track(
    ref: LibraryTrackRef('second-retained'),
    title: 'Second',
    artist: 'Fixture',
  );
  const third = Track(
    ref: LibraryTrackRef('third-retained'),
    title: 'Third',
    artist: 'Fixture',
  );

  test('durable exact readers protect across repositories, clock expiry and idempotent release', () async {
    final captured = await ready();
    final first = (await h.repo.acquireReady(
      captured.track.ref,
      captured.quality,
      h.fence,
    ))!;
    final cold = h.newRepository();
    final second = (await cold.acquireReady(
      captured.track.ref,
      captured.quality,
      h.fence,
    ))!;
    expect(await cold.evictIfUnprotected(captured, h.fence), isFalse);
    await first.release();
    await first.release();
    h.currentTime = h.currentTime.add(const Duration(days: 365));
    expect(
      await h.newRepository().evictIfUnprotected(captured, h.fence),
      isFalse,
    );
    expect(await second.file.exists(), isTrue);
    await second.release();
    expect(await cold.evictIfUnprotected(captured, h.fence), isTrue);
    expect(await second.file.exists(), isFalse);
    final removed = (await h.repo.status(captured.id, h.fence))!;
    expect(removed.files, isEmpty);
    expect(removed.checkpoint, isNull);
  });

  test('presence checks do not acquire a playback reservation', () async {
    final captured = await ready();
    expect(
      await h.repo.openReady(captured.track.ref, captured.quality, h.fence),
      isNotNull,
    );
    expect(await h.repo.evictIfUnprotected(captured, h.fence), isTrue);
  });

  test('a reader is durable before its verification await returns', () async {
    final captured = await ready();
    final held = HeldRemovalStore(h.store, onReader: true);
    final readerRepo = DownloadRepository(
      store: held,
      authority: h.authority,
      paths: h.paths,
      verifier: h.repo.verifier,
      beforeRemove: (_) async {},
    );
    final acquiring = readerRepo.acquireReady(
      captured.track.ref,
      captured.quality,
      h.fence,
    );
    try {
      await held.entered.future;
      expect(
        await h.newRepository().evictIfUnprotected(captured, h.fence),
        isFalse,
      );
      held.release.complete();
      final reader = (await acquiring)!;
      expect(await reader.file.exists(), isTrue);
      await reader.release();
      expect(await h.repo.evictIfUnprotected(captured, h.fence), isTrue);
    } finally {
      if (!held.release.isCompleted) held.release.complete();
      await acquiring;
    }
  });

  test(
    'failed verification releases its reservation without deleting media',
    () async {
      final captured = await ready();
      final file = (await h.repo.openReady(
        captured.track.ref,
        captured.quality,
        h.fence,
      ))!;
      await file.writeAsBytes([1, 2, 3]);
      expect(
        await h.repo.acquireReady(
          captured.track.ref,
          captured.quality,
          h.fence,
        ),
        isNull,
      );
      expect(await file.exists(), isTrue);
      expect(
        await h.store.transaction(
          h.fence,
          (tx) => tx.list(DeviceMediaBarrier.namespace),
        ),
        isEmpty,
      );
    },
  );

  test(
    'unknown barrier schema is protected instead of being treated as no reader',
    () async {
      final captured = await ready();
      await h.store.transaction(
        h.fence,
        (tx) => tx.write(
          DeviceMediaBarrier.namespace,
          DeviceMediaBarrier.key(captured.id, captured.checkpoint!),
          {'version': 2},
        ),
      );
      expect(await h.repo.evictIfUnprotected(captured, h.fence), isFalse);
      expect(
        (await h.repo.status(captured.id, h.fence))!.state,
        DownloadState.ready,
      );
    },
  );

  test('a noninteger barrier version cannot authorize eviction', () async {
    final captured = await ready();
    await h.store.transaction(
      h.fence,
      (tx) => tx.write(
        DeviceMediaBarrier.namespace,
        DeviceMediaBarrier.key(captured.id, captured.checkpoint!),
        {
          'version': 1.0,
          'downloadId': captured.id,
          'file': captured.checkpoint!.toJson(),
          'state': 'available',
          'readers': <String, Object?>{},
          'removal': null,
        },
      ),
    );
    expect(await h.repo.evictIfUnprotected(captured, h.fence), isFalse);
    expect(
      (await h.repo.status(captured.id, h.fence))!.state,
      DownloadState.ready,
    );
  });

  test(
    'manual promotion after scan protects without changing generation',
    () async {
      final captured = await ready();
      expect(
        await h.repo.pinReadyIfCurrent(
          captured.id,
          h.fence,
          expectedGeneration: captured.generation,
        ),
        isTrue,
      );
      expect(
        (await h.repo.status(captured.id, h.fence))!.generation,
        captured.generation,
      );
      expect(await h.repo.evictIfUnprotected(captured, h.fence), isFalse);
      expect(
        await h.repo.openReady(captured.track.ref, captured.quality, h.fence),
        isNotNull,
      );
    },
  );

  for (final origin in ['liked', 'legacy', 'futureOrigin']) {
    test('$origin origin is never an automatic eviction candidate', () async {
      final captured = await ready();
      await h.store.transaction(h.fence, (tx) async {
        final row = await tx.read(DownloadRepository.namespace, captured.id);
        await tx.write(DownloadRepository.namespace, captured.id, {
          ...row!,
          'origins': [origin],
        });
      });
      final current = (await h.repo.status(captured.id, h.fence))!;
      expect(await h.repo.evictIfUnprotected(current, h.fence), isFalse);
    });
  }

  test(
    'unbound pending, active and previous manifests protect the whole download',
    () async {
      final captured = await ready();
      final staged = await offline.stage(mix(captured.track));
      expect(await h.repo.evictIfUnprotected(captured, h.fence), isFalse);
      expect(await offline.bind(staged.generation, [captured]), isTrue);
      expect(await offline.commit(staged.generation), isTrue);
      expect(await h.repo.evictIfUnprotected(captured, h.fence), isFalse);
      await install(second);
      expect(await h.repo.evictIfUnprotected(captured, h.fence), isFalse);
      await install(third);
      expect(await h.repo.evictIfUnprotected(captured, h.fence), isTrue);
    },
  );

  test('a frozen historical reader protects its old claim after the manifest rotates away', () async {
    final generation = await install(DownloadHarness.track);
    final old = (await h.repo.list(h.fence)).single;
    final reader = (await offline.acquireVerifiedFile(
      generation,
      old.track.ref,
    ))!;
    await h.store.transaction(
      h.fence,
      (tx) => tx.write(
        DownloadRepository.namespace,
        old.id,
        old.patch({
          'generation': old.generation + 1,
          'state': 'failed',
          'checkpoint': null,
          'writer': null,
          'leaseUntil': 0,
        }).toJson(),
      ),
    );
    final retry = await h.repo.resume(
      old.id,
      h.fence,
      expectedGeneration: old.generation + 1,
    );
    h.handler = (r) => h.send(r, bytes: wavBytes(8000));
    expect(
      await h.runner.run(retry.id, h.fence, retry.generation),
      DownloadRunResult.ready,
    );
    h.handler = null;
    final captured = (await h.repo.status(old.id, h.fence))!;
    final newer = (await h.repo.openReady(
      old.track.ref,
      old.quality,
      h.fence,
    ))!;
    expect(newer.uri, isNot(reader.file.uri));
    await install(second);
    await install(third);
    expect(await h.repo.evictIfUnprotected(captured, h.fence), isFalse);
    await reader.release();
    expect(await h.repo.evictIfUnprotected(captured, h.fence), isTrue);
    expect(await reader.file.exists(), isFalse);
    expect(await newer.exists(), isFalse);
  });

  test('finalization removes only admitted file keys when a new writer has completed', () async {
    final captured = await ready();
    final oldFile = (await h.repo.openReady(
      captured.track.ref,
      captured.quality,
      h.fence,
    ))!;
    final held = HeldRemovalStore(h.store);
    final remover = DownloadRepository(
      store: held,
      authority: h.authority,
      paths: h.paths,
      verifier: h.repo.verifier,
      beforeRemove: (_) async =>
          fail('Auto retention must never stop playback'),
    );
    final deleting = remover.evictIfUnprotected(captured, h.fence);
    try {
      await held.entered.future;
      expect(
        await h.repo.acquireReady(
          captured.track.ref,
          captured.quality,
          h.fence,
        ),
        isNull,
      );
      await expectLater(
        offline.stage(mix(captured.track)),
        throwsA(isA<AppFailure>()),
      );
      final newJob = await h.repo.enqueue(
        captured.track,
        captured.quality,
        h.fence,
        manual: true,
      );
      expect(
        await h.runner.run(newJob.id, h.fence, newJob.generation),
        DownloadRunResult.ready,
      );
      final replacement = (await h.repo.status(newJob.id, h.fence))!;
      final newFile = (await h.repo.openReady(
        newJob.track.ref,
        newJob.quality,
        h.fence,
      ))!;
      held.release.complete();
      expect(await deleting, isTrue);
      final finalJob = (await h.repo.status(newJob.id, h.fence))!;
      expect(finalJob.generation, replacement.generation);
      expect(finalJob.origins, replacement.origins);
      expect(finalJob.checkpoint!.claim, replacement.checkpoint!.claim);
      expect(finalJob.files.map((f) => f.claim), [
        replacement.checkpoint!.claim,
      ]);
      expect(await oldFile.exists(), isFalse);
      expect(await newFile.exists(), isTrue);
    } finally {
      if (!held.release.isCompleted) held.release.complete();
      await deleting;
    }
  });

  test('crash after unlink recovers the durable intent and atomically prunes inventory', () async {
    final captured = await ready();
    final file = (await h.repo.openReady(
      captured.track.ref,
      captured.quality,
      h.fence,
    ))!;
    h.store.failState = 'deleted';
    await expectLater(
      h.repo.evictIfUnprotected(captured, h.fence),
      throwsA(isA<FileSystemException>()),
    );
    expect(await file.exists(), isFalse);
    expect((await h.repo.status(captured.id, h.fence))!.files, isNotEmpty);
    h.store.failState = null;
    expect(await h.newRepository().recoverRemovals(h.fence), 1);
    final removed = (await h.repo.status(captured.id, h.fence))!;
    expect(removed.files, isEmpty);
    expect(removed.checkpoint, isNull);
    expect(await h.repo.recoverRemovals(h.fence), 0);
  });
}
