import '../core/model/app_failure.dart';
import '../core/model/owner_key.dart';
import '../core/model/queue_entry.dart';
export '../core/model/queue_entry.dart';

enum QueueRepeat { off, one, all }

enum PlaybackProcessing { idle, loading, buffering, ready, completed, failed }

enum PlaybackEventKind {
  state,
  position,
  seek,
  transition,
  buffering,
  completed,
  failure,
}

/// Service truth. No ephemeral source URI or credentials may enter this model.
final class QueueSnapshot {
  QueueSnapshot({
    Iterable<QueueEntry> entries = const [],
    Iterable<String> effectiveOrder = const [],
    this.currentEntryId,
    this.fence,
    this.position = Duration.zero,
    this.duration,
    this.bufferedPosition = Duration.zero,
    this.processing = PlaybackProcessing.idle,
    this.playingIntent = false,
    this.focusSuspended = false,
    this.audible = false,
    this.shuffle = false,
    this.repeat = QueueRepeat.off,
    this.volume = 1,
    this.failure,
    this.generation = 0,
    this.lineage = 0,
  }) : entries = List.unmodifiable(entries),
       effectiveOrder = List.unmodifiable(effectiveOrder);
  final List<QueueEntry> entries;
  final List<String> effectiveOrder;
  final String? currentEntryId;
  final SessionFence? fence;
  final Duration position;
  final Duration? duration;
  final Duration bufferedPosition;
  final PlaybackProcessing processing;
  final bool playingIntent;

  /// Runtime interruption state. Never restore OS focus from a checkpoint.
  final bool focusSuspended;
  bool get playing => playingIntent && !focusSuspended;
  final bool audible;
  final bool shuffle;
  final QueueRepeat repeat;
  final double volume;
  final AppFailure? failure;
  final int generation;

  /// Queue provenance; playback transitions do not change this revision.
  final int lineage;
  QueueEntry? get currentEntry {
    for (final entry in entries) {
      if (entry.entryId == currentEntryId) return entry;
    }
    return null;
  }
}

/// Monotonic elapsed time belongs to an injected clock, never to track position.
final class PlaybackEvent {
  const PlaybackEvent({
    required this.kind,
    required this.snapshot,
    required this.elapsed,
    this.previousEntryId,
  });
  final PlaybackEventKind kind;
  final QueueSnapshot snapshot;
  final Duration elapsed;
  final String? previousEntryId;
}
