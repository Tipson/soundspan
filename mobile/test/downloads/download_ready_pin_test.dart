import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/downloads/download_models.dart';
import 'package:soundspan/downloads/download_network_access.dart';
import 'package:soundspan/downloads/download_network_rules.dart';
import 'package:soundspan/features/downloads/downloads_controller.dart';

import 'download_fixture.dart';

void main() {
  late DownloadHarness h;
  setUp(() async => h = await DownloadHarness.create());
  tearDown(() async => h.close());
  Future<DeviceDownload> readyMixFile() async {
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
    return (await h.repo.status(job.id, h.fence))!;
  }

  test(
    'local ready pin protects the same file without network or new generation',
    () async {
      final job = await readyMixFile();
      final requests = h.requests.length;
      expect(
        await h.repo.pinReadyIfCurrent(
          job.id,
          h.fence,
          expectedGeneration: job.generation,
        ),
        isTrue,
      );
      final pinned = (await h.repo.status(job.id, h.fence))!;
      expect(pinned.origins, containsAll(['offlineMix', 'manual']));
      expect(pinned.exclusivelyOfflineMixOwned, isFalse);
      expect(pinned.generation, job.generation);
      expect(pinned.checkpoint!.toJson(), job.checkpoint!.toJson());
      expect(h.requests.length, requests);
    },
  );

  test(
    'a late pin cannot recreate a removed file or pin its queued replacement',
    () async {
      final job = await readyMixFile();
      await h.repo.remove(job.id, h.fence, expectedGeneration: job.generation);
      final replacement = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
        origin: DownloadOrigin.offlineMix,
      );
      expect(
        await h.repo.pinReadyIfCurrent(
          job.id,
          h.fence,
          expectedGeneration: job.generation,
        ),
        isFalse,
      );
      final after = (await h.repo.status(job.id, h.fence))!;
      expect(after.generation, replacement.generation);
      expect(after.state, DownloadState.queued);
      expect(after.origins, {'offlineMix'});
    },
  );

  test('retired account cannot persist a pin', () async {
    final job = await readyMixFile(), fence = h.fence;
    final before = jsonEncode(h.store.rows);
    await h.authority.invalidate();
    await expectLater(
      h.repo.pinReadyIfCurrent(
        job.id,
        fence,
        expectedGeneration: job.generation,
      ),
      throwsA(isA<AppFailure>()),
    );
    expect(jsonEncode(h.store.rows), before);
  });

  for (final existingReady in [true, false]) {
    test(
      'manual UI retains requested file origin for ${existingReady ? 'already ready individual save' : 'new mix snapshot'}',
      () async {
        final old = existingReady ? await readyMixFile() : null;
        final requests = h.requests.length, scheduled = <String>[];
        var permissionCalls = 0;
        final controller = DownloadsController(
          repository: h.repo,
          fence: h.fence,
          networkPolicy: const NetworkPolicy.online(),
          storageReady: () => true,
          schedule: (id, fence, generation) async {
            scheduled.add(id);
            return 'work';
          },
          cancelJob: (_, _, _) async {},
          requestNotificationPermission: () async {
            permissionCalls++;
            return true;
          },
          networkAccess: DownloadNetworkAccess(
            repository: h.repo,
            fence: h.fence,
            policy: const NetworkPolicy.online(),
            readNetwork: () async => const DeviceNetworkState(
              connected: true,
              wifi: true,
              metered: false,
              roaming: false,
            ),
          ),
        );
        addTearDown(() async {
          await controller.close();
          controller.dispose();
        });
        await controller.downloadTracks(
          [DownloadHarness.track],
          origin: existingReady
              ? DownloadOrigin.manual
              : DownloadOrigin.offlineMix,
        );
        final job = (await h.repo.list(h.fence)).single;
        expect(
          job.origins,
          existingReady
              ? containsAll(['offlineMix', 'manual'])
              : {'offlineMix'},
        );
        expect(controller.failure, isNull);
        expect(
          h.requests.length,
          requests,
          reason: 'Admission schedules work but never fetches audio itself.',
        );
        expect(scheduled, hasLength(existingReady ? 0 : 1));
        expect(permissionCalls, existingReady ? 0 : 1);
        if (old != null) expect(job.generation, old.generation);
      },
    );
  }
}
