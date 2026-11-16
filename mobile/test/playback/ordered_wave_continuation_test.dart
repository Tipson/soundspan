import 'dart:async';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/features/recommendations/recommendation_repository.dart';
import 'package:soundspan/playback/finite_queue_admission_api.dart';
import 'package:soundspan/playback/finite_queue_admission_coordinator.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/queue_coordinator.dart';
import 'package:soundspan/playback/wave_continuation.dart';

import '../support/collection_fixtures.dart';
import '../support/wave_reporting_fixtures.dart';
import 'queue_coordinator_test.dart' show FakeEngine;

const sequence1 = '5d73c623-d11d-4fda-943e-0e01ce5b3be7';
const sequence2 = '5d73c623-d11d-4fda-943e-0e01ce5b3be8';
const firstIds = [
  'AAAAAAAAAA1',
  'DDDDDDDDDD1',
  'BBBBBBBBBB1',
  'AAAAAAAAAA2',
  'EEEEEEEEEE1',
  'CCCCCCCCCC1',
];
Map<String, Object?> orderedFeed(
  List<String> ids, {
  int start = 0,
  String sequence = sequence1,
}) => {
  'generationId': 'served-$start',
  'orderedWave': {
    'version': 1,
    'sequenceId': sequence,
    'startPosition': start,
    'nextCursor': 'cursor-$start',
    'items': [
      for (final (i, id) in ids.indexed)
        {'position': start + i, 'track': waveDto(id)},
    ],
    'tail': [
      for (final (i, id) in ids.indexed.skip(
        ids.length > 2 ? ids.length - 2 : 0,
      ))
        {'source': 'youtube', 'id': id, 'position': start + i},
    ],
  },
};
Future<void> settle() => Future<void>.delayed(const Duration(milliseconds: 30));

void main() {
  late CollectionAuthority authority;
  late FakeEngine engine;
  late QueueCoordinator queue;
  late FiniteQueueAdmissionCoordinator admission;
  late ControlledTransport transport;
  late WaveContinuation wave;
  late List<String> prepared;
  late bool? orderedEnabled;
  setUp(() {
    authority = CollectionAuthority();
    engine = FakeEngine();
    prepared = [];
    orderedEnabled = true;
    queue = QueueCoordinator(
      authority: authority,
      engine: engine,
      random: Random(9),
      prepare: (entry, _) async {
        prepared.add(entry.track.ref.identityKey);
        return PreparedAudio(
          uri: Uri.parse('http://127.0.0.1/synthetic'),
          revoke: () async {},
        );
      },
    );
    admission = FiniteQueueAdmissionCoordinator(
      api: FiniteQueueAdmissionApi(
        transport: CollectionTransport(
          (r, _) => ApiResponse(200, {
            'version': 1,
            'appliesTo': 'recommended_future',
            'decisions': [
              for (final ref in r.body!['references'] as List)
                {...ref as Map, 'state': 'allowed'},
            ],
          }),
        ),
      ),
      authority: authority,
      snapshot: () => queue.snapshot,
      snapshots: queue.snapshots,
    );
    queue.finiteAdmission = admission;
    transport = ControlledTransport();
    var sessions = 0;
    wave = WaveContinuation(
      controller: queue,
      repository: RecommendationRepository(
        transport: transport,
        orderedWaveCapability: (_, _) async => orderedEnabled,
      ),
      authority: authority,
      finiteAdmission: admission,
      sessionId: () => 'session-${++sessions}',
    );
  });
  tearDown(() async {
    await wave.dispose();
    await admission.close();
    await queue.dispose();
    await authority.updates.close();
  });

  for (final action in [
    'negative',
    'pause-resume',
    'seek',
    'shuffle-cycle',
    'shuffle-on',
  ]) {
    test(
      'automatic ordered Wave survives $action and keeps refilling naturally',
      () async {
        var reads = 0, nextPosition = 0;
        var sequence = sequence1;
        transport.respond = (request) async {
          reads++;
          if (reads == 1) {
            nextPosition = 6;
            return ApiResponse(200, orderedFeed(firstIds));
          }
          if (!request.query.containsKey('waveSequenceCursor')) {
            sequence = sequence2;
            nextPosition = 0;
          }
          final ids = [
            for (final prefix in ['F', 'G', 'H'])
              '$prefix${reads.toString().padLeft(10, '0')}',
          ];
          final feed = orderedFeed(
            ids,
            start: nextPosition,
            sequence: sequence,
          );
          nextPosition += ids.length;
          return ApiResponse(200, feed);
        };
        await wave.start(const WaveSelection(), collectionFence);
        engine.emit(position: const Duration(seconds: 37));
        await settle();
        final before = queue.snapshot;
        if (action == 'negative') {
          await queue.dispatch(
            SetRecommendationExclusion(
              before.currentEntry!.track.ref,
              fence: collectionFence,
              expectedLineage: before.lineage,
              recommendationScope:
                  before.currentEntry!.context.recommendationScopeKey!,
              advanceEntryId: before.currentEntryId,
              advanceGeneration: before.generation,
            ),
          );
        } else if (action == 'pause-resume') {
          await queue.dispatch(const Pause());
          await queue.dispatch(const Resume());
        } else if (action == 'seek') {
          await queue.dispatch(const Seek(Duration(seconds: 38)));
        } else {
          await queue.dispatch(const SetShuffle(true));
          if (action != 'shuffle-on') {
            await queue.dispatch(const SetShuffle(false));
          }
        }
        await settle();
        expect(wave.state.status, WaveStatus.active);
        for (var index = 0; index < 7; index++) {
          engine.emit(processing: PlaybackProcessing.completed);
          await settle();
        }
        expect(reads, greaterThanOrEqualTo(3));
        expect(wave.state.status, WaveStatus.active);
        expect(queue.snapshot.entries.length, greaterThan(firstIds.length));
        expect(queue.snapshot.processing, isNot(PlaybackProcessing.completed));
      },
    );
  }
  for (final action in ['clear', 'manual-collection']) {
    test(
      'ordered Wave detaches on $action without taking over the new queue',
      () async {
        var reads = 0;
        transport.respond = (_) async {
          reads++;
          return ApiResponse(200, orderedFeed(firstIds));
        };
        await wave.start(const WaveSelection(), collectionFence);
        if (action == 'clear') {
          await queue.dispatch(const Clear());
        } else {
          final chosen = queue.snapshot.currentEntry!.track;
          await queue.dispatch(
            ReplaceQueue(
              queue.createEntries([
                chosen,
              ], const PlayContext(surface: PlaySurface.library)),
              fence: collectionFence,
            ),
          );
        }
        await settle();
        final changed = queue.snapshot;
        engine.emit(processing: PlaybackProcessing.completed);
        await settle();
        expect(wave.state.status, WaveStatus.detached);
        expect(reads, 1);
        expect(queue.snapshot.entries, changed.entries);
      },
    );
  }

  test('initial ordered Wave turns inherited shuffle off and keeps all server positions', () async {
    transport.respond = (_) async => ApiResponse(200, orderedFeed(firstIds));
    await queue.dispatch(const SetShuffle(true));
    await wave.start(const WaveSelection(), collectionFence);
    expect(queue.snapshot.shuffle, isFalse);
    expect(
      queue.snapshot.effectiveOrder.map(
        (id) => queue.snapshot.entries
            .firstWhere((e) => e.entryId == id)
            .track
            .ref
            .identityKey,
      ),
      firstIds.map((id) => 'yt:$id'),
    );
    expect(wave.state.status, WaveStatus.active);
  });

  test(
    'ordered continuation appends intact and consumes opaque cursor',
    () async {
      var reads = 0;
      transport.respond = (_) async => ApiResponse(
        200,
        ++reads == 1
            ? orderedFeed(firstIds)
            : orderedFeed([
                'FFFFFFFFFF1',
                'GGGGGGGGGG1',
                'HHHHHHHHHH1',
              ], start: 6),
      );
      await wave.start(const WaveSelection(), collectionFence);
      engine.emit(position: const Duration(seconds: 37));
      final before = queue.snapshot;
      await wave.retry();
      expect(queue.snapshot.entries.map((e) => e.track.ref.identityKey), [
        ...firstIds.map((id) => 'yt:$id'),
        'yt:FFFFFFFFFF1',
        'yt:GGGGGGGGGG1',
        'yt:HHHHHHHHHH1',
      ]);
      expect(queue.snapshot.currentEntryId, before.currentEntryId);
      expect(queue.snapshot.position, before.position);
      expect(transport.requests.last.query['waveSequenceCursor'], 'cursor-0');
    },
  );

  for (final action in ['shuffle-cycle', 'remove', 'reorder', 'negative']) {
    test(
      'late ordered page is revoked by $action without selection permission',
      () async {
        final gate = Completer<ApiResponse>();
        var reads = 0;
        transport.respond = (_) async => ++reads == 1
            ? ApiResponse(200, orderedFeed(firstIds))
            : gate.future;
        await wave.start(const WaveSelection(), collectionFence);
        final pending = wave.retry();
        await settle();
        if (action == 'shuffle-cycle') {
          await queue.dispatch(const SetShuffle(true));
          await queue.dispatch(const SetShuffle(false));
        }
        if (action == 'remove') {
          await queue.dispatch(Remove(queue.snapshot.entries.last.entryId));
        }
        if (action == 'reorder') {
          await queue.dispatch(
            Reorder(
              queue.snapshot.entries.reversed.map((e) => e.entryId).toList(),
            ),
          );
        }
        if (action == 'negative') {
          final before = queue.snapshot;
          await queue.dispatch(
            SetRecommendationExclusion(
              before.currentEntry!.track.ref,
              fence: collectionFence,
              expectedLineage: before.lineage,
              recommendationScope:
                  before.currentEntry!.context.recommendationScopeKey!,
              advanceEntryId: before.currentEntryId,
              advanceGeneration: before.generation,
            ),
          );
        }
        await settle();
        if (action == 'negative') {
          expect(
            queue.snapshot.currentEntry!.track.ref,
            const YoutubeTrackRef('DDDDDDDDDD1'),
          );
        }
        final changed = queue.snapshot;
        final loads = engine.loaded.length;
        gate.complete(
          ApiResponse(
            200,
            orderedFeed([
              'FFFFFFFFFF1',
              'GGGGGGGGGG1',
              'HHHHHHHHHH1',
            ], start: 6),
          ),
        );
        await pending;
        await settle();
        expect(queue.snapshot.entries, changed.entries);
        expect(queue.snapshot.currentEntryId, changed.currentEntryId);
        expect(engine.loaded.length, loads);
        expect(prepared, isNot(contains('yt:FFFFFFFFFF1')));
        expect(reads, 2);
      },
    );
  }

  test('one409 reset starts a fresh append while current37s and history stay intact', () async {
    var reads = 0;
    transport.respond = (_) async {
      reads++;
      if (reads == 1) return ApiResponse(200, orderedFeed(firstIds));
      if (reads == 2) {
        return const ApiResponse(409, {
          'code': 'WAVE_SEQUENCE_RESET',
          'reason': 'expired',
        });
      }
      return ApiResponse(
        200,
        orderedFeed([
          'FFFFFFFFFF1',
          'GGGGGGGGGG1',
          'HHHHHHHHHH1',
        ], sequence: sequence2),
      );
    };
    await wave.start(const WaveSelection(), collectionFence);
    engine.emit(position: const Duration(seconds: 37));
    final before = queue.snapshot;
    final stops = engine.stops, loads = engine.loaded.length;
    await wave.retry();
    await settle();
    expect(reads, 3);
    expect(queue.snapshot.currentEntryId, before.currentEntryId);
    expect(queue.snapshot.position, before.position);
    expect(engine.stops, stops);
    expect(engine.loaded.length, loads);
    expect(queue.snapshot.entries.take(firstIds.length), before.entries);
    expect(queue.snapshot.entries.length, 9);
    expect(
      transport.requests.last.query,
      isNot(contains('waveSequenceCursor')),
    );
    expect(
      transport.requests.last.query['sessionId'],
      isNot(transport.requests.first.query['sessionId']),
    );
  });

  test('a second409 is terminal and position publications cannot schedule another reset', () async {
    var reads = 0;
    transport.respond = (_) async => ++reads == 1
        ? ApiResponse(200, orderedFeed(firstIds))
        : const ApiResponse(409, {'code': 'WAVE_SEQUENCE_RESET'});
    await wave.start(const WaveSelection(), collectionFence);
    await wave.retry();
    await settle();
    for (var i = 0; i < 20; i++) {
      engine.emit(position: Duration(seconds: 37 + i));
    }
    await settle();
    expect(reads, 3);
    expect(wave.state.status, WaveStatus.error);
    expect(queue.snapshot.entries.length, 6);
  });

  test('explicit capability rollback resets once and appends legacy without replacing current', () async {
    var reads = 0;
    transport.respond = (_) async {
      if (++reads == 1) return ApiResponse(200, orderedFeed(firstIds));
      if (reads == 2) {
        orderedEnabled = false;
        return const ApiResponse(409, {'code': 'WAVE_SEQUENCE_RESET'});
      }
      return ApiResponse(
        200,
        waveFeed(['FFFFFFFFFF1', 'GGGGGGGGGG1', 'HHHHHHHHHH1']),
      );
    };
    await wave.start(const WaveSelection(), collectionFence);
    engine.emit(position: const Duration(seconds: 37));
    final before = queue.snapshot;
    await wave.retry();
    await settle();
    expect(reads, 3);
    expect(queue.snapshot.entries.length, 9);
    expect(queue.snapshot.currentEntryId, before.currentEntryId);
    expect(queue.snapshot.position, before.position);
    expect(
      transport.requests.last.query,
      isNot(contains('waveSequenceVersion')),
    );
    expect(
      transport.requests.last.query,
      isNot(contains('waveSequenceCursor')),
    );
  });

  test('late ordered response belongs to the captured owner only', () async {
    final gate = Completer<ApiResponse>();
    var reads = 0;
    transport.respond = (_) async =>
        ++reads == 1 ? ApiResponse(200, orderedFeed(firstIds)) : gate.future;
    await wave.start(const WaveSelection(), collectionFence);
    final pending = wave.retry();
    await settle();
    authority.switchOwner();
    gate.complete(
      ApiResponse(
        200,
        orderedFeed(['FFFFFFFFFF1', 'GGGGGGGGGG1', 'HHHHHHHHHH1'], start: 6),
      ),
    );
    await pending;
    await settle();
    expect(queue.snapshot.entries, isEmpty);
    expect(wave.state.status, WaveStatus.detached);
    expect(prepared, ['yt:AAAAAAAAAA1']);
    expect(reads, 2);
  });

  test('late initial409 cannot create a fresh sequence after a manual shuffle cycle', () async {
    await queue.dispatch(
      ReplaceQueue(
        queue.createEntries([
          collectionTrack(1),
        ], const PlayContext(surface: PlaySurface.playlist)),
        fence: collectionFence,
      ),
    );
    final before = queue.snapshot;
    final gate = Completer<ApiResponse>();
    var reads = 0;
    transport.respond = (_) async =>
        ++reads == 1 ? gate.future : ApiResponse(200, orderedFeed(firstIds));
    final pending = wave.start(const WaveSelection(), collectionFence);
    await settle();
    await queue.dispatch(const SetShuffle(true));
    await queue.dispatch(const SetShuffle(false));
    gate.complete(const ApiResponse(409, {'code': 'WAVE_SEQUENCE_RESET'}));
    await pending;
    await settle();
    expect(reads, 1);
    expect(queue.snapshot.entries, before.entries);
    expect(queue.snapshot.currentEntryId, before.currentEntryId);
  });

  for (final status in [400, 503, 504]) {
    test('ordered $status failure preserves current and never loops', () async {
      var reads = 0;
      transport.respond = (_) async => ++reads == 1
          ? ApiResponse(200, orderedFeed(firstIds))
          : ApiResponse(status, null);
      await wave.start(const WaveSelection(), collectionFence);
      final before = queue.snapshot;
      await wave.retry();
      await settle();
      for (var i = 0; i < 20; i++) {
        engine.emit(position: Duration(seconds: 37 + i));
      }
      await settle();
      expect(reads, 2);
      expect(wave.state.status, WaveStatus.error);
      expect(queue.snapshot.entries, before.entries);
      expect(queue.snapshot.currentEntryId, before.currentEntryId);
    });
  }

  test('retired Tidal remains in decoded order and fails attachment without dropping into legacy', () async {
    final raw = orderedFeed(['AAAAAAAAAA1']);
    final payload = raw['orderedWave'] as Map;
    final tidal = waveDto('unused')
      ..addAll({
        'id': 'tidal:42',
        'source': 'tidal',
        'streamSource': 'tidal',
        'provider': {'tidalTrackId': 42, 'youtubeVideoId': null},
      });
    payload['items'] = [
      {'position': 0, 'track': tidal},
    ];
    payload['tail'] = [
      {'source': 'tidal', 'id': '42', 'position': 0},
    ];
    final page = OrderedWavePage.decode(payload);
    expect(page.references.single.source, 'tidal');
    expect(page.tracks.single.playable, isFalse);
    await queue.dispatch(
      ReplaceQueue(
        queue.createEntries([
          collectionTrack(1),
        ], const PlayContext(surface: PlaySurface.playlist)),
        fence: collectionFence,
      ),
    );
    engine.emit(position: const Duration(seconds: 37));
    final before = queue.snapshot;
    transport.respond = (_) async => ApiResponse(200, raw);
    await wave.start(const WaveSelection(), collectionFence);
    await settle();
    expect(wave.state.status, WaveStatus.error);
    expect(queue.snapshot.entries, before.entries);
    expect(queue.snapshot.position, before.position);
  });
}
