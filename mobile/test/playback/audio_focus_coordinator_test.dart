import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/playback/audio_focus_coordinator.dart';
import 'package:soundspan/playback/playback_command.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/queue_coordinator.dart';

import '../support/media_fixtures.dart';
import 'queue_coordinator_test.dart' show FakeEngine, entry;

void main() {
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
