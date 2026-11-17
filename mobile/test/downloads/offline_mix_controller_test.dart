import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/downloads/download_models.dart';
import 'package:soundspan/downloads/download_network_access.dart';
import 'package:soundspan/downloads/download_network_rules.dart';
import 'package:soundspan/downloads/offline_mix_repository.dart';
import 'package:soundspan/features/downloads/downloads_controller.dart';
import 'package:soundspan/features/downloads/offline_mix_controller.dart';
import 'package:soundspan/features/home/home_models.dart';

import 'download_fixture.dart';

void main() {
  late DownloadHarness h;
  var runImmediately = true, metered = false;
  final scheduled = <DeviceDownload>[];
  setUp(() async {
    h = await DownloadHarness.create();
    runImmediately = true;
    metered = false;
    scheduled.clear();
  });
  tearDown(() async => h.close());
  const second = Track(
    ref: LibraryTrackRef('second'),
    title: 'Второй',
    artist: 'Автор',
  );
  MusicMix mix(List<Track> tracks) => MusicMix(
    id: 'daily-test',
    title: 'Мой микс',
    description: '',
    kind: MusicMixKind.daily,
    generationId: 'original-server-generation',
    tracks: tracks,
  );
  ({OfflineMixController offline, DownloadsController downloads}) create({
    bool offlineMode = false,
  }) {
    final policy = offlineMode
        ? const NetworkPolicy.offline()
        : const NetworkPolicy.online();
    final downloads = DownloadsController(
      repository: h.repo,
      fence: h.fence,
      networkPolicy: policy,
      storageReady: () => true,
      schedule: (id, f, g) async {
        final job = (await h.repo.status(id, f))!;
        scheduled.add(job);
        if (runImmediately) await h.runner.run(id, f, g);
        return 'work';
      },
      cancelJob: (_, _, _) async {},
      networkAccess: DownloadNetworkAccess(
        repository: h.repo,
        fence: h.fence,
        policy: policy,
        readNetwork: () async => DeviceNetworkState(
          connected: true,
          wifi: true,
          metered: metered,
          roaming: false,
        ),
      ),
    );
    final offline = OfflineMixController(
      repository: OfflineMixRepository(downloads: h.repo, fence: h.fence),
      downloads: downloads,
    );
    addTearDown(() async {
      await offline.close();
      offline.dispose();
      await downloads.close();
      downloads.dispose();
    });
    return (offline: offline, downloads: downloads);
  }

  test(
    'manual save publishes only complete files and preserves duplicate order',
    () async {
      final c = create();
      await c.offline.save(
        mix([DownloadHarness.track, second, DownloadHarness.track]),
      );
      expect(c.offline.failure, isNull);
      expect(c.offline.state.pending, isNull);
      expect(c.offline.state.active!.tracks.map((t) => t.ref), [
        DownloadHarness.track.ref,
        second.ref,
        DownloadHarness.track.ref,
      ]);
      expect(scheduled, hasLength(2));
      expect(
        (await h.repo.list(h.fence)).every((j) => j.exclusivelyOfflineMixOwned),
        isTrue,
      );
    },
  );

  test(
    'pending progress advances without replacing the previous usable snapshot',
    () async {
      final c = create();
      await c.offline.save(mix([DownloadHarness.track]));
      final old = c.offline.state.active!;
      runImmediately = false;
      await c.offline.save(mix([DownloadHarness.track, second]));
      expect(c.offline.state.active!.generation, old.generation);
      expect(c.offline.state.pendingReadyCount, 1);
      final pending = scheduled.last;
      expect(
        await h.runner.run(pending.id, h.fence, pending.generation),
        DownloadRunResult.ready,
      );
      await c.offline.refresh();
      expect(c.offline.state.pending, isNull);
      expect(c.offline.state.active!.tracks, hasLength(2));
      expect(c.offline.state.previous!.generation, old.generation);
    },
  );

  test('cancelled traffic consent discards only its draft and keeps old active files', () async {
    final c = create();
    await c.offline.save(mix([DownloadHarness.track]));
    final old = c.offline.state.active!;
    metered = true;
    c.downloads.confirmNetworkUse = (_) async => false;
    await c.offline.save(mix([second]));
    expect(c.offline.state.active!.generation, old.generation);
    expect(c.offline.state.pending, isNull);
    expect(await h.repo.list(h.fence), hasLength(1));
    expect(scheduled, hasLength(1));
  });

  test(
    'explicit retry keeps the saved source and binds a new job generation',
    () async {
      final c = create();
      runImmediately = false;
      await c.offline.save(mix([DownloadHarness.track]));
      final first = c.offline.state.pending!;
      final job = scheduled.single;
      await h.repo.cancel(job.id, h.fence, expectedGeneration: job.generation);
      runImmediately = true;
      await c.offline.retry();
      expect(c.offline.failure, isNull);
      expect(c.offline.state.pending, isNull);
      final active = c.offline.state.active!;
      expect(active.generation, greaterThan(first.generation));
      expect(active.sourceIdentity, first.sourceIdentity);
      expect(active.sourceGenerationId, 'original-server-generation');
      expect(active.revision, first.revision);
      expect(
        active.items.single.downloadGeneration,
        greaterThan(job.generation),
      );
    },
  );

  test(
    'explicit cached mix save is fully local while offline mode is on',
    () async {
      final job = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
      );
      expect(
        await h.runner.run(job.id, h.fence, job.generation),
        DownloadRunResult.ready,
      );
      final requests = h.requests.length;
      final c = create(offlineMode: true);
      await c.offline.save(mix([DownloadHarness.track]));
      expect(c.offline.failure, isNull);
      expect(c.offline.state.active, isNotNull);
      expect(scheduled, isEmpty);
      expect(h.requests.length, requests);
    },
  );

  test(
    'close retires a pending consent without waiting for an unanswered dialog',
    () async {
      final c = create();
      metered = true;
      final opened = Completer<void>(), answer = Completer<bool>();
      c.downloads.confirmNetworkUse = (_) {
        opened.complete();
        return answer.future;
      };
      final saving = c.offline.save(mix([DownloadHarness.track]));
      await opened.future;
      await c.offline.close();
      await saving;
      expect(c.offline.isCurrent, isFalse);
      expect((await c.offline.repository.read()).active, isNull);
      await c.downloads.close();
      expect(await h.repo.list(h.fence), isEmpty);
    },
  );
}
