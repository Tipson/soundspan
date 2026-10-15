import 'play_context.dart';
import 'track.dart';
export 'play_context.dart';

/// One occurrence in the queue. The queue authority generates [entryId]; using
/// a track identity as entry ID would collapse repeated occurrences.
final class QueueEntry {
  const QueueEntry({
    required this.entryId,
    required this.track,
    required this.context,
  });

  final String entryId;
  final Track track;
  final PlayContext context;
}
