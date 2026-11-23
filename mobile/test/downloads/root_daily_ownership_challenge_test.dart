import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/downloads/download_models.dart';
import 'package:soundspan/downloads/offline_mix_quota.dart';
import 'package:soundspan/downloads/offline_mix_refresh_policy.dart';
import 'package:soundspan/downloads/offline_mix_repository.dart';
import 'package:soundspan/features/home/home_models.dart';

import 'download_fixture.dart';

void main() {
  test('a completed deletion does not permanently forbid saving a mix containing that recording', () async {
    final h = await DownloadHarness.create();
    addTearDown(h.close);
    final old = await h.repo.enqueue(
      DownloadHarness.track,
      'original',
      h.fence,
    );
    expect(
      await h.runner.run(old.id, h.fence, old.generation),
      DownloadRunResult.ready,
    );
    await h.repo.remove(old.id, h.fence);
    final removed = (await h.repo.status(old.id, h.fence))!;
    expect(removed.files, isEmpty);
    expect(removed.checkpoint, isNull);
    final mixes = OfflineMixRepository(downloads: h.repo, fence: h.fence);
    final staged = await mixes.stage(
      MusicMix(
        id: 'test',
        title: 'Мой микс',
        description: '',
        kind: MusicMixKind.daily,
        tracks: [DownloadHarness.track],
      ),
    );
    final fresh = await h.repo.enqueue(
      DownloadHarness.track,
      'original',
      h.fence,
    );
    expect(fresh.generation, greaterThan(removed.generation));
    expect(
      await h.runner.run(fresh.id, h.fence, fresh.generation),
      DownloadRunResult.ready,
    );
    expect(await mixes.bind(staged.generation, [fresh]), isTrue);
    expect(await mixes.commit(staged.generation), isTrue);
    expect(
      (await mixes.read()).active!.tracks.single.ref,
      DownloadHarness.track.ref,
    );
  });
  for (final previousOrigin in [DownloadOrigin.manual, DownloadOrigin.liked]) {
    test(
      'independent: deleted ${previousOrigin.name} ownership cannot exempt a fresh automatic file from quota',
      () async {
        final h = await DownloadHarness.create();
        addTearDown(h.close);
        final old = await h.repo.enqueue(
          DownloadHarness.track,
          'original',
          h.fence,
          manual: previousOrigin == DownloadOrigin.manual,
          origin: previousOrigin,
        );
        expect(
          await h.runner.run(old.id, h.fence, old.generation),
          DownloadRunResult.ready,
        );
        final oldFile = (await h.repo.openReady(
          old.track.ref,
          old.quality,
          h.fence,
        ))!;
        await h.repo.remove(old.id, h.fence);
        expect(await oldFile.exists(), isFalse);
        final removed = (await h.repo.status(old.id, h.fence))!;
        expect(removed.files, isEmpty);
        expect(removed.checkpoint, isNull);

        final policy = OfflineMixRefreshPolicy(store: h.store, fence: h.fence);
        final configured = await policy.configure(
          enabled: true,
          sourceIdentity: 'daily:test',
          quality: 'original',
        );
        final ticket = (await policy.claim(
          charging: true,
          unmetered: true,
          expectedRevision: configured.revision,
        ))!;
        final fresh = await h.repo.enqueue(
          DownloadHarness.track,
          'original',
          h.fence,
          manual: false,
          origin: DownloadOrigin.offlineMixDaily,
          refreshTicket: ticket,
        );
        expect(fresh.manual, isFalse);
        expect(
          await h.runner.run(fresh.id, h.fence, fresh.generation),
          DownloadRunResult.ready,
        );
        final file = (await h.repo.openReady(
          fresh.track.ref,
          fresh.quality,
          h.fence,
        ))!;
        final usage = await OfflineMixQuota(
          repository: h.repo,
          fence: h.fence,
        ).usage();
        expect(
          usage.usedBytes,
          await file.length(),
          reason: 'New automatic bytes must count after the explicitly removed file no longer exists',
        );
      },
    );
  }
}
