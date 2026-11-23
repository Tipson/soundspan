import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/features/likes/likes_models.dart';
import 'package:soundspan/features/likes/preference_controller.dart';
import 'package:soundspan/features/recommendations/recommendation_repository.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/queue_coordinator.dart';
import 'package:soundspan/playback/wave_continuation.dart';

import '../support/collection_fixtures.dart';
import '../support/wave_reporting_fixtures.dart';
import 'queue_coordinator_test.dart' show FakeEngine;

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

Future<void> settle() async {
  for (var i = 0; i < 12; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

void main() {
  test(
    'partial admission consumes valid Wave page after late negative',
    () async {
      final authority = _HeldAuthority();
      final queue = QueueCoordinator(
        authority: authority,
        engine: FakeEngine(),
        prepare: (_, _) async => PreparedAudio(
          uri: Uri.parse('http://127.0.0.1/synthetic'),
          revoke: () async {},
        ),
      );
      final nextResponse = Completer<ApiResponse>();
      final pageRequested = Completer<void>();
      var reads = 0;
      final transport = ControlledTransport()
        ..respond = (_) async {
          reads++;
          if (reads == 1) {
            return ApiResponse(200, waveFeed(['c', 'd', 'e', 'f'], cursor: 17));
          }
          if (reads == 2) {
            pageRequested.complete();
            return nextResponse.future;
          }
          throw StateError('Unexpected Wave retry');
        };
      final wave = WaveContinuation(
        controller: queue,
        repository: RecommendationRepository(transport: transport),
        authority: authority,
        sessionId: () => 'ordinary-wave',
      );
      final preferences = PreferenceController(
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
        await wave.start(const WaveSelection(), collectionFence);
        await queue.dispatch(const Next());
        await pageRequested.future;
        final current = queue.snapshot.currentEntryId;
        authority.holdNext = true;
        nextResponse.complete(
          ApiResponse(200, waveFeed(['a', 'b'], generation: 'generation-2')),
        );
        await authority.entered.future;
        await preferences.set(
          const YoutubeTrackRef('a'),
          PreferenceSignal.dislike,
        );
        authority.release.complete();
        await settle();
        expect(queue.snapshot.currentEntryId, current);
        expect(
          queue.snapshot.entries.map((entry) => entry.track.ref),
          contains(const YoutubeTrackRef('b')),
        );
        expect(
          queue.snapshot.entries.map((entry) => entry.track.ref),
          isNot(contains(const YoutubeTrackRef('a'))),
        );
        expect(
          wave.state.status,
          WaveStatus.exhausted,
          reason: 'a valid terminal page with an admitted row is consumed, not a queue-changed failure',
        );
        expect(wave.state.failure, isNull);
        expect(reads, 2);
      } finally {
        if (!nextResponse.isCompleted) {
          nextResponse.complete(ApiResponse(200, waveFeed([])));
        }
        if (!authority.release.isCompleted) authority.release.complete();
        await settle();
        preferences.dispose();
        await wave.dispose();
        await queue.dispose();
        await authority.updates.close();
      }
    },
  );

  for (final scenario in [
    (label: 'partial nonterminal', partial: true, terminal: false),
    (label: 'whole terminal', partial: false, terminal: true),
    (label: 'whole nonterminal', partial: false, terminal: false),
  ]) {
    test(
      '${scenario.label} late-filtered Wave page has bounded consumption',
      () async {
        final authority = _HeldAuthority();
        final queue = QueueCoordinator(
          authority: authority,
          engine: FakeEngine(),
          prepare: (_, _) async => PreparedAudio(
            uri: Uri.parse('http://127.0.0.1/synthetic'),
            revoke: () async {},
          ),
        );
        final nextResponse = Completer<ApiResponse>();
        final requested = Completer<void>();
        var reads = 0;
        final transport = ControlledTransport()
          ..respond = (_) async {
            reads++;
            if (reads == 1) {
              return ApiResponse(
                200,
                waveFeed(['c', 'd', 'e', 'f'], cursor: 17),
              );
            }
            if (reads == 2) {
              requested.complete();
              return nextResponse.future;
            }
            if (reads == 3 && !scenario.partial && !scenario.terminal) {
              return ApiResponse(
                200,
                waveFeed(['a'], cursor: 43, generation: 'generation-3'),
              );
            }
            throw StateError('Unexpected unbounded Wave request');
          };
        final wave = WaveContinuation(
          controller: queue,
          repository: RecommendationRepository(transport: transport),
          authority: authority,
          sessionId: () => 'matrix-wave',
        );
        final preferences = PreferenceController(
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
          await wave.start(const WaveSelection(), collectionFence);
          await queue.dispatch(const Next());
          await requested.future;
          final current = queue.snapshot.currentEntryId;
          authority.holdNext = true;
          nextResponse.complete(
            ApiResponse(
              200,
              waveFeed(
                scenario.partial ? ['a', 'b'] : ['a'],
                cursor: scenario.terminal ? null : 42,
                generation: 'generation-2',
              ),
            ),
          );
          await authority.entered.future;
          await preferences.set(
            const YoutubeTrackRef('a'),
            PreferenceSignal.dislike,
          );
          authority.release.complete();
          await settle();
          expect(queue.snapshot.currentEntryId, current);
          final refs = queue.snapshot.entries.map((entry) => entry.track.ref);
          expect(refs, isNot(contains(const YoutubeTrackRef('a'))));
          expect(
            refs,
            scenario.partial
                ? contains(const YoutubeTrackRef('b'))
                : isNot(contains(const YoutubeTrackRef('b'))),
          );
          expect(
            wave.state.status,
            scenario.partial ? WaveStatus.active : WaveStatus.exhausted,
          );
          expect(wave.state.failure, isNull);
          expect(reads, !scenario.partial && !scenario.terminal ? 3 : 2);
          if (scenario.partial) expect(wave.state.cursor, 42);
          await settle();
          expect(
            reads,
            !scenario.partial && !scenario.terminal ? 3 : 2,
            reason: 'empty pages are bounded, no retry burst',
          );
        } finally {
          if (!nextResponse.isCompleted) {
            nextResponse.complete(ApiResponse(200, waveFeed([])));
          }
          if (!authority.release.isCompleted) authority.release.complete();
          await settle();
          preferences.dispose();
          await wave.dispose();
          await queue.dispose();
          await authority.updates.close();
        }
      },
    );
  }

  test('retune can supersede the admitted replacement while its original first row is filtered', () async {
    final authority = _HeldAuthority();
    final preparingB = Completer<void>();
    final releasePreparation = Completer<void>();
    final queue = QueueCoordinator(
      authority: authority,
      engine: FakeEngine(),
      prepare: (entry, _) async {
        if (entry.track.ref == const YoutubeTrackRef('b')) {
          preparingB.complete();
          await releasePreparation.future;
        }
        return PreparedAudio(
          uri: Uri.parse('http://127.0.0.1/synthetic'),
          revoke: () async {},
        );
      },
    );
    final nextResponse = Completer<ApiResponse>();
    final requested = Completer<void>();
    var reads = 0;
    final transport = ControlledTransport()
      ..respond = (_) async {
        reads++;
        if (reads == 1) {
          return ApiResponse(200, waveFeed(['c', 'd', 'e', 'f'], cursor: 17));
        }
        if (reads == 2) {
          requested.complete();
          return nextResponse.future;
        }
        if (reads == 3) {
          return ApiResponse(
            200,
            waveFeed(['g', 'h', 'i', 'j'], generation: 'generation-3'),
          );
        }
        throw StateError('Unexpected Wave request');
      };
    final wave = WaveContinuation(
      controller: queue,
      repository: RecommendationRepository(transport: transport),
      authority: authority,
      sessionId: () => 'retune-wave',
    );
    final preferences = PreferenceController(
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
    Future<void>? firstRetune;
    try {
      await wave.start(const WaveSelection(), collectionFence);
      firstRetune = wave.retune(const WaveSelection(mode: WaveMode.newMusic));
      await requested.future;
      authority.holdNext = true;
      nextResponse.complete(
        ApiResponse(200, waveFeed(['a', 'b'], generation: 'generation-2')),
      );
      await authority.entered.future;
      await preferences.set(
        const YoutubeTrackRef('a'),
        PreferenceSignal.dislike,
      );
      authority.release.complete();
      await preparingB.future;
      expect(
        queue.snapshot.currentEntry?.track.ref,
        const YoutubeTrackRef('b'),
      );
      await wave.retune(const WaveSelection(mode: WaveMode.forYou));
      expect(reads, 3);
      expect(
        queue.snapshot.currentEntry?.track.ref,
        const YoutubeTrackRef('g'),
      );
      expect(wave.state.status, WaveStatus.exhausted);
      expect(wave.state.selection.mode, WaveMode.forYou);
      releasePreparation.complete();
      await firstRetune;
      await settle();
      expect(
        queue.snapshot.currentEntry?.track.ref,
        const YoutubeTrackRef('g'),
        reason: 'late old prepare cannot overwrite the newer admitted retune',
      );
      expect(wave.state.failure, isNull);
    } finally {
      if (!nextResponse.isCompleted) {
        nextResponse.complete(ApiResponse(200, waveFeed([])));
      }
      if (!authority.release.isCompleted) authority.release.complete();
      if (!releasePreparation.isCompleted) releasePreparation.complete();
      if (firstRetune != null) await firstRetune;
      await settle();
      preferences.dispose();
      await wave.dispose();
      await queue.dispose();
      await authority.updates.close();
    }
  });
}
