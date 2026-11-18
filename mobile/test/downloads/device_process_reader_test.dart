import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/downloads/device_media_barrier.dart';
import 'package:soundspan/downloads/device_process_scope.dart';
import 'package:soundspan/downloads/download_models.dart';
import 'package:soundspan/downloads/download_repository.dart';
import 'package:soundspan/downloads/offline_mix_repository.dart';
import 'package:soundspan/features/home/home_models.dart';

import 'download_fixture.dart';

void main() {
  const token = '11111111-1111-4111-8111-111111111111';
  late DownloadHarness h;
  late DeviceDownload ready;
  setUp(() async {
    h = await DownloadHarness.create();
    final job = await h.repo.enqueue(
      DownloadHarness.track,
      'original',
      h.fence,
      origin: DownloadOrigin.offlineMix,
    );
    expect(
      await h.runner.run(job.id, h.fence, job.generation),
      DownloadRunResult.ready,
    );
    ready = (await h.repo.status(job.id, h.fence))!;
  });
  tearDown(() => h.close());

  Future<void> pin(Object value) => h.store.transaction(
    h.fence,
    (tx) => tx.write(
      DeviceMediaBarrier.namespace,
      DeviceMediaBarrier.key(ready.id, ready.checkpoint!),
      {
        'version': 1,
        'downloadId': ready.id,
        'file': ready.checkpoint!.toJson(),
        'state': 'available',
        'readers': {'a' * 48: value},
        'removal': null,
      },
    ),
  );

  DownloadRepository process(String? value) => DownloadRepository(
    store: h.store,
    authority: h.authority,
    paths: h.paths,
    verifier: h.repo.verifier,
    beforeRemove: (_) async {},
    processScope: DeviceProcessScope.fromNative(value),
  );
  String instance(int n) =>
      '${n.toRadixString(16).padLeft(8, '0')}-1111-4111-8111-111111111111';
  Map<String, Object?> known(String value) => {
    'version': 1,
    'epoch': h.fence.epoch,
    'processInstance': value,
  };
  Future<Map<String, Object?>> readers() =>
      h.store.transaction(h.fence, (tx) async {
        final row = (await tx.read(
          DeviceMediaBarrier.namespace,
          DeviceMediaBarrier.key(ready.id, ready.checkpoint!),
        ))!;
        return Map<String, Object?>.from(row['readers'] as Map);
      });
  Future<void> fullOldProcess() => h.store.transaction(
    h.fence,
    (tx) => tx.write(
      DeviceMediaBarrier.namespace,
      DeviceMediaBarrier.key(ready.id, ready.checkpoint!),
      {
        'version': 1,
        'downloadId': ready.id,
        'file': ready.checkpoint!.toJson(),
        'state': 'available',
        'readers': {
          for (var n = 0; n < 64; n++)
            n.toRadixString(16).padLeft(48, '0'): known(token),
        },
        'removal': null,
      },
    ),
  );

  test('known process metadata remains releasable by exact nonce', () async {
    await pin({'version': 1, 'epoch': h.fence.epoch, 'processInstance': token});
    await h.store.transaction(
      h.fence,
      (tx) =>
          DeviceMediaBarrier.release(tx, ready.id, ready.checkpoint!, 'a' * 48),
    );
    expect(
      await h.store.transaction(
        h.fence,
        (tx) => tx.list(DeviceMediaBarrier.namespace),
      ),
      isEmpty,
    );
  });

  test(
    'future process metadata stays protected while another reader acquires',
    () async {
      await pin({
        'version': 2,
        'epoch': h.fence.epoch,
        'processInstance': token,
      });
      final reader = await h.repo.acquireReady(
        ready.track.ref,
        'original',
        h.fence,
      );
      expect(reader, isNotNull);
      await reader!.release();
      final reserved = await h.store.transaction(
        h.fence,
        (tx) => DeviceMediaBarrier.reserve(tx, ready.id, [ready.checkpoint!]),
      );
      expect(reserved, isNull);
    },
  );

  test('legacy epoch pins remain protected', () async {
    await pin(h.fence.epoch);
    expect(
      await h.store.transaction(
        h.fence,
        (tx) => DeviceMediaBarrier.reserve(tx, ready.id, [ready.checkpoint!]),
      ),
      isNull,
    );
  });

  test(
    'known cold process reclaims the full reader bound before acquisition',
    () async {
      await fullOldProcess();
      final reader = await process(instance(2))
          .acquireReady(ready.track.ref, 'original', h.fence);
      expect(reader, isNotNull);
      expect((await readers()).length, 1);
      await reader!.release();
    },
  );

  test(
    'same process headless engine and unknown current process keep all pins',
    () async {
      await fullOldProcess();
      for (final current in [token, null]) {
        final repo = process(current);
        expect(
          await repo.acquireReady(ready.track.ref, 'original', h.fence),
          isNull,
        );
        expect(await repo.evictIfUnprotected(ready, h.fence), isFalse);
        expect((await readers()).length, 64);
      }
    },
  );

  test('late old nonce release cannot remove the new process reader', () async {
    final old = (await process(token)
        .acquireReady(ready.track.ref, 'original', h.fence))!;
    final freshRepo = process(instance(2));
    final fresh = (await freshRepo.acquireReady(
      ready.track.ref,
      'original',
      h.fence,
    ))!;
    expect((await readers()).length, 1);
    await old.release();
    expect((await readers()).length, 1);
    expect(await freshRepo.evictIfUnprotected(ready, h.fence), isFalse);
    await fresh.release();
    expect(await freshRepo.evictIfUnprotected(ready, h.fence), isTrue);
  });

  test(
    'legacy future and malformed process pins survive known dead pin reclaim',
    () async {
      await fullOldProcess();
      await h.store.transaction(h.fence, (tx) async {
        final key = DeviceMediaBarrier.key(ready.id, ready.checkpoint!);
        final row = (await tx.read(DeviceMediaBarrier.namespace, key))!;
        await tx.write(DeviceMediaBarrier.namespace, key, {
          ...row,
          'readers': {
            'a' * 48: h.fence.epoch,
            'b' * 48: {...known(token), 'version': 2},
            'c' * 48: {...known(token), 'processInstance': 'malformed'},
            'd' * 48: {...known(token), 'epoch': -1},
            'e' * 48: {...known(token), 'future': true},
            'f' * 48: known(token),
          },
        });
      });
      final repo = process(instance(2));
      final acquired = (await repo.acquireReady(
        ready.track.ref,
        'original',
        h.fence,
      ))!;
      expect((await readers()).length, 6);
      await acquired.release();
      expect((await readers()).keys.toSet(), {
        'a' * 48,
        'b' * 48,
        'c' * 48,
        'd' * 48,
        'e' * 48,
      });
      expect(await repo.evictIfUnprotected(ready, h.fence), isFalse);
    },
  );

  test(
    'retention reserve can reclaim known dead readers and finalize exact files',
    () async {
      await fullOldProcess();
      expect(
        await process(instance(2)).evictIfUnprotected(ready, h.fence),
        isTrue,
      );
      expect((await h.repo.status(ready.id, h.fence))!.files, isEmpty);
    },
  );

  test('manual removal uses the same known dead process admission', () async {
    await fullOldProcess();
    await process(instance(2)).remove(ready.id, h.fence);
    expect((await h.repo.status(ready.id, h.fence))!.files, isEmpty);
  });

  test(
    'frozen offline manifest acquisition shares the repository process scope',
    () async {
      final offline = OfflineMixRepository(downloads: h.repo, fence: h.fence);
      final staged = await offline.stage(
        MusicMix(
          id: 'process',
          title: 'QA',
          description: '',
          kind: MusicMixKind.daily,
          tracks: [ready.track],
          loaded: true,
        ),
      );
      expect(await offline.bind(staged.generation, [ready]), isTrue);
      expect(await offline.commit(staged.generation), isTrue);
      await fullOldProcess();
      final cold = OfflineMixRepository(
        downloads: process(instance(2)),
        fence: h.fence,
      );
      final reader = await cold.acquireVerifiedFile(
        staged.generation,
        ready.track.ref,
      );
      expect(reader, isNotNull);
      expect((await readers()).length, 1);
      await reader!.release();
    },
  );

  test(
    'more than64 dead process recreations never exhaust the reader bound',
    () async {
      final held = <DeviceMediaReader>[];
      for (var n = 0; n < 80; n++) {
        final repo = process(instance(n));
        final reader = await repo.acquireReady(
          ready.track.ref,
          'original',
          h.fence,
        );
        expect(reader, isNotNull, reason: 'cold process $n');
        held.add(reader!);
        expect((await readers()).length, 1);
      }
      for (final stale in held.take(held.length - 1)) {
        await stale.release();
      }
      expect((await readers()).length, 1);
      await held.last.release();
      expect(
        await h.store.transaction(
          h.fence,
          (tx) => tx.list(DeviceMediaBarrier.namespace),
        ),
        isEmpty,
      );
    },
  );

  test('known process scope never bypasses a revoked owner fence', () async {
    await fullOldProcess();
    final repo = process(instance(2));
    final fence = h.fence;
    await h.authority.invalidate();
    await expectLater(
      repo.acquireReady(ready.track.ref, 'original', fence),
      throwsA(anything),
    );
  });
}
