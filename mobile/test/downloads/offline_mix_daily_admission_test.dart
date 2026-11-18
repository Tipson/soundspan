import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/storage/owner_store.dart';
import 'package:soundspan/downloads/automatic_download_control.dart';
import 'package:soundspan/downloads/download_models.dart';
import 'package:soundspan/downloads/download_repository.dart';
import 'package:soundspan/downloads/offline_mix_refresh_policy.dart';
import 'package:soundspan/downloads/offline_mix_repository.dart';
import 'package:soundspan/features/home/home_models.dart';

import 'download_fixture.dart';

void main() {
  late DownloadHarness h;
  late OfflineMixRefreshPolicy policy;
  setUp(() async {
    h = await DownloadHarness.create();
    policy = OfflineMixRefreshPolicy(store: h.store, fence: h.fence);
  });
  tearDown(() => h.close());
  Map<String, Object?> ticket(OfflineMixRefreshTicket value) => {
    'epoch': value.fence.epoch,
    'revision': value.revision,
    'sourceIdentity': value.sourceIdentity,
    'quality': value.quality,
    'nonce': value.nonce,
  };
  Future<(DeviceDownload, OfflineMixRefreshTicket)> daily() async {
    final configured = await policy.configure(
      enabled: true,
      sourceIdentity: 'daily:test',
      quality: 'original',
    );
    final captured = (await policy.claim(
      charging: true,
      unmetered: true,
      expectedRevision: configured.revision,
    ))!;
    final job = await h.repo.enqueue(
      DownloadHarness.track,
      'original',
      h.fence,
      manual: false,
      origin: DownloadOrigin.offlineMix,
    );
    await h.store.transaction(h.fence, (tx) async {
      final raw = (await tx.read(DownloadRepository.namespace, job.id))!;
      await tx.write(DownloadRepository.namespace, job.id, {
        ...raw,
        'origins': ['offlineMixDaily'],
      });
      await tx.write('offlineMixRefreshJobs.v1', job.id, {
        'version': 1,
        'generation': job.generation,
        'ticket': ticket(captured),
      });
    });
    return (job, captured);
  }

  test(
    'enabled daily admission is independent of disabled liked automation',
    () async {
      final (job, _) = await daily();
      await h.store.transaction(
        h.fence,
        (tx) => tx.write(
          AutomaticDownloadControl.namespace,
          AutomaticDownloadControl.key,
          AutomaticDownloadControl.encode(true),
        ),
      );
      expect(await h.repo.claim(job.id, h.fence, job.generation), isNotNull);
    },
  );

  test('disabled ticket cannot claim queued automatic daily files', () async {
    final (job, _) = await daily();
    await policy.configure(enabled: false);
    expect(await h.repo.claim(job.id, h.fence, job.generation), isNull);
  });

  test('manual promotion keeps its exact identity and is not blocked by daily disable', () async {
    final (job, _) = await daily();
    await policy.configure(enabled: false);
    final promoted = await h.repo.enqueue(job.track, job.quality, h.fence);
    expect(promoted.id, job.id);
    expect(promoted.generation, job.generation);
    expect(await h.repo.claim(job.id, h.fence, job.generation), isNotNull);
  });

  test('new orchestration nonce supersedes old automatic generation rather than adopting its live writer', () async {
    final (job, first) = await daily();
    final claimed = (await h.repo.claim(job.id, h.fence, job.generation))!;
    expect(await policy.finish(first, success: false), isTrue);
    final next = (await policy.claim(
      charging: true,
      unmetered: true,
      expectedRevision: first.revision,
    ))!;
    final replacement = await h.repo.enqueue(
      job.track,
      job.quality,
      h.fence,
      manual: false,
      origin: DownloadOrigin.offlineMixDaily,
      refreshTicket: next,
    );
    expect(replacement.generation, job.generation + 1);
    await expectLater(h.repo.assertClaim(claimed), throwsA(anything));
  });

  test(
    'generic manifest commit cannot bypass a disabled daily binding',
    () async {
      final (job, captured) = await daily();
      final promoted = await h.repo.enqueue(job.track, job.quality, h.fence);
      expect(
        await h.runner.run(promoted.id, h.fence, promoted.generation),
        DownloadRunResult.ready,
      );
      final ready = (await h.repo.status(job.id, h.fence))!;
      final mixes = OfflineMixRepository(downloads: h.repo, fence: h.fence);
      MusicMix source(String id) => MusicMix(
        id: id,
        title: 'Daily',
        description: '',
        kind: MusicMixKind.daily,
        tracks: [ready.track],
        loaded: true,
      );
      final first = await mixes.stage(source('first'));
      expect(await mixes.bind(first.generation, [ready]), isTrue);
      expect(await mixes.commit(first.generation), isTrue);
      final pending = await mixes.stage(source('test'));
      expect(await mixes.bind(pending.generation, [ready]), isTrue);
      await h.store.transaction(
        h.fence,
        (tx) => tx.write('offlineMixRefreshBinding.v1', 'current', {
          'version': 1,
          'mixGeneration': pending.generation,
          'ticket': ticket(captured),
        }),
      );
      await policy.configure(enabled: false);
      expect(await mixes.commit(pending.generation), isFalse);
      expect((await mixes.read()).active!.generation, first.generation);
    },
  );
  test(
    'failed success receipt rolls back manifest switch and retries atomically',
    () async {
      final (job, captured) = await daily();
      final promoted = await h.repo.enqueue(job.track, job.quality, h.fence);
      expect(
        await h.runner.run(promoted.id, h.fence, promoted.generation),
        DownloadRunResult.ready,
      );
      final ready = (await h.repo.status(job.id, h.fence))!;
      final store = _SuccessFailureStore(h.store);
      final repo = DownloadRepository(
        store: store,
        authority: h.authority,
        paths: h.paths,
        verifier: h.repo.verifier,
        beforeRemove: (_) async {},
      );
      final mixes = OfflineMixRepository(downloads: repo, fence: h.fence);
      final source = MusicMix(
        id: 'test',
        title: 'Daily',
        description: '',
        kind: MusicMixKind.daily,
        tracks: [ready.track],
        loaded: true,
      );
      final old = await mixes.stage(source);
      expect(await mixes.bind(old.generation, [ready]), isTrue);
      expect(await mixes.commit(old.generation), isTrue);
      final next = await mixes.stage(source, refreshTicket: captured);
      expect(
        await mixes.bind(next.generation, [ready], refreshTicket: captured),
        isTrue,
      );
      store.fail = true;
      await expectLater(
        mixes.commit(next.generation, refreshTicket: captured),
        throwsStateError,
      );
      expect((await mixes.read()).active!.generation, old.generation);
      expect((await policy.read()).lastSuccessAt, 0);
      expect(await policy.isCurrent(captured), isTrue);
      store.fail = false;
      expect(
        await mixes.commit(next.generation, refreshTicket: captured),
        isTrue,
      );
      expect((await mixes.read()).active!.generation, next.generation);
      expect((await policy.read()).lastSuccessAt, greaterThan(0));
    },
  );
}

class _SuccessFailureStore implements OwnerStore {
  _SuccessFailureStore(this.inner);
  final OwnerStore inner;
  bool fail = false;
  @override
  Future<T> transaction<T>(
    SessionFence fence,
    Future<T> Function(OwnerTransaction) body,
  ) =>
      inner.transaction(fence, (tx) => body(_SuccessFailureTx(tx, () => fail)));
}

class _SuccessFailureTx implements OwnerTransaction {
  _SuccessFailureTx(this.inner, this.fail);
  final OwnerTransaction inner;
  final bool Function() fail;
  @override
  Future<Map<String, Object?>?> read(String ns, String key) =>
      inner.read(ns, key);
  @override
  Future<void> remove(String ns, String key) => inner.remove(ns, key);
  @override
  Future<List<OwnerRecord>> list(
    String ns, {
    String? afterKey,
    int limit = 100,
  }) => inner.list(ns, afterKey: afterKey, limit: limit);
  @override
  Future<void> write(String ns, String key, Map<String, Object?> value) async {
    if (fail() &&
        ns == OfflineMixRefreshPolicy.namespace &&
        (value['lastSuccessAt'] as int) > 0) {
      throw StateError('receipt unavailable');
    }
    await inner.write(ns, key, value);
  }
}
