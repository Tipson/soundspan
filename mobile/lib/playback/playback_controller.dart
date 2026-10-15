import 'playback_command.dart';
import 'queue_snapshot.dart';
import '../core/model/track.dart';
export 'playback_command.dart';
export 'queue_snapshot.dart';

abstract interface class PlaybackController {
  QueueSnapshot get snapshot;
  Stream<QueueSnapshot> get snapshots;
  Stream<PlaybackEvent> get events;
  List<QueueEntry> createEntries(Iterable<Track> tracks, PlayContext context);
  Future<void> dispatch(PlaybackCommand command);
  Future<void> dispose();
}
