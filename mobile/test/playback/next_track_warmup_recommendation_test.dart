import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/playback/next_track_warmup.dart';
import 'package:soundspan/playback/playback_controller.dart';

import '../support/media_fixtures.dart';
import '../support/wave_reporting_fixtures.dart';

void main() {
  test(
    'repeat-all warms the admitted recording instead of a disliked past row',
    () async {
      final authority = await mediaAuthority(Uri.parse('https://warm.test'));
      final fence = authority.requireFence();
      final controller = ReportingController();
      const context = PlayContext(
        surface: PlaySurface.wave,
        recommendationSessionId: 'warm-scope',
        recommendationGenerationId: 'warm-generation',
      );
      final entries = controller.createEntries([
        waveTrack('a'),
        waveTrack('b'),
        waveTrack('c'),
      ], context);
      final calls = <String>[];
      final warmer = NextTrackWarmup(
        controller: controller,
        authority: authority,
        networkAllowed: () => true,
        warm: (entry, captured, cancellation) async {
          expect(captured, fence);
          calls.add(entry.entryId);
        },
      );
      addTearDown(() async {
        await warmer.close();
        await controller.dispose();
      });
      controller.emit(
        QueueSnapshot(
          entries: entries,
          effectiveOrder: entries.map((entry) => entry.entryId),
          currentEntryId: entries.last.entryId,
          fence: fence,
          generation: 1,
          lineage: 1,
          playingIntent: true,
          audible: true,
          position: const Duration(seconds: 3),
          processing: PlaybackProcessing.ready,
          repeat: QueueRepeat.all,
          recommendationExclusions: {
            context.recommendationScopeKey!: {
              entries.first.track.ref.identityKey,
            },
          },
        ),
      );
      await settle();
      expect(calls, [entries[1].entryId]);
      expect(controller.commands, isEmpty);
    },
  );
}
