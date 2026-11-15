import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/features/likes/likes_models.dart';
import 'package:soundspan/features/likes/preference_controller.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/queue_coordinator.dart';

import '../support/collection_fixtures.dart';

class _HeldAuthority extends CollectionAuthority {
  bool holdNext = false;
  final entered = Completer<void>();
  final release = Completer<void>();
  @override
  Future<void> assertCurrent(SessionFence fence) async {
    if (holdNext) {
      holdNext = false;
      entered.complete();
      await release.future;
    }
    await super.assertCurrent(fence);
  }
}

class _Engine implements PlaybackEngine {
  int loads = 0;
  @override
  Stream<EngineEvent> get events => const Stream.empty();
  @override
  Future<void> load(Uri uri, int generation) async {
    loads++;
  }

  @override
  Future<void> play() async {}
  @override
  Future<void> pause() async {}
  @override
  Future<void> stop() async {}
  @override
  Future<void> seek(Duration position) async {}
  @override
  Future<void> setVolume(double volume) async {}
  @override
  Future<void> dispose() async {}
}

const _context = PlayContext(
  surface: PlaySurface.wave,
  recommendationSessionId: 'ordinary-scope',
  recommendationGenerationId: 'ordinary-generation',
);

Future<void> settle() async {
  for (var i = 0; i < 8; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

void main() {
  test(
    'reentrant clear during preference notification prevents stale skip',
    () async {
      final authority = _HeldAuthority();
      final engine = _Engine();
      final queue = QueueCoordinator(
        authority: authority,
        engine: engine,
        prepare: (_, _) async => PreparedAudio(
          uri: Uri.parse('http://127.0.0.1/synthetic'),
          revoke: () async {},
        ),
      );
      final preference = PreferenceController(
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
      try {
        final entries = queue.createEntries([
          collectionTrack(1),
          collectionTrack(1),
          collectionTrack(2),
          collectionTrack(3),
        ], _context);
        await queue.dispatch(ReplaceQueue(entries, fence: collectionFence));
        final ref = entries.first.track.ref;
        var cleared = false;
        Future<void>? clearing;
        preference.addListener(() {
          if (!cleared &&
              preference.current(ref).signal == PreferenceSignal.dislike) {
            cleared = true;
            clearing = preference.set(ref, PreferenceSignal.clear);
          }
        });
        await preference.set(ref, PreferenceSignal.dislike);
        await clearing;
        await settle();
        expect(cleared, isTrue);
        expect(preference.current(ref).signal, PreferenceSignal.clear);
        expect(
          queue.snapshot.currentEntryId,
          entries.first.entryId,
          reason: 'a newer reentrant clear supersedes the original dislike before queue dispatch',
        );
        expect(queue.snapshot.allowsRecommendation(ref, _context), isTrue);
        expect(engine.loads, 1);
      } finally {
        preference.dispose();
        await queue.dispose();
        await authority.updates.close();
      }
    },
  );

  test(
    'current negative held before clear cannot skip after both ACKs',
    () async {
      final authority = _HeldAuthority();
      final engine = _Engine();
      final queue = QueueCoordinator(
        authority: authority,
        engine: engine,
        prepare: (_, _) async => PreparedAudio(
          uri: Uri.parse('http://127.0.0.1/synthetic'),
          revoke: () async {},
        ),
      );
      final negativeAck = Completer<ApiResponse>();
      var writes = 0;
      final preference = PreferenceController(
        authority: authority,
        fence: collectionFence,
        playback: queue,
        transport: CollectionTransport(
          (request, _) => ++writes == 1
              ? negativeAck.future
              : preferenceResponse(
                  Uri.decodeComponent(request.path.split('/')[4]),
                  request.body!['signal'] as String,
                ),
        ),
      );
      try {
        final entries = queue.createEntries([
          collectionTrack(1),
          collectionTrack(1),
          collectionTrack(2),
          collectionTrack(3),
        ], _context);
        await queue.dispatch(ReplaceQueue(entries, fence: collectionFence));
        final ref = entries.first.track.ref;
        authority.holdNext = true;
        final negative = preference.set(ref, PreferenceSignal.dislike);
        await authority.entered.future;
        await settle();
        final clearing = preference.set(ref, PreferenceSignal.clear);
        await settle();
        negativeAck.complete(preferenceResponse('local-1', 'thumbs_down'));
        await negative;
        await clearing;
        expect(preference.current(ref).signal, PreferenceSignal.clear);
        expect(
          queue.snapshot.currentEntryId,
          entries.first.entryId,
          reason: 'clear superseded negative before ACK',
        );
        authority.release.complete();
        await settle();
        expect(
          queue.snapshot.currentEntryId,
          entries.first.entryId,
          reason: 'old held negative must not skip after clear',
        );
        expect(queue.snapshot.allowsRecommendation(ref, _context), isTrue);
        expect(engine.loads, 1);
      } finally {
        if (!negativeAck.isCompleted) {
          negativeAck.complete(preferenceResponse('local-1', 'thumbs_down'));
        }
        if (!authority.release.isCompleted) authority.release.complete();
        await settle();
        preference.dispose();
        await queue.dispose();
        await authority.updates.close();
      }
    },
  );

  test('current confirmed negative advances once despite held optimistic admission', () async {
    final authority = _HeldAuthority();
    final engine = _Engine();
    final queue = QueueCoordinator(
      authority: authority,
      engine: engine,
      prepare: (_, _) async => PreparedAudio(
        uri: Uri.parse('http://127.0.0.1/synthetic'),
        revoke: () async {},
      ),
    );
    final preference = PreferenceController(
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
    try {
      final entries = queue.createEntries([
        collectionTrack(1),
        collectionTrack(1),
        collectionTrack(2),
        collectionTrack(3),
      ], _context);
      await queue.dispatch(ReplaceQueue(entries, fence: collectionFence));
      final ref = entries.first.track.ref;
      authority.holdNext = true;
      final negative = preference.set(ref, PreferenceSignal.dislike);
      await authority.entered.future;
      await negative;
      await settle();
      expect(
        queue.snapshot.currentEntryId,
        entries[2].entryId,
        reason: 'ACK reconciliation must advance current despite delayed earlier admission',
      );
      expect(engine.loads, 2);
      authority.release.complete();
      await settle();
      expect(
        queue.snapshot.currentEntryId,
        entries[2].entryId,
        reason: 'held older admission must not advance again',
      );
      expect(engine.loads, 2);
    } finally {
      if (!authority.release.isCompleted) authority.release.complete();
      await settle();
      preference.dispose();
      await queue.dispose();
      await authority.updates.close();
    }
  });

  test('delayed optimistic clear cannot reopen an acknowledged negative', () async {
    final authority = _HeldAuthority();
    final engine = _Engine();
    final queue = QueueCoordinator(
      authority: authority,
      engine: engine,
      prepare: (_, _) async => PreparedAudio(
        uri: Uri.parse('http://127.0.0.1/synthetic'),
        revoke: () async {},
      ),
    );
    final preference = PreferenceController(
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
    try {
      final entries = queue.createEntries([
        collectionTrack(2),
        collectionTrack(1),
        collectionTrack(3),
      ], _context);
      await queue.dispatch(ReplaceQueue(entries, fence: collectionFence));
      final ref = entries[1].track.ref;
      await preference.set(ref, PreferenceSignal.dislike);
      await settle();
      authority.holdNext = true;
      final clearing = preference.set(ref, PreferenceSignal.clear);
      await authority.entered.future;
      await clearing;
      await preference.set(ref, PreferenceSignal.dislike);
      expect(preference.current(ref).signal, PreferenceSignal.dislike);
      expect(
        queue.snapshot.allowsRecommendation(ref, _context),
        isFalse,
        reason: 'newer negative acknowledged',
      );
      authority.release.complete();
      await settle();
      expect(
        queue.snapshot.allowsRecommendation(ref, _context),
        isFalse,
        reason:
            'older held clear must not allow a recording after a newer dislike',
      );
    } finally {
      if (!authority.release.isCompleted) authority.release.complete();
      await settle();
      preference.dispose();
      await queue.dispose();
      await authority.updates.close();
    }
  });

  test(
    'delayed optimistic exclusion cannot override acknowledged clear',
    () async {
      final authority = _HeldAuthority();
      final engine = _Engine();
      final queue = QueueCoordinator(
        authority: authority,
        engine: engine,
        prepare: (_, _) async => PreparedAudio(
          uri: Uri.parse('http://127.0.0.1/synthetic'),
          revoke: () async {},
        ),
      );
      final preference = PreferenceController(
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
      try {
        final entries = queue.createEntries([
          collectionTrack(2),
          collectionTrack(1),
          collectionTrack(3),
        ], _context);
        await queue.dispatch(ReplaceQueue(entries, fence: collectionFence));
        final ref = entries[1].track.ref;
        final currentId = queue.snapshot.currentEntryId;
        authority.holdNext = true;
        final negative = preference.set(ref, PreferenceSignal.dislike);
        await authority.entered.future;
        await negative;
        await preference.set(ref, PreferenceSignal.clear);
        expect(preference.current(ref).signal, PreferenceSignal.clear);
        expect(
          queue.snapshot.allowsRecommendation(ref, _context),
          isTrue,
          reason: 'newer clear acknowledged',
        );
        authority.release.complete();
        await settle();
        expect(queue.snapshot.currentEntryId, currentId);
        expect(
          queue.snapshot.allowsRecommendation(ref, _context),
          isTrue,
          reason: 'older held optimistic command must not reinstate dislike after Undo',
        );
        final fresh = queue.createEntries([collectionTrack(1)], _context);
        await queue.dispatch(
          Enqueue(
            fresh,
            fence: collectionFence,
            expectedLineage: queue.snapshot.lineage,
          ),
        );
        expect(
          queue.snapshot.entries.map((entry) => entry.entryId),
          contains(fresh.single.entryId),
        );
      } finally {
        if (!authority.release.isCompleted) authority.release.complete();
        await settle();
        preference.dispose();
        await queue.dispose();
        await authority.updates.close();
      }
    },
  );
}
