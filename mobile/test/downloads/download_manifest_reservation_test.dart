import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/storage/owner_store.dart';
import 'package:soundspan/downloads/download_models.dart';
import 'package:soundspan/downloads/download_repository.dart';
import 'package:soundspan/downloads/offline_mix_repository.dart';
import 'package:soundspan/features/home/home_models.dart';

import 'download_fixture.dart';

/// Pause outside the committed transaction, before the caller may unlink.
class HeldRemovalStore implements OwnerStore {
  HeldRemovalStore(this.inner, {this.onReader = false});
  final OwnerStore inner;
  final bool onReader;
  final entered = Completer<void>(), release = Completer<void>();
  var armed = true;
  @override
  Future<T> transaction<T>(
    SessionFence fence,
    Future<T> Function(OwnerTransaction) body,
  ) async {
    var removing = false;
    final result = await inner.transaction(
      fence,
      (tx) => body(_ObserveTx(tx, () => removing = true, onReader)),
    );
    if (armed && removing) {
      armed = false;
      entered.complete();
      await release.future;
    }
    return result;
  }
}

class _ObserveTx implements OwnerTransaction {
  _ObserveTx(this.inner, this.onRemoving, this.onReader);
  final OwnerTransaction inner;
  final void Function() onRemoving;
  final bool onReader;
  @override
  Future<Map<String, Object?>?> read(String ns, String key) =>
      inner.read(ns, key);
  @override
  Future<void> write(String ns, String key, Map<String, Object?> row) async {
    await inner.write(ns, key, row);
    if (onReader
        ? ns == 'deviceMediaReaders.v1' && (row['readers'] as Map).isNotEmpty
        : ns == DownloadRepository.namespace && row['state'] == 'removing') {
      onRemoving();
    }
  }

  @override
  Future<void> remove(String ns, String key) => inner.remove(ns, key);
  @override
  Future<List<OwnerRecord>> list(
    String ns, {
    String? afterKey,
    int limit = 100,
  }) => inner.list(ns, afterKey: afterKey, limit: limit);
}

void main() {
  test('a new journal generation cannot reopen a frozen file reserved for deletion', () async {
    final h = await DownloadHarness.create();
    addTearDown(h.close);
    final offline = OfflineMixRepository(downloads: h.repo, fence: h.fence);
    final mix = MusicMix(
      id: 'reservation',
      title: 'Fixture',
      description: '',
      kind: MusicMixKind.daily,
      tracks: [DownloadHarness.track],
      loaded: true,
    );
    final staged = await offline.stage(mix);
    final job = await h.repo.enqueue(
      DownloadHarness.track,
      'original',
      h.fence,
      manual: false,
      origin: DownloadOrigin.offlineMix,
    );
    expect(
      await h.runner.run(job.id, h.fence, job.generation),
      DownloadRunResult.ready,
    );
    final ready = (await h.repo.status(job.id, h.fence))!;
    expect(await offline.bind(staged.generation, [ready]), isTrue);
    expect(await offline.commit(staged.generation), isTrue);
    final file = (await offline.openVerifiedFile(
      staged.generation,
      job.track.ref,
    ))!;
    final held = HeldRemovalStore(h.store);
    final remover = DownloadRepository(
      store: held,
      authority: h.authority,
      paths: h.paths,
      verifier: h.repo.verifier,
      beforeRemove: (_) async {},
    );
    final removing = remover.remove(
      job.id,
      h.fence,
      expectedGeneration: ready.generation,
    );
    try {
      await held.entered.future.timeout(const Duration(seconds: 5));
      expect(await file.exists(), isTrue);
      final replacement = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
        manual: false,
        origin: DownloadOrigin.offlineMix,
      );
      expect(replacement.state, DownloadState.queued);
      final cold = OfflineMixRepository(
        downloads: h.newRepository(),
        fence: h.fence,
      );
      expect(
        await cold.openVerifiedFile(staged.generation, job.track.ref),
        isNull,
        reason:
            'A durable exact-file reservation must outlive mutable job state',
      );
    } finally {
      held.release.complete();
      await removing;
    }
  });
}
