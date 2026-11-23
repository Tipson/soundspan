import 'queue_snapshot.dart';
import '../core/model/owner_key.dart';
import '../core/model/track_ref.dart';

sealed class PlaybackCommand {
  const PlaybackCommand();
}

final class ReplaceQueue extends PlaybackCommand {
  ReplaceQueue(
    Iterable<QueueEntry> entries, {
    required this.fence,
    this.expectedLineage,
    this.automaticRecommendation = false,
    this.orderedRecommendation = false,
    this.initialEntryId,
    this.play = true,
    this.preparationCurrent,
  }) : entries = List.unmodifiable(entries);
  final List<QueueEntry> entries;
  final SessionFence fence;
  final int? expectedLineage;

  /// Lineage guards also protect manual Play; only the Wave producer opts in.
  final bool automaticRecommendation;
  final bool orderedRecommendation;
  final String? initialEntryId;
  final bool play;

  /// Optional runtime owner/source/mutation permission for a prepared snapshot.
  /// It is consumed only before queue attachment, never persisted as a grant.
  final bool Function()? preparationCurrent;
}

final class Enqueue extends PlaybackCommand {
  Enqueue(
    Iterable<QueueEntry> entries, {
    required this.fence,
    this.expectedLineage,
    this.automaticRecommendation = false,
    this.orderedRecommendation = false,
  }) : entries = List.unmodifiable(entries);
  final List<QueueEntry> entries;
  final SessionFence fence;
  final int? expectedLineage;
  final bool automaticRecommendation;
  final bool orderedRecommendation;
}

/// Guards an exact recording in the current recommendation scope and prunes
/// future occurrences. Clearing the guard never restores removed occurrences.
final class SetRecommendationExclusion extends PlaybackCommand {
  const SetRecommendationExclusion(
    this.ref, {
    required this.fence,
    required this.expectedLineage,
    required this.recommendationScope,
    this.exclude = true,
    this.advanceEntryId,
    this.advanceGeneration,
  });

  final TrackRef ref;
  final SessionFence fence;
  final int expectedLineage;
  final bool exclude;
  final String recommendationScope;
  final String? advanceEntryId;
  final int? advanceGeneration;
}

/// Metadata-only finite-session edit; current audio and history stay in place.
final class EditSmartShuffle extends PlaybackCommand {
  const EditSmartShuffle({
    required this.fence,
    required this.expectedLineage,
    required this.expectedGeneration,
    required this.expectedCurrentEntryId,
    required this.sessionId,
    this.restoreEntries,
    this.restoreOrder,
    this.admissionCurrent,
  });
  final SessionFence fence;
  final int expectedLineage, expectedGeneration;
  final String? expectedCurrentEntryId;
  final String sessionId;
  final List<QueueEntry>? restoreEntries;
  final List<String>? restoreOrder;
  final bool Function()? admissionCurrent;
}

/// Hydrates durable metadata only. Audio starts only after an explicit Resume.
/// The lineage captured before loading prevents boot from undoing user intent.
final class RestoreQueue extends PlaybackCommand {
  const RestoreQueue(
    this.snapshot, {
    required this.fence,
    required this.expectedLineage,
  });

  final QueueSnapshot snapshot;
  final SessionFence fence;
  final int expectedLineage;
}

final class PlayEntry extends PlaybackCommand {
  const PlayEntry(this.entryId);
  final String entryId;
}

final class Seek extends PlaybackCommand {
  const Seek(this.position);
  final Duration position;
}

final class Next extends PlaybackCommand {
  const Next({this.expectedEntryId, this.fence});
  final String? expectedEntryId;
  final SessionFence? fence;
}

final class Previous extends PlaybackCommand {
  const Previous();
}

final class Remove extends PlaybackCommand {
  const Remove(this.entryId);
  final String entryId;
}

final class Reorder extends PlaybackCommand {
  const Reorder(this.entryIds);
  final List<String> entryIds;
}

final class Clear extends PlaybackCommand {
  const Clear();
}

final class SetShuffle extends PlaybackCommand {
  const SetShuffle(this.enabled);
  final bool enabled;
}

final class SetRepeat extends PlaybackCommand {
  const SetRepeat(this.repeat);
  final QueueRepeat repeat;
}

final class Pause extends PlaybackCommand {
  const Pause();
}

final class Resume extends PlaybackCommand {
  const Resume();
}

final class SetVolume extends PlaybackCommand {
  const SetVolume(this.volume);
  final double volume;
}
