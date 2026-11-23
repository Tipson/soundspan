import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/storage/owner_store.dart';
import 'package:soundspan/downloads/download_models.dart';
import 'package:soundspan/downloads/download_repository.dart';

import 'download_fixture.dart';

void main() {
  test('501 downloads use paged records without per-item rereads', () async {
    final h = await DownloadHarness.create();
    addTearDown(h.close);
    await h.store.transaction(h.fence, (tx) async {
      for (var i = 0; i < 501; i++) {
        final track = Track(
          ref: LibraryTrackRef('download-$i'),
          title: 'Трек $i',
          artist: 'Исполнитель',
        );
        final job = DeviceDownload(
          id: h.repo.key(track.ref, 'original', h.fence.owner),
          track: track,
          quality: 'original',
          originalFence: h.fence,
          generation: 1,
          state: DownloadState.queued,
          manual: true,
        );
        await tx.write(DownloadRepository.namespace, job.id, job.toJson());
      }
    });
    final counted = _CountingStore(h.store);
    final repo = DownloadRepository(
      store: counted,
      authority: h.authority,
      paths: h.paths,
      verifier: h.repo.verifier,
      beforeRemove: (_) async {},
    );
    final jobs = await repo.list(h.fence);
    expect(jobs, hasLength(501));
    expect(jobs.map((j) => j.id).toSet(), hasLength(501));
    expect(counted.pages, 7); // Six bounded pages and the terminal empty page.
    expect(counted.reads, 0);
    expect(h.requests, isEmpty);
  });

  test(
    'paged payload still validates exact owner and representation key',
    () async {
      final h = await DownloadHarness.create();
      addTearDown(h.close);
      final job = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
      );
      await h.store.transaction(h.fence, (tx) async {
        await tx.write(DownloadRepository.namespace, job.id, {
          ...job.toJson(),
          'user': 'different-owner',
        });
      });
      await expectLater(h.repo.list(h.fence), throwsFormatException);
    },
  );
}

final class _CountingStore implements OwnerStore {
  _CountingStore(this.delegate);
  final OwnerStore delegate;
  int reads = 0;
  int pages = 0;

  @override
  Future<T> transaction<T>(
    SessionFence fence,
    Future<T> Function(OwnerTransaction) operation,
  ) => delegate.transaction(fence, (tx) => operation(_CountingTx(this, tx)));
}

final class _CountingTx implements OwnerTransaction {
  _CountingTx(this.counter, this.delegate);
  final _CountingStore counter;
  final OwnerTransaction delegate;

  @override
  Future<Map<String, Object?>?> read(String namespace, String key) {
    counter.reads++;
    return delegate.read(namespace, key);
  }

  @override
  Future<List<OwnerRecord>> list(
    String namespace, {
    String? afterKey,
    int limit = 100,
  }) {
    counter.pages++;
    return delegate.list(namespace, afterKey: afterKey, limit: limit);
  }

  @override
  Future<void> remove(String namespace, String key) =>
      delegate.remove(namespace, key);

  @override
  Future<void> write(
    String namespace,
    String key,
    Map<String, Object?> value,
  ) => delegate.write(namespace, key, value);
}
