import 'package:flutter_test/flutter_test.dart';
import 'package:audio_service/audio_service.dart';
import 'package:soundspan/playback/soundspan_audio_handler.dart';
import 'package:soundspan/playback/audio_focus_coordinator.dart';
import 'package:soundspan/playback/playback_command.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/queue_coordinator.dart';

import '../support/media_fixtures.dart';
import 'queue_coordinator_test.dart' show FakeEngine, entry;

void main() {
  test(
    'permanent Android loss needs explicit play and cannot poison a new queue',
    () async {
      final authority = await mediaAuthority(
        Uri.parse('https://audio.example'),
      );
      final engine = FakeEngine();
      final queue = QueueCoordinator(
        authority: authority,
        engine: engine,
        prepare: (_, _) async => PreparedAudio(
          uri: Uri.parse('file:///synthetic.wav'),
          revoke: () async {},
        ),
      );
      final focus = AudioFocusCoordinator(queue);
      addTearDown(() async {
        await focus.dispose();
        await queue.dispose();
      });
      await queue.dispatch(
        ReplaceQueue([entry('a')], fence: authority.requireFence()),
      );
      await focus.interruptionBegan(permanent: true);
      expect(queue.snapshot.playingIntent, isFalse);
      expect(queue.snapshot.playing, isFalse);
      await focus.interruptionEnded(allowResume: true);
      expect(engine.plays, 1);
      await queue.dispatch(
        ReplaceQueue([entry('b')], fence: authority.requireFence()),
      );
      expect(engine.plays, 2);
      await focus.interruptionBegan();
      await queue.dispatch(const Clear());
      await queue.dispatch(
        ReplaceQueue([entry('c')], fence: authority.requireFence()),
      );
      expect(engine.plays, 3);
      await focus.interruptionEnded(allowResume: true);
      expect(engine.plays, 3);
    },
  );
  test(
    'interruption publishes paused system state and manual play recovers',
    () async {
      final authority = await mediaAuthority(
        Uri.parse('https://audio.example'),
      );
      final engine = FakeEngine();
      final queue = QueueCoordinator(
        authority: authority,
        engine: engine,
        prepare: (_, _) async => PreparedAudio(
          uri: Uri.parse('file:///synthetic.wav'),
          revoke: () async {},
        ),
      );
      final focus = AudioFocusCoordinator(queue);
      final handler = SoundspanAudioHandler(coordinator: queue, focus: focus);
      addTearDown(handler.dispose);
      await queue.dispatch(
        ReplaceQueue([entry('a')], fence: authority.requireFence()),
      );
      await focus.interruptionBegan();
      await pumpEventQueue();
      expect(handler.playbackState.value.playing, isFalse);
      expect(handler.playbackState.value.controls, contains(MediaControl.play));
      expect(
        queue.snapshot.playingIntent,
        isTrue,
        reason: 'Transient return retains intent',
      );
      await handler.play();
      expect(
        engine.plays,
        2,
        reason: 'Explicit Play must reclaim focus without an end callback',
      );
      await focus.interruptionEnded(allowResume: true);
      expect(
        engine.plays,
        2,
        reason: 'Late return must not replay a manual resume',
      );
      await focus.interruptionBegan();
      await focus.interruptionEnded(allowResume: true);
      expect(
        engine.plays,
        3,
        reason: 'A later independent interruption still resumes',
      );
    },
  );

  test('nonresumable return publishes a real pause', () async {
    final authority = await mediaAuthority(Uri.parse('https://audio.example'));
    final engine = FakeEngine();
    final queue = QueueCoordinator(
      authority: authority,
      engine: engine,
      prepare: (_, _) async => PreparedAudio(
        uri: Uri.parse('file:///synthetic.wav'),
        revoke: () async {},
      ),
    );
    final focus = AudioFocusCoordinator(queue);
    addTearDown(() async {
      await focus.dispose();
      await queue.dispose();
    });
    await queue.dispatch(
      ReplaceQueue([entry('a')], fence: authority.requireFence()),
    );
    await focus.interruptionBegan();
    await focus.interruptionEnded(allowResume: false);
    expect(queue.snapshot.playingIntent, isFalse);
    await queue.dispatch(const Resume());
    expect(engine.plays, 2);
  });

  test(
    'transient focus returns resume only unchanged entry and user intent',
    () async {
      final authority = await mediaAuthority(
        Uri.parse('https://audio.example'),
      );
      final engine = FakeEngine();
      final queue = QueueCoordinator(
        authority: authority,
        engine: engine,
        prepare: (_, _) async => PreparedAudio(
          uri: Uri.parse('file:///synthetic.wav'),
          revoke: () async {},
        ),
      );
      final focus = AudioFocusCoordinator(queue);
      await queue.dispatch(
        ReplaceQueue([entry('a'), entry('b')], fence: authority.requireFence()),
      );
      await focus.interruptionBegan();
      await focus.interruptionEnded(allowResume: true);
      expect(engine.plays, 2);
      await focus.interruptionBegan();
      await queue.dispatch(const Pause());
      await focus.interruptionEnded(allowResume: true);
      expect(engine.plays, 2);
      await queue.dispatch(const Resume());
      await focus.interruptionBegan();
      await queue.dispatch(const Next());
      await focus.interruptionEnded(allowResume: true);
      expect(engine.plays, 3);
      await focus.dispose();
      await queue.dispose();
    },
  );
  test('noisy route change and unknown return never auto resume', () async {
    final authority = await mediaAuthority(Uri.parse('https://audio.example'));
    final engine = FakeEngine();
    final queue = QueueCoordinator(
      authority: authority,
      engine: engine,
      prepare: (_, _) async => PreparedAudio(
        uri: Uri.parse('file:///synthetic.wav'),
        revoke: () async {},
      ),
    );
    final focus = AudioFocusCoordinator(queue);
    await queue.dispatch(
      ReplaceQueue([entry('a')], fence: authority.requireFence()),
    );
    await focus.interruptionBegan();
    await focus.becomingNoisy();
    await focus.interruptionEnded(allowResume: true);
    expect(queue.snapshot.playingIntent, false);
    expect(engine.plays, 1);
    await queue.dispatch(const Resume());
    await focus.interruptionBegan();
    await focus.interruptionEnded(allowResume: false);
    expect(engine.plays, 2);
    await focus.dispose();
    await queue.dispose();
  });
}
