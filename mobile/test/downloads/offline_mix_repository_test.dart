import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/downloads/download_models.dart';
import 'package:soundspan/downloads/download_repository.dart';
import 'package:soundspan/downloads/offline_mix_repository.dart';
import 'package:soundspan/features/home/home_models.dart';

import 'download_fixture.dart';

void main() {
  late DownloadHarness h;
  late OfflineMixRepository offline;
  setUp(() async {
    h = await DownloadHarness.create();
    offline = OfflineMixRepository(downloads: h.repo, fence: h.fence);
  });
  tearDown(() async => h.close());
  const second = Track(
    ref: LibraryTrackRef('second'),
    title: 'Вторая',
    artist: 'Автор',
  );
  MusicMix mix(
    List<Track> tracks, {
    String title = 'Мой микс',
    bool loaded = true,
  }) => MusicMix(
    id: 'daily-fixture',
    title: title,
    description: '',
    kind: MusicMixKind.daily,
    generationId: 'source-generation',
    tracks: tracks,
    loaded: loaded,
  );
  Future<List<DeviceDownload>> ready(List<Track> tracks) async {
    final jobs = <DeviceDownload>[];
    for (final track in tracks) {
      final job = await h.repo.enqueue(track, 'original', h.fence);
      expect(
        await h.runner.run(job.id, h.fence, job.generation),
        DownloadRunResult.ready,
      );
      jobs.add((await h.repo.status(job.id, h.fence))!);
    }
    return jobs;
  }

  Future<OfflineMixSnapshot> install(List<Track> tracks) async {
    final draft = await offline.stage(mix(tracks));
    expect(await offline.bind(draft.generation, await ready(tracks)), isTrue);
    expect(await offline.commit(draft.generation), isTrue);
    return (await offline.read()).active!;
  }

  test('ordered duplicate occurrences retain distinct IDs and one exact file identity', () async {
    final tracks = [DownloadHarness.track, second, DownloadHarness.track];
    final draft = await offline.stage(mix(tracks));
    expect(draft.items.map((item) => item.downloadId).toSet(), hasLength(2));
    expect(draft.items.map((item) => item.occurrenceId).toSet(), hasLength(3));
    expect(
      await offline.bind(
        draft.generation,
        await ready([DownloadHarness.track, second]),
      ),
      isTrue,
    );
    expect(await offline.commit(draft.generation), isTrue);
    final requests = h.requests.length;
    final restored = await OfflineMixRepository(
      downloads: h.newRepository(),
      fence: h.fence,
    ).read();
    expect(
      restored.active!.tracks.map((track) => track.ref),
      tracks.map((track) => track.ref),
    );
    expect(
      restored.active!.items.map((item) => item.occurrenceId),
      draft.items.map((item) => item.occurrenceId),
    );
    expect(
      h.requests.length,
      requests,
      reason: 'Restoring a manifest never contacts the server.',
    );
    expect(restored.pending, isNull);
  });

  test(
    'unbound or unfinished refresh keeps the complete previous active mix',
    () async {
      final old = await install([DownloadHarness.track]);
      final draft = await offline.stage(mix([second]));
      expect(await offline.commit(draft.generation), isFalse);
      final queued = await h.repo.enqueue(second, 'original', h.fence);
      expect(await offline.bind(draft.generation, [queued]), isTrue);
      expect(await offline.commit(draft.generation), isFalse);
      expect((await offline.read()).active!.generation, old.generation);
      expect(
        await h.repo.openReady(DownloadHarness.track.ref, 'original', h.fence),
        isNotNull,
      );
    },
  );

  test(
    'frozen file survives a newer ready representation of the same track',
    () async {
      final saved = await install([DownloadHarness.track]);
      final old = (await h.repo.list(h.fence)).single;
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
      h.handler = (request) => h.send(request, bytes: wavBytes(8000));
      expect(
        await h.runner.run(retry.id, h.fence, retry.generation),
        DownloadRunResult.ready,
      );
      final frozen = await offline.openVerifiedFile(
        saved.generation,
        DownloadHarness.track.ref,
      );
      expect(frozen, isNotNull);
      expect(await frozen!.length(), old.bytes);
      final newest = await h.repo.openReady(
        DownloadHarness.track.ref,
        'original',
        h.fence,
      );
      expect(await newest!.length(), isNot(old.bytes));
      expect(frozen.uri, isNot(newest.uri));
    },
  );

  test('cold reader opens exact snapshot locally and refuses explicitly removed media', () async {
    final saved = await install([DownloadHarness.track]);
    final cold = OfflineMixRepository(
      downloads: h.newRepository(),
      fence: h.fence,
    );
    final requests = h.requests.length;
    expect(
      await cold.openVerifiedFile(saved.generation, DownloadHarness.track.ref),
      isNotNull,
    );
    expect(h.requests.length, requests);
    final job = (await h.repo.list(h.fence)).single;
    await h.repo.remove(job.id, h.fence, expectedGeneration: job.generation);
    expect(
      await cold.openVerifiedFile(saved.generation, DownloadHarness.track.ref),
      isNull,
    );
  });

  test(
    'file lookup admits only active or previous generation and current owner',
    () async {
      final a = await install([DownloadHarness.track]);
      final b = await install([DownloadHarness.track]);
      final c = await install([DownloadHarness.track]);
      expect(
        await offline.openVerifiedFile(a.generation, DownloadHarness.track.ref),
        isNull,
      );
      expect(
        await offline.openVerifiedFile(b.generation, DownloadHarness.track.ref),
        isNotNull,
      );
      expect(
        await offline.openVerifiedFile(c.generation, DownloadHarness.track.ref),
        isNotNull,
      );
      await h.authority.invalidate();
      await expectLater(
        offline.openVerifiedFile(c.generation, DownloadHarness.track.ref),
        throwsA(isA<AppFailure>()),
      );
    },
  );

  test(
    'a corrupt ready file cannot replace an older complete snapshot',
    () async {
      final old = await install([DownloadHarness.track]);
      final draft = await offline.stage(mix([second]));
      final jobs = await ready([second]);
      await offline.bind(draft.generation, jobs);
      final cp = jobs.single.checkpoint!;
      final file = await h.paths.file(
        h.fence.owner,
        jobs.single.id,
        cp.generation,
        cp.claim,
        ready: true,
      );
      await file.writeAsBytes([1, 2, 3]);
      expect(await offline.commit(draft.generation), isFalse);
      expect((await offline.read()).active!.generation, old.generation);
    },
  );

  test(
    'late completion cannot publish after a newer source snapshot is staged',
    () async {
      final old = await install([DownloadHarness.track]);
      final first = await offline.stage(mix([second]));
      await offline.bind(first.generation, await ready([second]));
      final committing = offline.commit(first.generation);
      final newer = await offline.stage(
        mix([DownloadHarness.track], title: 'Другой состав'),
      );
      expect(await committing, isFalse);
      final state = await offline.read();
      expect(state.active!.generation, old.generation);
      expect(state.pending!.generation, newer.generation);
    },
  );

  test(
    'failed atomic manifest write retains the old active and retryable draft',
    () async {
      final old = await install([DownloadHarness.track]);
      final draft = await offline.stage(mix([second]));
      await offline.bind(draft.generation, await ready([second]));
      h.store.failState = 'active';
      await expectLater(
        offline.commit(draft.generation),
        throwsA(isA<Exception>()),
      );
      h.store.failState = null;
      expect((await offline.read()).active!.generation, old.generation);
      expect((await offline.read()).pending!.generation, draft.generation);
      expect(await offline.commit(draft.generation), isTrue);
      expect((await offline.read()).previous!.generation, old.generation);
    },
  );

  test(
    'cancel is conditional, keeps active and never reuses a generation',
    () async {
      final old = await install([DownloadHarness.track]);
      final a = await offline.stage(mix([second]));
      final b = await offline.stage(mix([second]));
      expect(await offline.cancel(a.generation), isFalse);
      expect(await offline.cancel(b.generation), isTrue);
      final c = await offline.stage(mix([second]));
      expect(c.generation, greaterThan(b.generation));
      expect((await offline.read()).active!.generation, old.generation);
    },
  );

  test('retired owner cannot stage or commit a file set', () async {
    final draft = await offline.stage(mix([DownloadHarness.track]));
    await offline.bind(draft.generation, await ready([DownloadHarness.track]));
    final before = jsonEncode(h.store.rows);
    await h.authority.invalidate();
    await expectLater(
      offline.commit(draft.generation),
      throwsA(isA<AppFailure>()),
    );
    expect(jsonEncode(h.store.rows), before);
  });

  for (final source in [
    mix([], loaded: true),
    mix([DownloadHarness.track], loaded: false),
    mix([
      const Track(
        ref: LibraryTrackRef('unavailable'),
        title: 'Нет',
        artist: 'Автор',
        playbackAllowed: false,
      ),
    ]),
  ]) {
    test(
      'incomplete source is rejected without silently shortening the snapshot ${source.loaded}/${source.tracks.length}/${source.playableCount}',
      () async {
        await expectLater(offline.stage(source), throwsA(isA<AppFailure>()));
        expect((await offline.read()).pending, isNull);
      },
    );
  }
}
