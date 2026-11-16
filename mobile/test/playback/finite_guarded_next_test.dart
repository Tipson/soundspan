import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/features/likes/likes_models.dart';
import 'package:soundspan/features/likes/preference_controller.dart';
import 'package:soundspan/playback/finite_queue_admission_api.dart';
import 'package:soundspan/playback/finite_queue_admission_coordinator.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/queue_coordinator.dart';

import '../support/collection_fixtures.dart';
import 'queue_coordinator_test.dart' show FakeEngine;

const _manual = PlayContext(surface: PlaySurface.playlist);
const _recommended = PlayContext(
  surface: PlaySurface.wave,
  recommendationGenerationId: 'served-generation',
  recommendationSessionId: 'session',
);

void main() {
  testWidgets(
    'actual manual dislike guarded Next includes its first owner wait in17s',
    (tester) async {
      final f = _Fixture();
      await f.start();
      try {
        f.authority.gate = Completer<void>();
        unawaited(
          f.preferences
              .set(f.rows.first.track.ref, PreferenceSignal.dislike)
              .catchError((Object _) {}),
        );
        await tester.pump();
        var done = false;
        expect(f.playback.guardedNext, isNotNull);
        unawaited(f.playback.guardedNext!.then((_) => done = true));
        await tester.pump(const Duration(seconds: 18));
        final doneAt18 = done;
        expect(f.queue.snapshot.currentEntryId, 'a');
        expect(f.queue.snapshot.position.inSeconds, 37);
        expect(f.reads, isEmpty);
        await f.queue.dispatch(const Pause());
        f.authority.gate!.complete();
        await tester.pump();
        expect(
          doneAt18,
          isTrue,
          reason: 'the original guarded owner admission shares the finite17s deadline',
        );
        expect(f.queue.snapshot.currentEntryId, 'a');
        expect(f.prepared, ['a']);
        expect(f.engine.loaded.length, 1);
      } finally {
        unawaited(f.queue.dispatch(const Clear()));
        unawaited(f.close());
        await tester.pump();
      }
    },
  );

  for (final action in [
    'pause',
    'resume',
    'seek',
    'manual play',
    'manual replace',
    'mutation',
    'owner',
  ]) {
    testWidgets(
      '$action supersedes guarded Next while its first owner check is pending',
      (tester) async {
        final f = _Fixture();
        await f.start();
        try {
          f.authority.gate = Completer<void>();
          var done = false;
          unawaited(
            f.queue
                .dispatch(Next(expectedEntryId: 'a', fence: collectionFence))
                .then((_) => done = true),
          );
          await tester.pump();
          await tester.pump(const Duration(seconds: 5));
          Future<void>? replacement;
          FiniteQueueMutation? mutation;
          switch (action) {
            case 'pause':
              await f.queue.dispatch(const Pause());
            case 'resume':
              unawaited(f.queue.dispatch(const Resume()));
            case 'seek':
              await f.queue.dispatch(const Seek(Duration(seconds: 42)));
            case 'manual play':
              replacement = f.queue.dispatch(const PlayEntry('c'));
            case 'manual replace':
              replacement = f.queue.dispatch(
                ReplaceQueue([
                  f.row('manual', _manual),
                ], fence: collectionFence),
              );
            case 'mutation':
              mutation = f.policy.beginMutation();
            case 'owner':
              f.authority.switchOwner();
          }
          f.authority.gate!.complete();
          await tester.pump();
          await replacement;
          if (mutation != null) f.policy.finishMutation(mutation);
          await tester.pump();
          expect(done, isTrue);
          expect(f.prepared, isNot(contains('b')));
          expect(f.queue.snapshot.currentEntryId, switch (action) {
            'manual play' => 'c',
            'manual replace' => 'manual',
            'owner' => null,
            _ => 'a',
          });
        } finally {
          unawaited(f.queue.dispatch(const Clear()));
          unawaited(f.close());
          await tester.pump();
        }
      },
    );
  }

  testWidgets('guarded owner and finite HTTP consume one17s deadline', (
    tester,
  ) async {
    final f = _Fixture();
    await f.start();
    try {
      f.authority.gate = Completer<void>();
      final response = Completer<ApiResponse>();
      f.admissionReply = (_) => response.future;
      var done = false;
      unawaited(
        f.queue
            .dispatch(Next(expectedEntryId: 'a', fence: collectionFence))
            .then((_) => done = true),
      );
      await tester.pump();
      await tester.pump(const Duration(seconds: 8));
      f.authority.gate!.complete();
      await tester.pump();
      expect(f.reads.length, 1);
      await tester.pump(const Duration(seconds: 9));
      expect(
        done,
        isTrue,
        reason: 'the finite request must not start a second17s budget after owner admission',
      );
      expect(f.queue.snapshot.currentEntryId, 'a');
      response.complete(f.allowed(f.reads.single));
      await tester.pump();
      expect(f.prepared, ['a']);
    } finally {
      unawaited(f.queue.dispatch(const Clear()));
      unawaited(f.close());
      await tester.pump();
    }
  });

  testWidgets(
    'guarded manual successor requires owner admission without a finite HTTP request',
    (tester) async {
      final f = _Fixture(manualNext: true);
      await f.start();
      try {
        f.authority.gate = Completer<void>();
        final next = f.queue.dispatch(
          Next(expectedEntryId: 'a', fence: collectionFence),
        );
        await tester.pump();
        expect(f.prepared, ['a']);
        f.authority.gate!.complete();
        await tester.pump();
        await next;
        expect(f.queue.snapshot.currentEntryId, 'b');
        expect(f.reads, isEmpty);
      } finally {
        unawaited(f.queue.dispatch(const Clear()));
        unawaited(f.close());
        await tester.pump();
      }
    },
  );
}

class _Authority extends CollectionAuthority {
  Completer<void>? gate;
  @override
  Future<void> assertCurrent(SessionFence fence) async {
    await gate?.future;
    await super.assertCurrent(fence);
  }
}

class _CapturePlayback implements PlaybackController {
  _CapturePlayback(this.inner);
  final PlaybackController inner;
  Future<void>? guardedNext;
  @override
  QueueSnapshot get snapshot => inner.snapshot;
  @override
  Stream<QueueSnapshot> get snapshots => inner.snapshots;
  @override
  Stream<PlaybackEvent> get events => inner.events;
  @override
  List<QueueEntry> createEntries(Iterable<Track> tracks, PlayContext context) =>
      inner.createEntries(tracks, context);
  @override
  Future<void> dispatch(PlaybackCommand command) {
    final future = inner.dispatch(command);
    if (command is Next && command.fence != null) guardedNext = future;
    return future;
  }

  @override
  Future<void> dispose() async {}
}

class _Fixture {
  _Fixture({this.manualNext = false}) {
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
    playback = _CapturePlayback(queue);
    transport = CollectionTransport((request, _) {
      if (request.path.endsWith('queue-admission')) {
        return admissionReply?.call(request) ?? allowed(request);
      }
      return preferenceResponse(
        Uri.decodeComponent(request.path.split('/')[4]),
        request.body!['signal'] as String,
      );
    });
    policy = FiniteQueueAdmissionCoordinator(
      api: FiniteQueueAdmissionApi(transport: transport),
      authority: authority,
      snapshot: () => queue.snapshot,
      snapshots: queue.snapshots,
    );
    queue.finiteAdmission = policy;
    preferences = PreferenceController(
      transport: transport,
      authority: authority,
      fence: collectionFence,
      playback: playback,
      finiteAdmission: policy,
    );
    rows = [
      row('a', _manual),
      row('b', manualNext ? _manual : _recommended),
      row('c', _recommended),
    ];
  }
  final bool manualNext;
  final authority = _Authority();
  final engine = FakeEngine();
  final prepared = <String>[];
  late final QueueCoordinator queue;
  late final _CapturePlayback playback;
  late final CollectionTransport transport;
  late final FiniteQueueAdmissionCoordinator policy;
  late final PreferenceController preferences;
  late final List<QueueEntry> rows;
  Future<ApiResponse> Function(ApiRequest)? admissionReply;
  List<ApiRequest> get reads => transport.requests
      .where((r) => r.path.endsWith('queue-admission'))
      .toList();
  QueueEntry row(String id, PlayContext context) => QueueEntry(
    entryId: id,
    track: Track(ref: LibraryTrackRef(id), title: id, artist: 'Fixture'),
    context: context,
  );
  ApiResponse allowed(ApiRequest request) => ApiResponse(200, {
    'version': 1,
    'appliesTo': 'recommended_future',
    'decisions': [
      for (final ref in request.body!['references'] as List)
        {...ref as Map, 'state': 'allowed'},
    ],
  });
  Future<void> start() async {
    await queue.dispatch(ReplaceQueue(rows, fence: collectionFence));
    engine.emit(position: const Duration(seconds: 37));
  }

  Future<void> close() async {
    if (authority.gate?.isCompleted == false) authority.gate!.complete();
    preferences.dispose();
    await policy.close();
    await queue.dispose();
    await authority.updates.close();
  }
}
