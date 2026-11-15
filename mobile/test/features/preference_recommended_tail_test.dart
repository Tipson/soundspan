import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/features/likes/likes_models.dart';
import 'package:soundspan/features/likes/preference_controller.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/queue_coordinator.dart';

import '../support/collection_fixtures.dart';

class _Engine implements PlaybackEngine {
  int loads = 0;
  int stops = 0;
  @override
  Stream<EngineEvent> get events => const Stream.empty();
  @override
  Future<void> load(Uri uri, int generation) async => loads++;
  @override
  Future<void> play() async {}
  @override
  Future<void> pause() async {}
  @override
  Future<void> stop() async => stops++;
  @override
  Future<void> seek(Duration position) async {}
  @override
  Future<void> setVolume(double volume) async {}
  @override
  Future<void> dispose() async {}
}

const _recommended = PlayContext(
  surface: PlaySurface.wave,
  waveMode: WaveMode.forYou,
  recommendationGenerationId: 'generation-1',
  recommendationSessionId: 'session-1',
);

void main() {
  late CollectionAuthority authority;
  late _Engine engine;
  late QueueCoordinator queue;
  late PreferenceController preferences;
  setUp(() {
    authority = CollectionAuthority();
    engine = _Engine();
    queue = QueueCoordinator(
      authority: authority,
      engine: engine,
      prepare: (_, _) async => PreparedAudio(
        uri: Uri.parse('http://127.0.0.1/synthetic'),
        revoke: () async {},
      ),
    );
    preferences = PreferenceController(
      authority: authority,
      fence: collectionFence,
      playback: queue,
      transport: CollectionTransport(
        (request, _) => preferenceResponse(
          Uri.decodeComponent(request.path.split('/')[4]),
          request.body!['signal'] as String,
        ),
      ),
    );
  });
  tearDown(() async {
    preferences.dispose();
    await queue.dispose();
    await authority.updates.close();
  });

  Future<List<QueueEntry>> seed(PlayContext context) async {
    final entries = queue.createEntries([
      collectionTrack(1),
      collectionTrack(2),
      collectionTrack(1),
      collectionTrack(3),
    ], context);
    await queue.dispatch(ReplaceQueue(entries, fence: collectionFence));
    return entries;
  }

  test(
    'confirmed dislike removes exact future Wave duplicate after skip',
    () async {
      final entries = await seed(_recommended);
      await preferences.set(entries.first.track.ref, PreferenceSignal.dislike);
      await Future<void>.delayed(Duration.zero);
      final current = queue.snapshot;
      expect(current.currentEntryId, entries[1].entryId);
      final position = current.effectiveOrder.indexOf(current.currentEntryId!);
      final future = current.effectiveOrder.skip(position + 1).toSet();
      expect(future, isNot(contains(entries[2].entryId)));
      expect(
        current.entries.map((entry) => entry.entryId),
        contains(entries.first.entryId),
      );
      expect(future, contains(entries.last.entryId));
    },
  );

  test(
    'negative on future Wave row preserves current37s and decoder',
    () async {
      final entries = await seed(_recommended);
      await queue.dispatch(PlayEntry(entries[1].entryId));
      await queue.dispatch(const Seek(Duration(seconds: 37)));
      final before = queue.snapshot;
      final loads = engine.loads;
      final stops = engine.stops;
      await preferences.set(entries[2].track.ref, PreferenceSignal.dislike);
      await Future<void>.delayed(Duration.zero);
      final after = queue.snapshot;
      expect(after.currentEntryId, before.currentEntryId);
      expect(after.position, const Duration(seconds: 37));
      expect(after.generation, before.generation);
      expect(after.lineage, before.lineage);
      expect(engine.loads, loads);
      expect(engine.stops, stops);
      expect(
        after.entries.map((entry) => entry.entryId),
        isNot(contains(entries[2].entryId)),
      );
      expect(
        after.entries.map((entry) => entry.entryId),
        contains(entries.first.entryId),
      );
      expect(
        after.entries.map((entry) => entry.track.ref),
        contains(const LibraryTrackRef('local-3')),
      );
    },
  );

  test('manual playlist occurrences are preserved after a dislike', () async {
    final entries = await seed(
      const PlayContext(surface: PlaySurface.playlist),
    );
    await preferences.set(entries.first.track.ref, PreferenceSignal.dislike);
    await Future<void>.delayed(Duration.zero);
    expect(
      queue.snapshot.entries.map((entry) => entry.entryId),
      entries.map((entry) => entry.entryId),
    );
    expect(queue.snapshot.currentEntryId, entries[1].entryId);
  });

  test('late Wave refill cannot reinsert a confirmed exact negative', () async {
    final entries = await seed(_recommended);
    await preferences.set(entries.first.track.ref, PreferenceSignal.dislike);
    await Future<void>.delayed(Duration.zero);
    final before = queue.snapshot;
    final refill = queue.createEntries([
      collectionTrack(1),
      collectionTrack(4),
    ], _recommended);
    await queue.dispatch(
      Enqueue(
        refill,
        fence: collectionFence,
        expectedLineage: before.lineage,
        automaticRecommendation: true,
      ),
    );
    expect(
      queue.snapshot.entries.map((entry) => entry.entryId),
      isNot(contains(refill.first.entryId)),
    );
    expect(
      queue.snapshot.entries.map((entry) => entry.entryId),
      contains(refill.last.entryId),
    );
    expect(queue.snapshot.currentEntryId, before.currentEntryId);
    expect(queue.snapshot.lineage, before.lineage);
  });

  test(
    'adjacent exact duplicate is skipped before a slow dislike ACK',
    () async {
      preferences.dispose();
      final held = Completer<ApiResponse>();
      preferences = PreferenceController(
        authority: authority,
        fence: collectionFence,
        playback: queue,
        transport: CollectionTransport((_, _) => held.future),
      );
      final entries = queue.createEntries([
        collectionTrack(1),
        collectionTrack(1),
        collectionTrack(2),
      ], _recommended);
      await queue.dispatch(ReplaceQueue(entries, fence: collectionFence));
      final writing = preferences.set(
        entries.first.track.ref,
        PreferenceSignal.dislike,
      );
      await Future<void>.delayed(Duration.zero);
      final selectedBeforeAck = queue.snapshot.currentEntryId;
      held.complete(preferenceResponse('local-1', 'thumbs_down'));
      await writing;
      expect(selectedBeforeAck, entries.last.entryId);
      expect(queue.snapshot.currentEntryId, entries.last.entryId);
    },
  );

  test(
    'clear allows fresh refill without restoring the removed occurrence',
    () async {
      final entries = await seed(_recommended);
      await preferences.set(entries.first.track.ref, PreferenceSignal.dislike);
      await preferences.set(entries.first.track.ref, PreferenceSignal.clear);
      final fresh = queue.createEntries([collectionTrack(1)], _recommended);
      await queue.dispatch(
        Enqueue(
          fresh,
          fence: collectionFence,
          expectedLineage: queue.snapshot.lineage,
          automaticRecommendation: true,
        ),
      );
      expect(
        queue.snapshot.entries.map((entry) => entry.entryId),
        isNot(contains(entries[2].entryId)),
      );
      expect(
        queue.snapshot.entries.map((entry) => entry.entryId),
        contains(fresh.single.entryId),
      );
    },
  );

  test(
    'automatic replacement chooses an admitted initial occurrence',
    () async {
      final entries = await seed(_recommended);
      await preferences.set(entries.first.track.ref, PreferenceSignal.dislike);
      final replacement = queue.createEntries([
        collectionTrack(1),
        collectionTrack(4),
      ], _recommended);
      await queue.dispatch(
        ReplaceQueue(
          replacement,
          fence: collectionFence,
          expectedLineage: queue.snapshot.lineage,
          automaticRecommendation: true,
          initialEntryId: replacement.first.entryId,
        ),
      );
      expect(queue.snapshot.currentEntryId, replacement.last.entryId);
      expect(queue.snapshot.processing, isNot(PlaybackProcessing.failed));
    },
  );

  test(
    'repeat-all never automatically selects a disliked past occurrence',
    () async {
      final entries = await seed(_recommended);
      await preferences.set(entries.first.track.ref, PreferenceSignal.dislike);
      await queue.dispatch(const SetRepeat(QueueRepeat.all));
      await queue.dispatch(PlayEntry(entries.last.entryId));
      await queue.dispatch(const Next());
      expect(queue.snapshot.currentEntryId, entries[1].entryId);
    },
  );

  test(
    'late checkpoint restore cannot reinsert an already pruned future row',
    () async {
      final entries = await seed(_recommended);
      final checkpoint = queue.snapshot;
      await preferences.set(entries[2].track.ref, PreferenceSignal.dislike);
      await queue.dispatch(
        RestoreQueue(
          checkpoint,
          fence: collectionFence,
          expectedLineage: queue.snapshot.lineage,
        ),
      );
      final restored = queue.snapshot;
      final index = restored.effectiveOrder.indexOf(restored.currentEntryId!);
      expect(
        restored.effectiveOrder.skip(index + 1),
        isNot(contains(entries[2].entryId)),
      );
      expect(restored.playingIntent, isFalse);
    },
  );

  test(
    'late ACK cannot move an exclusion into another recommendation scope',
    () async {
      preferences.dispose();
      final held = Completer<ApiResponse>();
      preferences = PreferenceController(
        authority: authority,
        fence: collectionFence,
        playback: queue,
        transport: CollectionTransport((_, _) => held.future),
      );
      const other = PlayContext(
        surface: PlaySurface.wave,
        recommendationSessionId: 'session-2',
        recommendationGenerationId: 'generation-2',
      );
      final first = queue.createEntries([
        collectionTrack(2),
        collectionTrack(1),
      ], _recommended);
      final second = queue.createEntries([
        collectionTrack(3),
        collectionTrack(1),
      ], other);
      await queue.dispatch(ReplaceQueue(first, fence: collectionFence));
      await queue.dispatch(Enqueue(second, fence: collectionFence));
      final writing = preferences.set(
        first.last.track.ref,
        PreferenceSignal.dislike,
      );
      await Future<void>.delayed(Duration.zero);
      await queue.dispatch(PlayEntry(second.first.entryId));
      held.complete(preferenceResponse('local-1', 'thumbs_down'));
      await writing;
      expect(queue.snapshot.currentEntryId, second.first.entryId);
      expect(
        queue.snapshot.entries.map((entry) => entry.entryId),
        contains(second.last.entryId),
      );
      expect(
        queue.snapshot.allowsRecommendation(second.last.track.ref, other),
        isTrue,
      );
    },
  );

  test(
    'exclusion capacity cannot permanently close a fresh Wave session',
    () async {
      await seed(_recommended);
      for (var i = 0; i <= 2000; i++) {
        await queue.dispatch(
          SetRecommendationExclusion(
            LibraryTrackRef('negative-$i'),
            fence: collectionFence,
            expectedLineage: queue.snapshot.lineage,
            recommendationScope: _recommended.recommendationScopeKey!,
          ),
        );
      }
      expect(
        queue.snapshot.allowsRecommendation(
          collectionTrack(8).ref,
          _recommended,
        ),
        isFalse,
      );
      const freshContext = PlayContext(
        surface: PlaySurface.wave,
        recommendationSessionId: 'fresh-session',
        recommendationGenerationId: 'fresh-generation',
      );
      final fresh = queue.createEntries([collectionTrack(8)], freshContext);
      await queue.dispatch(
        ReplaceQueue(
          fresh,
          fence: collectionFence,
          expectedLineage: queue.snapshot.lineage,
          automaticRecommendation: true,
        ),
      );
      expect(queue.snapshot.currentEntryId, fresh.single.entryId);
      expect(
        queue.snapshot.allowsRecommendation(
          fresh.single.track.ref,
          freshContext,
        ),
        isTrue,
      );
    },
  );
}
