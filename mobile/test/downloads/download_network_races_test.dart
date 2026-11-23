import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/core/storage/owner_store.dart';
import 'package:soundspan/downloads/download_models.dart';
import 'package:soundspan/downloads/download_network_access.dart';
import 'package:soundspan/downloads/download_network_rules.dart';
import 'package:soundspan/downloads/download_repository.dart';
import 'package:soundspan/downloads/reschedule_network_downloads.dart';
import 'package:soundspan/downloads/stored_download_network_rules.dart';

import 'download_fixture.dart';

class CommitHookStore implements OwnerStore {
  CommitHookStore(this.inner, this.matches, this.afterCommit);
  final OwnerStore inner;
  final bool Function(Object?) matches;
  Future<void> Function()? afterCommit;
  bool fired = false;
  @override
  Future<T> transaction<T>(
    SessionFence fence,
    Future<T> Function(OwnerTransaction) body,
  ) async {
    final result = await inner.transaction(fence, body);
    if (afterCommit != null && matches(result)) {
      final action = afterCommit!;
      afterCommit = null;
      fired = true;
      await action();
    }
    return result;
  }
}

DownloadRepository repositoryUsing(DownloadHarness h, OwnerStore store) =>
    DownloadRepository(
      store: store,
      authority: h.authority,
      paths: h.paths,
      verifier: h.repo.verifier,
      beforeRemove: (_) async {},
      clock: () => h.currentTime,
    );

void main() {
  test(
    'rejected pause CAS cannot resume a concurrent user-paused replacement',
    () async {
      final h = await DownloadHarness.create();
      addTearDown(h.close);
      final job = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
      );
      final store = CommitHookStore(
        h.store,
        (value) => value is List<DeviceDownload>,
        () async {
          // Another valid owner command commits after list's transaction, before pause CAS.
          await h.repo.pause(
            job.id,
            h.fence,
            expectedGeneration: job.generation,
          );
        },
      );
      final repository = repositoryUsing(h, store);
      var schedules = 0;
      await rescheduleNetworkDownloads(
        repository: repository,
        fence: h.fence,
        cancel: (_, _, _) async {},
        schedule: (_, _, _) async {
          schedules++;
          return 'unexpected';
        },
      );
      final latest = (await h.repo.status(job.id, h.fence))!;
      expect(store.fired, true);
      expect(
        latest.state,
        DownloadState.paused,
        reason:
            'Rejected CAS returned another command result, not pause ownership',
      );
      expect(latest.generation, job.generation + 1);
      expect(schedules, 0);
    },
  );

  test(
    'stricter committed rules cannot be bypassed after an older rules read',
    () async {
      final h = await DownloadHarness.create();
      addTearDown(h.close);
      await saveDownloadNetworkRules(
        h.store,
        h.fence,
        const DownloadNetworkRules(mode: DownloadNetworkMode.any),
      );
      final store = CommitHookStore(
        h.store,
        (value) => value is DownloadNetworkRules,
        () async {
          // A separate owner transaction commits before the outer async read returns.
          await saveDownloadNetworkRules(
            h.store,
            h.fence,
            const DownloadNetworkRules(),
          );
        },
      );
      final access = DownloadNetworkAccess(
        repository: repositoryUsing(h, store),
        fence: h.fence,
        policy: const NetworkPolicy.online(),
        readNetwork: () async => const DeviceNetworkState(
          connected: true,
          wifi: false,
          metered: true,
          roaming: false,
        ),
      );
      Object? failure;
      try {
        await access.requireNetwork();
      } catch (error) {
        failure = error;
      }
      final durable = await loadDownloadNetworkRules(h.store, h.fence);
      expect(store.fired, true);
      expect(durable.mode, DownloadNetworkMode.unmetered);
      expect(
        failure,
        isA<AppFailure>().having(
          (value) => value.code,
          'code',
          'download_network_restricted',
        ),
      );
    },
  );
}
