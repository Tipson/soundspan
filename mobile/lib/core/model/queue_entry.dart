import 'play_context.dart';
import 'track.dart';
import 'smart_shuffle_lineage.dart';
export 'play_context.dart';
export 'smart_shuffle_lineage.dart';

/// One occurrence in the queue. The queue authority generates [entryId]; using
/// a track identity as entry ID would collapse repeated occurrences.
final class QueueEntry {
  const QueueEntry({
    required this.entryId,
    required this.track,
    required this.context,
    this.smartShuffle,
  });

  final String entryId;
  final Track track;
  final PlayContext context;
  final SmartShuffleLineage? smartShuffle;

  QueueEntry withSmartShuffle(SmartShuffleLineage value) => QueueEntry(
    entryId: entryId,
    track: track,
    context: context,
    smartShuffle: value,
  );
}
