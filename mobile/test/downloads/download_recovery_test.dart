import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/downloads/download_models.dart';
import 'package:soundspan/downloads/liked_download_automation.dart';
import 'package:soundspan/features/downloads/downloads_controller.dart';
import 'package:soundspan/features/likes/likes_models.dart';
import 'package:soundspan/features/likes/likes_repository.dart';

import '../support/collection_fixtures.dart';
import 'download_fixture.dart';

void main() {
  LikedDownloadAutomation automation(DownloadHarness h) =>
      LikedDownloadAutomation(
        downloads: h.repo,
        likes: LikesRepository(
          transport: CollectionTransport(
            (_, _) => likedResponse([likedDto(1)]),
          ),
          authority: h.authority,
          fence: h.fence,
        ),
        fence: h.fence,
        networkPolicy: const NetworkPolicy.online(),
        storageReady: () => true,
        schedule: (id, fence, generation) async {
          await h.runner.run(id, fence, generation);
          return 'work';
        },
        cancelJob: (_, _, _) async {},
      );

  DownloadsController controller(
    DownloadHarness h, {
    LikedDownloadAutomation? automation,
  }) => DownloadsController(
    repository: h.repo,
    fence: h.fence,
    networkPolicy: const NetworkPolicy.online(),
    storageReady: () => true,
    schedule: (id, fence, generation) async {
      await h.runner.run(id, fence, generation);
      return 'work';
    },
    cancelJob: (_, _, _) async {},
    automation: automation,
  );

  for (final manual in [false, true]) {
    test(
      'one explicit enable survives historical ${manual ? 'manual' : 'auto'} ENOSPC and UI reopen',
      () async {
        final io = FaultMediaIo()..fault = 'full';
        final h = await DownloadHarness.create(io: io);
        addTearDown(h.close);
        final failed = await h.repo.enqueue(
          DownloadHarness.track,
          'original',
          h.fence,
          manual: manual,
        );
        await h.runner.run(failed.id, h.fence, failed.generation);
        expect(
          (await h.repo.status(failed.id, h.fence))!.errorCode,
          'download_storage_full',
        );
        final a = automation(h);
        final c = controller(h, automation: a);
        addTearDown(a.close);
        addTearDown(c.dispose);
        await c.refresh();
        expect(a.paused, isTrue);
        expect(a.notice, contains('место'));
        io.fault = null;
        await c.setAutomationPaused(false);
        expect(await a.readPaused(), isFalse);
        expect(
          c.jobs.where((j) => j.state == DownloadState.ready),
          hasLength(1),
        );
        await c.close();
        await a.close();

        final reopened = automation(h);
        final reopenedController = controller(h, automation: reopened);
        addTearDown(reopened.close);
        addTearDown(reopenedController.dispose);
        await reopenedController.refresh();
        await reopened.reconcile(h.fence);
        final next = collectionTrack(2);
        await reopened.onPreferenceChanged(
          next.ref,
          PreferenceSignal.like,
          knownTrack: next,
        );
        await reopenedController.refresh();
        expect(await reopened.readPaused(), isFalse);
        expect(reopened.notice, isNull);
        expect(
          reopenedController.jobs.where((j) => j.state == DownloadState.ready),
          hasLength(2),
        );
        expect(
          (await h.repo.status(failed.id, h.fence))!.errorCode,
          'download_storage_full',
        );

        // A later real storage failure must still stop further automatic work.
        io.fault = 'full';
        final later = collectionTrack(3);
        await reopened.onPreferenceChanged(
          later.ref,
          PreferenceSignal.like,
          knownTrack: later,
        );
        await reopenedController.refresh();
        expect(await reopened.readPaused(), isTrue);
        expect(reopened.notice, contains('место'));
        final requests = h.requests.length;
        final blocked = collectionTrack(4);
        await reopened.onPreferenceChanged(
          blocked.ref,
          PreferenceSignal.like,
          knownTrack: blocked,
        );
        expect(h.requests, hasLength(requests));
      },
    );
  }

  for (final retry in [true, false]) {
    test(
      'explicit ${retry ? 'retry' : 'resume'} promotes matching auto generation while global pause remains',
      () async {
        final io = FaultMediaIo()..fault = 'full';
        final h = await DownloadHarness.create(io: io);
        addTearDown(h.close);
        final job = await h.repo.enqueue(
          DownloadHarness.track,
          'original',
          h.fence,
          manual: false,
        );
        await h.runner.run(job.id, h.fence, job.generation);
        if (!retry) await h.repo.pause(job.id, h.fence);
        final captured = (await h.repo.status(job.id, h.fence))!;
        io.fault = null;
        final c = controller(h);
        addTearDown(c.dispose);
        await (retry ? c.retry(captured) : c.resume(captured));
        final recovered = c.jobs.single;
        expect(recovered.state, DownloadState.ready);
        expect(recovered.manual, isTrue);
        expect(recovered.generation, captured.generation + 1);
        final a = automation(h);
        addTearDown(a.close);
        expect(await a.readPaused(), isTrue);
        final other = await h.repo.enqueue(
          collectionTrack(9),
          'original',
          h.fence,
          manual: false,
        );
        final requests = h.requests.length;
        expect(
          await h.runner.run(other.id, h.fence, other.generation),
          DownloadRunResult.cancelled,
        );
        expect(h.requests, hasLength(requests));
      },
    );

    test(
      'stale ${retry ? 'retry' : 'resume'} cannot promote replacement auto job',
      () async {
        final h = await DownloadHarness.create();
        addTearDown(h.close);
        final job = await h.repo.enqueue(
          DownloadHarness.track,
          'original',
          h.fence,
          manual: false,
        );
        final captured = await h.repo.pause(job.id, h.fence);
        final replacement = await h.repo.retry(job.id, h.fence);
        final c = controller(h);
        addTearDown(c.dispose);
        await (retry ? c.retry(captured) : c.resume(captured));
        expect(c.jobs.single.generation, replacement.generation);
        expect(c.jobs.single.manual, isFalse);
        expect(c.jobs.single.state, DownloadState.queued);
        expect(h.requests, isEmpty);
      },
    );
  }
}
