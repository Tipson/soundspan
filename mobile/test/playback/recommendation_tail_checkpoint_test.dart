import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/features/recommendations/recommendation_repository.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/queue_coordinator.dart';
import 'package:soundspan/playback/queue_snapshot_store.dart';
import 'package:soundspan/playback/wave_continuation.dart';

import '../support/collection_fixtures.dart';
import '../support/wave_reporting_fixtures.dart' show ReportingStore;
import 'queue_coordinator_test.dart' show FakeEngine;

const _context = PlayContext(
  surface: PlaySurface.wave,
  recommendationSessionId: 'checkpoint-session',
  recommendationGenerationId: 'checkpoint-generation',
);

void main() {
  late CollectionAuthority authority;
  late ReportingStore owners;
  late QueueSnapshotStore store;
  late QueueCoordinator queue;
  late List<QueueEntry> entries;
  QueueCoordinator createQueue(FakeEngine engine) => QueueCoordinator(
    authority: authority,
    engine: engine,
    prepare: (_, _) async => PreparedAudio(
      uri: Uri.parse('http://127.0.0.1/synthetic'),
      revoke: () async {},
    ),
  );
  Map<String, Map<String, Object?>> getRows() => owners.records.values.single;
  setUp(() async {
    authority = CollectionAuthority();
    owners = ReportingStore();
    store = QueueSnapshotStore(owners);
    queue = createQueue(FakeEngine());
    entries = queue.createEntries([
      collectionTrack(1),
      collectionTrack(2),
      collectionTrack(1),
      collectionTrack(3),
    ], _context);
    await queue.dispatch(ReplaceQueue(entries, fence: collectionFence));
    await queue.dispatch(
      SetRecommendationExclusion(
        entries.first.track.ref,
        fence: collectionFence,
        expectedLineage: queue.snapshot.lineage,
        recommendationScope: _context.recommendationScopeKey!,
        advanceEntryId: entries.first.entryId,
        advanceGeneration: queue.snapshot.generation,
      ),
    );
    await Future<void>.delayed(Duration.zero);
    await queue.dispatch(const SetRepeat(QueueRepeat.all));
    await queue.dispatch(const Seek(Duration(seconds: 37)));
    await store.save(queue.snapshot, collectionFence);
  });
  tearDown(() async {
    await queue.dispose();
    await authority.updates.close();
  });

  test(
    'restart keeps the exact guard without changing the legacy snapshot shape',
    () async {
      final payload = getRows()['queue/snapshot']!;
      expect(payload.keys.toSet(), {
        'version',
        'entries',
        'effectiveOrder',
        'currentEntryId',
        'positionUs',
        'durationUs',
        'shuffle',
        'repeat',
        'volume',
      });
      final loaded = await QueueSnapshotStore(owners).load(collectionFence);
      expect(loaded, isNotNull);
      expect(
        loaded!.allowsRecommendation(entries.first.track.ref, _context),
        isFalse,
      );
      await queue.dispose();
      final engine = FakeEngine();
      queue = createQueue(engine);
      final transport = CollectionTransport(
        (_, _) => throw StateError('Unexpected automatic network work'),
      );
      final wave = WaveContinuation(
        controller: queue,
        repository: RecommendationRepository(transport: transport),
        authority: authority,
      );
      addTearDown(wave.dispose);
      await queue.dispatch(
        RestoreQueue(
          loaded,
          fence: collectionFence,
          expectedLineage: queue.snapshot.lineage,
        ),
      );
      await Future<void>.delayed(Duration.zero);
      expect(queue.snapshot.currentEntryId, entries[1].entryId);
      expect(queue.snapshot.position, const Duration(seconds: 37));
      expect(engine.loaded, isEmpty);
      expect(engine.plays, 0);
      expect(wave.state.status, WaveStatus.detached);
      expect(transport.requests, isEmpty);
      await queue.dispatch(PlayEntry(entries.last.entryId));
      await queue.dispatch(const Next());
      expect(queue.snapshot.currentEntryId, entries[1].entryId);
    },
  );

  test('clear drops the supplemental policy while removed occurrences stay removed', () async {
    await queue.dispatch(
      SetRecommendationExclusion(
        entries.first.track.ref,
        fence: collectionFence,
        expectedLineage: queue.snapshot.lineage,
        recommendationScope: _context.recommendationScopeKey!,
        exclude: false,
      ),
    );
    await store.save(queue.snapshot, collectionFence);
    expect(getRows().containsKey('queue/recommendation-policy'), isFalse);
    final loaded = await QueueSnapshotStore(owners).load(collectionFence);
    expect(
      loaded!.allowsRecommendation(entries.first.track.ref, _context),
      isTrue,
    );
    expect(
      loaded.entries.map((entry) => entry.entryId),
      isNot(contains(entries[2].entryId)),
    );
  });

  test('unknown bound policy preserves metadata and closes only automatic recommendations', () async {
    getRows()['queue/recommendation-policy'] = {
      'version': 999,
      'entryIds': queue.snapshot.entries.map((entry) => entry.entryId).toList()
        ..sort(),
    };
    final loaded = await QueueSnapshotStore(owners).load(collectionFence);
    expect(loaded, isNotNull);
    expect(loaded!.currentEntryId, entries[1].entryId);
    expect(loaded.position, const Duration(seconds: 37));
    expect(
      loaded.allowsRecommendation(entries.last.track.ref, _context),
      isFalse,
    );
    expect(
      loaded.allowsRecommendation(
        entries.last.track.ref,
        const PlayContext(surface: PlaySurface.playlist),
      ),
      isTrue,
    );
  });

  test(
    'an old policy from another occurrence set cannot affect a new queue',
    () async {
      final payload = getRows()['queue/snapshot']!;
      final old = (payload['entries'] as List).first as Map<String, Object?>;
      final id = old['entryId'] as String;
      old['entryId'] = 'new-occurrence';
      payload['effectiveOrder'] = [
        for (final item in payload['effectiveOrder'] as List)
          item == id ? 'new-occurrence' : item,
      ];
      final loaded = await QueueSnapshotStore(owners).load(collectionFence);
      expect(loaded, isNotNull);
      expect(
        loaded!.allowsRecommendation(entries.first.track.ref, _context),
        isTrue,
      );
    },
  );

  test(
    'another owner never receives this checkpoint or its negative policy',
    () async {
      final other = SessionFence(
        owner: OwnerKey(serverOrigin: collectionOrigin, userId: 'other-owner'),
        epoch: 2,
      );
      expect(await QueueSnapshotStore(owners).load(other), isNull);
    },
  );

  test(
    'restoring another bounded policy cannot exceed the combined limit',
    () async {
      final before = queue.snapshot;
      final restored = QueueSnapshot(
        entries: before.entries,
        effectiveOrder: before.effectiveOrder,
        currentEntryId: before.currentEntryId,
        fence: collectionFence,
        recommendationExclusions: {
          _context.recommendationScopeKey!: {
            for (var i = 0; i < 2000; i++) 'yt:other-$i',
          },
        },
      );
      await queue.dispatch(
        RestoreQueue(
          restored,
          fence: collectionFence,
          expectedLineage: before.lineage,
        ),
      );
      final after = queue.snapshot;
      expect(
        after.recommendationExclusions.values.fold(
          0,
          (sum, refs) => sum + refs.length,
        ),
        lessThanOrEqualTo(2000),
      );
      expect(
        after.allowsRecommendation(entries.last.track.ref, _context),
        isFalse,
      );
      expect(after.currentEntryId, before.currentEntryId);
      await store.save(after, collectionFence);
      expect(await store.load(collectionFence), isNotNull);
    },
  );
}
