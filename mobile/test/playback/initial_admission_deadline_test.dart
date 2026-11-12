import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/queue_coordinator.dart';

import '../support/media_fixtures.dart';
import 'playback_admission_test.dart' show CachedAuthority;
import 'queue_coordinator_test.dart' show FakeEngine, entry;

void main() {
  test(
    'a current lineage-guarded replacement reports its admission timeout',
    () async {
      final authority = CachedAuthority(
        await mediaAuthority(Uri.parse('https://audio.example')),
      )..gateAdmissions = true;
      final queue = QueueCoordinator(
        authority: authority,
        engine: FakeEngine(),
        prepareTimeout: const Duration(milliseconds: 30),
        prepare: (_, _) async => throw StateError('not admitted'),
      );
      Object? failure;
      final pending = queue
          .dispatch(
            ReplaceQueue(
              [entry('a')],
              fence: authority.requireFence(),
              expectedLineage: queue.snapshot.lineage,
            ),
          )
          .then<void>(
            (_) {},
            onError: (Object error) {
              failure = error;
            },
          );
      addTearDown(() async {
        authority.gateAdmissions = false;
        for (final gate in authority.pendingAdmissions) {
          if (!gate.isCompleted) gate.complete();
        }
        await pending;
        await queue.dispose();
      });
      await Future<void>.delayed(const Duration(milliseconds: 90));
      expect(
        failure,
        isA<AppFailure>().having(
          (e) => e.code,
          'code',
          'playback_admission_timeout',
        ),
      );
      expect(queue.snapshot.entries, isEmpty);
    },
  );
  test(
    'initial admission times out without replacing or later playing the queue',
    () async {
      final authority = CachedAuthority(
        await mediaAuthority(Uri.parse('https://audio.example')),
      );
      final engine = FakeEngine();
      final queue = QueueCoordinator(
        authority: authority,
        engine: engine,
        prepareTimeout: const Duration(milliseconds: 30),
        prepare: (_, _) async => PreparedAudio(
          uri: Uri.parse('file:///ready.wav'),
          revoke: () async {},
        ),
      );
      await queue.dispatch(
        ReplaceQueue(
          [entry('original')],
          fence: authority.requireFence(),
          play: false,
        ),
      );
      authority.gateAdmissions = true;
      Object? failure;
      var completed = false;
      final pending = queue
          .dispatch(
            ReplaceQueue([
              entry('replacement'),
            ], fence: authority.requireFence()),
          )
          .then<void>(
            (_) {
              completed = true;
            },
            onError: (Object error) {
              completed = true;
              failure = error;
            },
          );
      addTearDown(() async {
        authority.gateAdmissions = false;
        for (final gate in authority.pendingAdmissions) {
          if (!gate.isCompleted) gate.complete();
        }
        await pending;
        await queue.dispose();
      });
      await Future<void>.delayed(const Duration(milliseconds: 100));
      expect(
        completed,
        true,
        reason: 'the initial broker RPC must not retain the UI for 45 seconds',
      );
      expect(
        failure,
        isA<AppFailure>().having(
          (e) => e.code,
          'code',
          'playback_admission_timeout',
        ),
      );
      expect(queue.snapshot.currentEntryId, 'original');
      authority.gateAdmissions = false;
      authority.pendingAdmissions.single.complete();
      await pending;
      await pumpEventQueue();
      expect(queue.snapshot.currentEntryId, 'original');
      expect(engine.plays, 0);
    },
  );
}
