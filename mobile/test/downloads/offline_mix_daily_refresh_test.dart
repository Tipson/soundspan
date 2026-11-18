import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/downloads/automatic_download_control.dart';
import 'package:soundspan/downloads/download_models.dart';
import 'package:soundspan/downloads/offline_mix_daily_refresh.dart';
import 'package:soundspan/downloads/offline_mix_refresh_policy.dart';
import 'package:soundspan/downloads/offline_mix_repository.dart';
import 'package:soundspan/features/home/home_models.dart';

import 'download_fixture.dart';
import '../support/collection_fixtures.dart' show CollectionAuthority;

import 'package:soundspan/downloads/download_repository.dart';

void main() {
  late DownloadHarness h;
  late OfflineMixRepository mixes;
  late OfflineMixRefreshPolicy policy;
  late OfflineMixDailyRefresh daily;
  var charging = true, unmetered = true, sourceCalls = 0;
  var transfers = true;
  late MusicMix? source;
  final scheduled = <DeviceDownload>[];
  final periods = <int>[];
  final cancelled = <DeviceDownload>[];
  Future<void> Function()? onLoad;
  MusicMix mix(
    List<Track> tracks, {
    String title = 'Daily',
    String id = 'test',
  }) => MusicMix(
    id: id,
    title: title,
    description: '',
    kind: MusicMixKind.daily,
    tracks: tracks,
    loaded: true,
  );
  const next = Track(
    ref: LibraryTrackRef('new-daily'),
    title: 'New',
    artist: 'QA',
  );
  setUp(() async {
    charging = true;
    unmetered = true;
    sourceCalls = 0;
    transfers = true;
    scheduled.clear();
    periods.clear();
    cancelled.clear();
    onLoad = null;
    h = await DownloadHarness.create();
    mixes = OfflineMixRepository(downloads: h.repo, fence: h.fence);
    policy = OfflineMixRefreshPolicy(store: h.store, fence: h.fence);
    final job = await h.repo.enqueue(
      DownloadHarness.track,
      'original',
      h.fence,
    );
    expect(
      await h.runner.run(job.id, h.fence, job.generation),
      DownloadRunResult.ready,
    );
    final initial = await mixes.stage(mix([DownloadHarness.track]));
    expect(
      await mixes.bind(initial.generation, [
        (await h.repo.status(job.id, h.fence))!,
      ]),
      isTrue,
    );
    expect(await mixes.commit(initial.generation), isTrue);
    source = mix([next]);
    daily = OfflineMixDailyRefresh(
      mixes: mixes,
      policy: policy,
      conditions: () async =>
          OfflineMixRefreshConditions(charging: charging, unmetered: unmetered),
      requireNetwork: () async {},
      loadSource: (identity, admit) async {
        sourceCalls++;
        await admit();
        await onLoad?.call();
        return source;
      },
      scheduleFile: (job, revision) async {
        scheduled.add(job);
        expect(revision, isNotNull);
        if (!transfers) return;
        final runner = h.newRunner(
          h.repo,
          revalidateNetwork: daily.requireFile,
        );
        try {
          expect(
            await runner.run(job.id, h.fence, job.generation),
            DownloadRunResult.ready,
          );
        } finally {
          await runner.close();
        }
      },
      schedulePeriodic: (revision) async => periods.add(revision),
      retryPeriodic: (revision) async => periods.add(revision),
      cancelPeriodic: (_) async {},
      cancelFile: (job) async => cancelled.add(job),
    );
  });
  tearDown(() => h.close());

  test('default off produces no source fetch or file jobs', () async {
    await daily.ensureScheduled();
    await daily.run(0);
    expect(periods, isEmpty);
    expect(sourceCalls, 0);
    expect(scheduled, isEmpty);
  });
  test('new owner epoch replaces only old automatic pending and keeps original fence rejected', () async {
    transfers = false;
    await daily.configure(true);
    await daily.run((await policy.read()).revision);
    final oldFence = h.fence;
    final oldPending = (await mixes.read()).pending!;
    final authority = CollectionAuthority()
      ..active = SessionFence(owner: oldFence.owner, epoch: oldFence.epoch + 1);
    final fence = authority.requireFence();
    final store = DownloadTestStore(authority)..rows = Map.of(h.store.rows);
    final repo = DownloadRepository(
      store: store,
      authority: authority,
      paths: h.paths,
      verifier: h.repo.verifier,
      beforeRemove: (_) async {},
    );
    final restoredMixes = OfflineMixRepository(downloads: repo, fence: fence);
    final restoredPolicy = OfflineMixRefreshPolicy(store: store, fence: fence);
    final restored = OfflineMixDailyRefresh(
      mixes: restoredMixes,
      policy: restoredPolicy,
      conditions: daily.conditions,
      requireNetwork: () async {},
      loadSource: (_, admit) async {
        await admit();
        return mix([DownloadHarness.track]);
      },
      scheduleFile: (_, _) async =>
          throw StateError('cached composition needs no file work'),
      schedulePeriodic: (_) async {},
      retryPeriodic: (_) async {},
      cancelPeriodic: (_) async {},
      cancelFile: (_) async {},
    );
    await restored.run((await restoredPolicy.read()).revision);
    final current = await restoredMixes.read();
    expect(current.active!.generation, greaterThan(oldPending.generation));
    expect(current.active!.ownerEpoch, fence.epoch);
    expect(current.previous!.tracks.single.ref, DownloadHarness.track.ref);
    await expectLater(
      store.transaction(oldFence, (tx) => tx.list('offlineMix.v1')),
      throwsA(anything),
    );
    await authority.updates.close();
  });
  test('durable pending refresh recovers missing native enqueue without refetch or new generation', () async {
    transfers = false;
    await daily.configure(true);
    final revision = (await policy.read()).revision;
    await daily.run(revision);
    final captured = scheduled.single;
    transfers = true;
    scheduled.clear();
    await daily.run(revision);
    expect((await mixes.read()).active!.tracks.single.ref, next.ref);
    expect(sourceCalls, 1);
    expect(scheduled.single.id, captured.id);
    expect(scheduled.single.generation, captured.generation);
  });
  test(
    'server holdoff blocks repeat source HTTP and keeps the complete manifest',
    () async {
      await daily.configure(true);
      final revision = (await policy.read()).revision;
      onLoad = () async => throw const AppFailure(
        code: 'http_rate_limited',
        message: 'wait',
        retryable: true,
        retryAfter: Duration(minutes: 30),
      );
      await expectLater(daily.run(revision), throwsA(isA<AppFailure>()));
      await expectLater(daily.run(revision), throwsA(isA<AppFailure>()));
      await daily.configure(false);
      await daily.configure(true);
      await expectLater(
        daily.run((await policy.read()).revision),
        throwsA(isA<AppFailure>()),
      );
      expect(sourceCalls, 1);
      expect(
        (await mixes.read()).active!.tracks.single.ref,
        DownloadHarness.track.ref,
      );
    },
  );

  test(
    'concurrent periodic and retry triggers share one durable attempt',
    () async {
      await daily.configure(true);
      final revision = (await policy.read()).revision;
      final entered = Completer<void>(), release = Completer<void>();
      onLoad = () async {
        entered.complete();
        await release.future;
      };
      final first = daily.run(revision);
      await entered.future;
      await daily.run(revision);
      release.complete();
      await first;
      expect(sourceCalls, 1);
      expect(scheduled, hasLength(1));
    },
  );

  test('lost charging blocks actual T07 HTTP and later retry preserves complete mix', () async {
    transfers = false;
    await daily.configure(true);
    await daily.run((await policy.read()).revision);
    final job = scheduled.single;
    final before = h.requests.length;
    charging = false;
    final runner = h.newRunner(h.repo, revalidateNetwork: daily.requireFile);
    addTearDown(runner.close);
    expect(
      await runner.run(job.id, h.fence, job.generation),
      DownloadRunResult.retry,
    );
    expect(h.requests.length, before);
    expect(
      (await mixes.read()).active!.tracks.single.ref,
      DownloadHarness.track.ref,
    );
    charging = true;
    expect(
      await runner.run(job.id, h.fence, job.generation),
      DownloadRunResult.ready,
    );
    expect(await daily.commitIfReady(), isTrue);
    expect(
      (await mixes.read()).previous!.tracks.single.ref,
      DownloadHarness.track.ref,
    );
  });

  test('disable retires only owned pending daily generation before an old native spec runs', () async {
    transfers = false;
    await daily.configure(true);
    await daily.run((await policy.read()).revision);
    final job = scheduled.single;
    await daily.configure(false);
    final current = (await h.repo.status(job.id, h.fence))!;
    expect(current.generation, job.generation + 1);
    expect(current.state, DownloadState.paused);
    expect(cancelled.single.generation, job.generation);
    final before = h.requests.length;
    expect(
      await h.runner.run(job.id, h.fence, job.generation),
      DownloadRunResult.cancelled,
    );
    expect(h.requests.length, before);
    expect(
      (await mixes.read()).active!.tracks.single.ref,
      DownloadHarness.track.ref,
    );
  });
  test('daily refresh reuses T07 despite disabled likes and atomically retains previous', () async {
    await h.store.transaction(
      h.fence,
      (tx) => tx.write(
        AutomaticDownloadControl.namespace,
        AutomaticDownloadControl.key,
        AutomaticDownloadControl.encode(true),
      ),
    );
    await daily.configure(true);
    final enabled = await policy.read();
    await daily.run(enabled.revision);
    final current = await mixes.read();
    expect(current.active!.tracks.single.ref, next.ref);
    expect(current.previous!.tracks.single.ref, DownloadHarness.track.ref);
    expect((await policy.read()).lastSuccessAt, greaterThan(0));
    expect(scheduled.single.manual, isFalse);
    expect(scheduled.single.origins, {'offlineMixDaily'});
    await daily.run(enabled.revision);
    expect(sourceCalls, 1);
  });
  test('missing empty renamed source and provider failure preserve complete manifest', () async {
    await daily.configure(true);
    final revision = (await policy.read()).revision;
    for (final candidate in [
      null,
      mix([]),
      mix([next], title: 'Renamed'),
      mix([next], id: 'unrelated'),
    ]) {
      source = candidate;
      await expectLater(daily.run(revision), throwsA(anything));
      expect(
        (await mixes.read()).active!.tracks.single.ref,
        DownloadHarness.track.ref,
      );
      expect(scheduled, isEmpty);
    }
    onLoad = () async => throw StateError('provider unavailable');
    await expectLater(daily.run(revision), throwsA(anything));
    expect(
      (await mixes.read()).active!.tracks.single.ref,
      DownloadHarness.track.ref,
    );
  });
  test('not charging or metered causes no provider request', () async {
    await daily.configure(true);
    final revision = (await policy.read()).revision;
    charging = false;
    await daily.run(revision);
    charging = true;
    unmetered = false;
    await daily.run(revision);
    expect(sourceCalls, 0);
    expect(scheduled, isEmpty);
  });
  test(
    'disable during source fetch prevents stage jobs and manifest effects',
    () async {
      await daily.configure(true);
      final entered = Completer<void>(), release = Completer<void>();
      onLoad = () async {
        entered.complete();
        await release.future;
      };
      final running = daily.run((await policy.read()).revision);
      final failure = expectLater(running, throwsA(anything));
      await entered.future;
      await daily.configure(false);
      release.complete();
      await failure;
      expect(scheduled, isEmpty);
      expect(
        (await mixes.read()).active!.tracks.single.ref,
        DownloadHarness.track.ref,
      );
    },
  );
  test('old queued file spec cannot write after disable and manual promotion is retained', () async {
    transfers = false;
    await daily.configure(true);
    await daily.run((await policy.read()).revision);
    final automatic = scheduled.single;
    final promoted = await h.repo.enqueue(
      automatic.track,
      automatic.quality,
      h.fence,
    );
    await daily.configure(false);
    expect(
      (await h.repo.status(promoted.id, h.fence))!.generation,
      promoted.generation,
    );
    expect(
      await h.runner.run(promoted.id, h.fence, promoted.generation),
      DownloadRunResult.ready,
    );
    expect(
      (await mixes.read()).active!.tracks.single.ref,
      DownloadHarness.track.ref,
    );
  });
}
