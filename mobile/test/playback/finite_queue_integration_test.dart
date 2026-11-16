import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/features/likes/likes_models.dart';
import 'package:soundspan/features/likes/preference_controller.dart';
import 'package:soundspan/playback/finite_queue_admission_api.dart';
import 'package:soundspan/playback/finite_queue_admission_coordinator.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/queue_coordinator.dart';
import 'package:soundspan/playback/next_track_warmup.dart';

import '../support/collection_fixtures.dart';
import 'queue_coordinator_test.dart' show FakeEngine;

const recommended = PlayContext(
  surface: PlaySurface.wave,
  recommendationGenerationId: 'generation',
  recommendationSessionId: 'session',
);

void main() {
  late CollectionAuthority authority;
  late FakeEngine engine;
  late QueueCoordinator queue;
  late CollectionTransport transport;
  late FiniteQueueAdmissionCoordinator admission;
  late PreferenceController preferences;
  late List<String> prepared;
  late List<QueueEntry> entries;
  late Future<ApiResponse> Function(ApiRequest) respond;
  Future<ApiResponse> Function(ApiRequest)? preferenceRespond;
  ApiResponse decisions(ApiRequest request, List<String> states) {
    final refs = request.body!['references'] as List;
    return ApiResponse(200, {
      'version': 1,
      'appliesTo': 'recommended_future',
      'decisions': [
        for (final (i, ref) in refs.indexed)
          {...ref as Map, 'state': states[i]},
      ],
    });
  }

  Future<void> settle() =>
      Future<void>.delayed(const Duration(milliseconds: 20));
  setUp(() async {
    authority = CollectionAuthority();
    engine = FakeEngine();
    prepared = [];
    queue = QueueCoordinator(
      authority: authority,
      engine: engine,
      prepare: (entry, _) async {
        prepared.add(entry.entryId);
        return PreparedAudio(
          uri: Uri.parse('http://127.0.0.1/synthetic'),
          revoke: () async {},
        );
      },
    );
    respond = (request) async => decisions(
      request,
      List.filled((request.body!['references'] as List).length, 'allowed'),
    );
    transport = CollectionTransport((request, _) {
      if (request.path == '/api/personalized/queue-admission') {
        return respond(request);
      }
      if (preferenceRespond != null) return preferenceRespond!(request);
      return preferenceResponse(
        Uri.decodeComponent(request.path.split('/')[4]),
        request.body!['signal'] as String,
      );
    });
    preferenceRespond = null;
    admission = FiniteQueueAdmissionCoordinator(
      api: FiniteQueueAdmissionApi(transport: transport),
      authority: authority,
      snapshot: () => queue.snapshot,
      snapshots: queue.snapshots,
    );
    queue.finiteAdmission = admission;
    preferences = PreferenceController(
      transport: transport,
      authority: authority,
      fence: collectionFence,
      playback: queue,
      finiteAdmission: admission,
    );
    entries = queue.createEntries([
      collectionTrack(1),
      collectionTrack(2),
      collectionTrack(3),
    ], recommended);
    await queue.dispatch(ReplaceQueue(entries, fence: collectionFence));
    engine.emit(position: const Duration(seconds: 37));
  });
  tearDown(() async {
    preferences.dispose();
    await admission.close();
    await queue.dispose();
    await authority.updates.close();
  });

  test(
    'server denied next is skipped before preparation; history remains',
    () async {
      respond = (request) async => decisions(request, ['denied', 'allowed']);
      await queue.dispatch(const Next());
      expect(queue.snapshot.currentEntryId, entries[2].entryId);
      expect(prepared, [entries[0].entryId, entries[2].entryId]);
      expect(queue.snapshot.entries, entries);
    },
  );

  test(
    'pending policy preserves current37s and source until allowed',
    () async {
      final response = Completer<ApiResponse>();
      ApiRequest? request;
      respond = (input) {
        request = input;
        return response.future;
      };
      final old = queue.snapshot;
      final stops = engine.stops;
      final next = queue.dispatch(const Next());
      await settle();
      expect(queue.snapshot.currentEntryId, old.currentEntryId);
      expect(queue.snapshot.position, old.position);
      expect(queue.snapshot.generation, old.generation);
      expect(engine.stops, stops);
      response.complete(decisions(request!, ['allowed', 'allowed']));
      await next;
      expect(queue.snapshot.currentEntryId, entries[1].entryId);
    },
  );

  test(
    'unavailable does not stop current and manual selection remains usable',
    () async {
      respond = (_) async => const ApiResponse(503, null);
      final old = queue.snapshot;
      final stops = engine.stops;
      await queue.dispatch(const Next());
      expect(queue.snapshot.currentEntryId, old.currentEntryId);
      expect(queue.snapshot.position, old.position);
      expect(engine.stops, stops);
      expect(queue.snapshot.failure?.retryable, isTrue);
      await queue.dispatch(PlayEntry(entries[1].entryId));
      expect(queue.snapshot.currentEntryId, entries[1].entryId);
    },
  );

  test('404 retains the exact legacy guard', () async {
    respond = (_) async => const ApiResponse(404, null);
    await queue.dispatch(
      SetRecommendationExclusion(
        entries[1].track.ref,
        fence: collectionFence,
        expectedLineage: queue.snapshot.lineage,
        recommendationScope: recommended.recommendationScopeKey!,
      ),
    );
    await queue.dispatch(const Next());
    expect(queue.snapshot.currentEntryId, entries[2].entryId);
  });

  test('completion and notification Next share an operation fence', () async {
    final response = Completer<ApiResponse>();
    ApiRequest? request;
    respond = (input) {
      request = input;
      return response.future;
    };
    engine.emit(processing: PlaybackProcessing.completed);
    final next = queue.dispatch(const Next());
    await settle();
    response.complete(decisions(request!, ['allowed', 'allowed']));
    await next;
    await settle();
    expect(prepared, [entries[0].entryId, entries[1].entryId]);
    expect(queue.snapshot.currentEntryId, entries[1].entryId);
  });

  test(
    'manual replacement supersedes late admission without another prepare',
    () async {
      final response = Completer<ApiResponse>();
      ApiRequest? request;
      respond = (input) {
        request = input;
        return response.future;
      };
      final next = queue.dispatch(const Next());
      await settle();
      final manual = queue.createEntries([
        collectionTrack(4),
      ], const PlayContext(surface: PlaySurface.playlist));
      await queue.dispatch(ReplaceQueue(manual, fence: collectionFence));
      response.complete(decisions(request!, ['allowed', 'allowed']));
      await next;
      expect(queue.snapshot.currentEntryId, manual.single.entryId);
      expect(prepared, [entries[0].entryId, manual.single.entryId]);
    },
  );

  test(
    'like and clear reserve independent epochs before synchronous UI listeners',
    () async {
      final seen = <int>[];
      preferences.addListener(() => seen.add(admission.mutationEpoch));
      final epoch = admission.mutationEpoch;
      await preferences.set(entries[0].track.ref, PreferenceSignal.like);
      await preferences.set(entries[0].track.ref, PreferenceSignal.clear);
      expect(admission.mutationEpoch, epoch + 2);
      expect(seen.first, epoch + 1);
      expect(admission.pendingMutations, 0);
    },
  );

  test(
    'warmup never resolves a denied recommendation and skips to admitted next',
    () async {
      respond = (request) async => decisions(request, ['denied', 'allowed']);
      final warmed = <String>[];
      final warmup = NextTrackWarmup(
        controller: queue,
        authority: authority,
        networkAllowed: () => true,
        finiteAdmission: admission,
        warm: (entry, _, _) async {
          warmed.add(entry.entryId);
        },
      );
      addTearDown(warmup.close);
      engine.emit(position: const Duration(seconds: 3));
      await settle();
      expect(warmed, [entries[2].entryId]);
      expect(queue.snapshot.currentEntryId, entries[0].entryId);
      expect(prepared, [entries[0].entryId]);
    },
  );

  test(
    'every mutation immediately retires queued speculative work only',
    () async {
      final started = Completer<void>();
      final stopped = Completer<void>();
      final warmup = NextTrackWarmup(
        controller: queue,
        authority: authority,
        networkAllowed: () => true,
        finiteAdmission: admission,
        warm: (entry, _, cancellation) {
          if (!started.isCompleted) started.complete();
          cancellation.listen(() {
            if (!stopped.isCompleted) stopped.complete();
          });
          return stopped.future;
        },
      );
      addTearDown(warmup.close);
      engine.emit(position: const Duration(seconds: 3));
      await started.future;
      final before = queue.snapshot;
      final loads = engine.loaded.length;
      final mutation = admission.beginMutation();
      await stopped.future.timeout(const Duration(milliseconds: 100));
      expect(queue.snapshot.currentEntryId, before.currentEntryId);
      expect(engine.loaded.length, loads);
      admission.finishMutation(mutation);
    },
  );
  test(
    'manual rows and explicitly selected recommendation bypass server denial',
    () async {
      respond = (request) async => decisions(
        request,
        List.filled((request.body!['references'] as List).length, 'denied'),
      );
      await queue.dispatch(PlayEntry(entries[1].entryId));
      expect(queue.snapshot.currentEntryId, entries[1].entryId);
      expect(
        transport.requests.where((r) => r.path.endsWith('queue-admission')),
        isEmpty,
      );
      final manual = QueueEntry(
        entryId: 'manual',
        track: collectionTrack(4),
        context: const PlayContext(surface: PlaySurface.playlist),
      );
      await queue.dispatch(Enqueue([manual], fence: collectionFence));
      await queue.dispatch(const Next());
      expect(queue.snapshot.currentEntryId, manual.entryId);
      expect(queue.snapshot.entries, containsAll(entries));
    },
  );

  test(
    'two fast negatives wait for both settlements and advance once',
    () async {
      final first = Completer<ApiResponse>(), second = Completer<ApiResponse>();
      preferenceRespond = (request) =>
          request.path.contains('local-1') ? first.future : second.future;
      final dislikeCurrent = preferences.set(
        entries[0].track.ref,
        PreferenceSignal.dislike,
      );
      final dislikeNext = preferences.set(
        entries[1].track.ref,
        PreferenceSignal.dislike,
      );
      await settle();
      expect(queue.snapshot.currentEntryId, entries[0].entryId);
      expect(
        transport.requests.where((r) => r.path.endsWith('queue-admission')),
        isEmpty,
      );
      first.complete(preferenceResponse('local-1', 'thumbs_down'));
      await dislikeCurrent;
      expect(queue.snapshot.currentEntryId, entries[0].entryId);
      second.complete(preferenceResponse('local-2', 'thumbs_down'));
      await dislikeNext;
      await settle();
      expect(queue.snapshot.currentEntryId, entries[2].entryId);
      expect(prepared, [entries[0].entryId, entries[2].entryId]);
      expect(admission.pendingMutations, 0);
    },
  );

  test(
    'Undo while negative write is pending prevents its late automatic skip',
    () async {
      final first = Completer<ApiResponse>();
      preferenceRespond = (request) => request.body!['signal'] == 'thumbs_down'
          ? first.future
          : Future.value(preferenceResponse('local-1', 'clear'));
      final negative = preferences.set(
        entries[0].track.ref,
        PreferenceSignal.dislike,
      );
      final undo = preferences.set(
        entries[0].track.ref,
        PreferenceSignal.clear,
      );
      first.complete(preferenceResponse('local-1', 'thumbs_down'));
      await Future.wait([negative, undo]);
      await settle();
      expect(queue.snapshot.currentEntryId, entries[0].entryId);
      expect(prepared, [entries[0].entryId]);
      expect(admission.pendingMutations, 0);
    },
  );

  test('like after a completed source preparation cannot load its stale automatic grant', () async {
    final preparedGate = Completer<PreparedAudio>();
    final preparing = Completer<void>();
    final revoked = <String>[];
    await admission.close();
    await queue.dispose();
    engine = FakeEngine();
    queue = QueueCoordinator(
      authority: authority,
      engine: engine,
      prepare: (entry, _) {
        if (entry.entryId == entries[1].entryId) {
          preparing.complete();
          return preparedGate.future;
        }
        return Future.value(
          PreparedAudio(
            uri: Uri.parse('http://127.0.0.1/current'),
            revoke: () async {},
          ),
        );
      },
    );
    admission = FiniteQueueAdmissionCoordinator(
      api: FiniteQueueAdmissionApi(transport: transport),
      authority: authority,
      snapshot: () => queue.snapshot,
    );
    queue.finiteAdmission = admission;
    await queue.dispatch(ReplaceQueue(entries, fence: collectionFence));
    final next = queue.dispatch(const Next());
    await preparing.future;
    final mutation = admission.beginMutation();
    preparedGate.complete(
      PreparedAudio(
        uri: Uri.parse('http://127.0.0.1/late'),
        revoke: () async {
          revoked.add('late');
        },
      ),
    );
    await next;
    expect(engine.loaded.length, 1);
    expect(revoked, ['late']);
    admission.finishMutation(mutation);
  });
  test(
    'automatic replacement validates before changing current queue',
    () async {
      final old = queue.snapshot;
      final response = Completer<ApiResponse>();
      ApiRequest? request;
      respond = (input) {
        request = input;
        return response.future;
      };
      final replacement = queue.createEntries([
        collectionTrack(5),
        collectionTrack(6),
      ], recommended);
      final replacing = queue.dispatch(
        ReplaceQueue(
          replacement,
          fence: collectionFence,
          expectedLineage: old.lineage,
          automaticRecommendation: true,
        ),
      );
      await settle();
      try {
        expect(queue.snapshot.currentEntryId, old.currentEntryId);
        expect(queue.snapshot.entries, old.entries);
      } finally {
        if (request != null) {
          response.complete(decisions(request!, ['denied', 'allowed']));
        }
        await replacing;
      }
      expect(queue.snapshot.currentEntryId, replacement[1].entryId);
    },
  );

  test(
    'late Wave continuation validates refilled next before any prepare',
    () async {
      await queue.dispatch(PlayEntry(entries.last.entryId));
      engine.emit(processing: PlaybackProcessing.completed);
      await settle();
      final old = queue.snapshot;
      expect(old.processing, PlaybackProcessing.completed);
      final refill = queue.createEntries([
        collectionTrack(5),
        collectionTrack(6),
      ], recommended);
      respond = (request) async => decisions(request, ['denied', 'allowed']);
      await queue.dispatch(
        Enqueue(
          refill,
          fence: collectionFence,
          expectedLineage: old.lineage,
          automaticRecommendation: true,
        ),
      );
      expect(queue.snapshot.currentEntryId, refill[1].entryId);
      expect(prepared, isNot(contains(refill.first.entryId)));
    },
  );

  test('automatic initial queue has owner admission even before a queue fence exists', () async {
    await queue.dispatch(const Clear());
    final refill = queue.createEntries([
      collectionTrack(5),
      collectionTrack(6),
    ], recommended);
    respond = (request) async => decisions(request, ['denied', 'allowed']);
    await queue.dispatch(
      ReplaceQueue(
        refill,
        fence: collectionFence,
        expectedLineage: queue.snapshot.lineage,
        automaticRecommendation: true,
      ),
    );
    expect(queue.snapshot.currentEntryId, refill[1].entryId);
    expect(prepared, isNot(contains(refill.first.entryId)));
  });

  test('manual replacement intent revokes a pending automatic source before owner admission', () async {
    await admission.close();
    await queue.dispose();
    final gatedAuthority = _GatedAuthority();
    authority = gatedAuthority;
    final preparedGate = Completer<PreparedAudio>();
    final preparing = Completer<void>();
    final revoked = <String>[];
    engine = FakeEngine();
    queue = QueueCoordinator(
      authority: authority,
      engine: engine,
      prepare: (entry, _) {
        if (entry.entryId == entries[1].entryId) {
          preparing.complete();
          return preparedGate.future;
        }
        return Future.value(
          PreparedAudio(
            uri: Uri.parse('http://127.0.0.1/current'),
            revoke: () async {},
          ),
        );
      },
    );
    admission = FiniteQueueAdmissionCoordinator(
      api: FiniteQueueAdmissionApi(transport: transport),
      authority: authority,
      snapshot: () => queue.snapshot,
    );
    queue.finiteAdmission = admission;
    await queue.dispatch(ReplaceQueue(entries, fence: collectionFence));
    final next = queue.dispatch(const Next());
    await preparing.future;
    gatedAuthority.gate = Completer<void>();
    final manual = queue.createEntries([
      collectionTrack(7),
    ], const PlayContext(surface: PlaySurface.playlist));
    final replacing = queue.dispatch(
      ReplaceQueue(manual, fence: collectionFence),
    );
    preparedGate.complete(
      PreparedAudio(
        uri: Uri.parse('http://127.0.0.1/late'),
        revoke: () async {
          revoked.add('late');
        },
      ),
    );
    try {
      await settle();
      expect(engine.loaded.length, 1);
      expect(revoked, ['late']);
    } finally {
      gatedAuthority.gate!.complete();
      await replacing;
      await next;
    }
    expect(queue.snapshot.currentEntryId, manual.single.entryId);
  });
  test(
    'all denied automatic next preserves current playback and queue',
    () async {
      respond = (request) async => decisions(request, ['denied', 'denied']);
      final old = queue.snapshot;
      final stops = engine.stops;
      await queue.dispatch(const Next());
      expect(queue.snapshot.currentEntryId, old.currentEntryId);
      expect(queue.snapshot.position, old.position);
      expect(queue.snapshot.generation, old.generation);
      expect(engine.stops, stops);
      expect(queue.snapshot.entries, entries);
    },
  );

  test('native exact decisions suppress one recording without inferring an artist relation', () async {
    Track native(String id) => Track(
      ref: NativeTrackRef(
        MusicRecording(
          provider: NativeMusicProvider.yandex,
          id: id,
          title: 'Same title',
          artists: ['Same artist'],
          durationSeconds: 180,
          contentVersion: MusicContentVersion.clean,
        ),
      ),
      title: 'Same title',
      artist: 'Same artist',
    );
    final nativeEntries = queue.createEntries([
      collectionTrack(1),
      native('42'),
      native('43'),
    ], recommended);
    await queue.dispatch(ReplaceQueue(nativeEntries, fence: collectionFence));
    respond = (request) async {
      expect(request.body!['references'], [
        {'source': 'yandex', 'id': '42', 'generationId': 'generation'},
        {'source': 'yandex', 'id': '43', 'generationId': 'generation'},
      ]);
      return decisions(request, ['denied', 'allowed']);
    };
    await queue.dispatch(const Next());
    expect(queue.snapshot.currentEntryId, nativeEntries[2].entryId);
    expect(prepared, isNot(contains(nativeEntries[1].entryId)));
  });

  test(
    'automatic repeat all and one require a fresh policy before preparation',
    () async {
      await queue.dispatch(PlayEntry(entries.last.entryId));
      await queue.dispatch(const SetRepeat(QueueRepeat.all));
      respond = (request) async =>
          decisions(request, ['denied', 'allowed', 'denied']);
      engine.emit(processing: PlaybackProcessing.completed);
      await settle();
      expect(queue.snapshot.currentEntryId, entries[1].entryId);
      await queue.dispatch(const SetRepeat(QueueRepeat.one));
      respond = (request) async => decisions(request, ['denied']);
      final loads = engine.loaded.length;
      engine.emit(processing: PlaybackProcessing.completed);
      await settle();
      expect(engine.loaded.length, loads);
    },
  );

  test('controller disposal settles an acknowledged intent still reconciling its tail', () async {
    final controller = PreferenceController(
      transport: transport,
      authority: authority,
      fence: collectionFence,
      playback: queue,
      finiteAdmission: admission,
    );
    var disposing = false;
    controller.addListener(() {
      if (!disposing && !controller.current(entries.first.track.ref).pending) {
        disposing = true;
        scheduleMicrotask(controller.dispose);
      }
    });
    await expectLater(
      controller.set(entries.first.track.ref, PreferenceSignal.like),
      throwsA(isA<AppFailure>()),
    );
    await settle();
    expect(admission.pendingMutations, 0);
  });
}

class _GatedAuthority extends CollectionAuthority {
  Completer<void>? gate;
  @override
  Future<void> assertCurrent(SessionFence fence) async {
    await gate?.future;
    return super.assertCurrent(fence);
  }
}
