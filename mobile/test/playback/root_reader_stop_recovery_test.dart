import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/queue_coordinator.dart';

import '../support/collection_fixtures.dart';
import 'queue_coordinator_test.dart' show FakeEngine, entry;

class OnceFailedStop extends FakeEngine {
  bool failNext = false;
  @override
  Future<void> stop() async {
    if (failNext) {
      failNext = false;
      throw StateError('one transient native stop failure');
    }
    await super.stop();
  }
}

void main() {
  test('independent: a later confirmed stop releases the retained local reader', () async {
    final engine = OnceFailedStop();
    var released = 0;
    final queue = QueueCoordinator(
      authority: CollectionAuthority(),
      engine: engine,
      prepare: (_, _) async => PreparedAudio(
        uri: Uri.file('D:/CodexData/temp/owned-synthetic-reader.wav'),
        revoke: () async {
          released++;
        },
      ),
    );
    try {
      await queue.dispatch(ReplaceQueue([entry('a')], fence: collectionFence));
      engine.failNext = true;
      try {
        await queue.dispatch(const Clear());
      } catch (_) {
        /* First stop intentionally failed. */
      }
      expect(released, 0, reason: 'A failed stop cannot release the pin');
      await queue.dispatch(const Clear());
      expect(
        released,
        1,
        reason:
            'The next successful global stop must drain the retained resource',
      );
    } finally {
      await queue.dispose();
    }
  });
}
