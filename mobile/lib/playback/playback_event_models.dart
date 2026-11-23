import '../core/model/queue_entry.dart';
import '../core/model/track_ref.dart';
import 'wave_selection.dart';

enum PlayOutcome { failed, skipped, meaningful, completed }

enum PlayCreateState { idle, pending, known, ambiguous }

/// Absolute, bounded server engagement totals. Never a delta or seek position.
final class PlayEngagement {
  const PlayEngagement({
    required this.listenedSeconds,
    required this.completionRatio,
    required this.outcome,
  });
  final double listenedSeconds;
  final double completionRatio;
  final PlayOutcome outcome;
  Map<String, Object?> toJson() => {
    'listenedSeconds': listenedSeconds.clamp(0, 86400),
    'completionRatio': completionRatio.clamp(0, 1),
    'outcome': outcome.name,
  };
  factory PlayEngagement.fromJson(Map<String, Object?> json) => PlayEngagement(
    listenedSeconds: (json['listenedSeconds'] as num).toDouble(),
    completionRatio: (json['completionRatio'] as num).toDouble(),
    outcome: PlayOutcome.values.byName(json['outcome'] as String),
  );
  PlayEngagement merge(PlayEngagement other) => PlayEngagement(
    listenedSeconds: other.listenedSeconds > listenedSeconds
        ? other.listenedSeconds
        : listenedSeconds,
    completionRatio: other.completionRatio > completionRatio
        ? other.completionRatio
        : completionRatio,
    outcome: other.outcome.index > outcome.index ? other.outcome : outcome,
  );
}

/// One exact source identity; native snapshots are never coerced into video IDs.
Map<String, Object?> playStartBody(QueueEntry entry) {
  final track = entry.track;
  final context = entry.context;
  final identity = switch (track.ref) {
    LibraryTrackRef(:final libraryId) => <String, Object?>{
      'trackId': libraryId,
    },
    NativeTrackRef(:final recording) => <String, Object?>{
      'musicSourceRecording': recording.toJson(),
    },
    YoutubeTrackRef(:final videoId) => <String, Object?>{
      'youtubeVideoId': videoId,
      'title': track.title.trim(),
      'artist': track.artist.trim(),
      'album': track.album?.trim().isNotEmpty == true
          ? track.album!.trim()
          : 'Single',
      'duration': track.duration?.inSeconds ?? 0,
      if (track.artwork != null) 'thumbnailUrl': track.artwork.toString(),
    },
    UnavailableTrackRef() => throw ArgumentError(
      'Unavailable recording cannot create a play',
    ),
  };
  return {
    ...identity,
    'playContext': context.surface.name,
    if (context.waveMode != null) 'waveMode': waveModeWire(context.waveMode!),
    if (context.recommendationGenerationId != null)
      'recommendationGenerationId': context.recommendationGenerationId,
    if (context.recommendationSessionId != null)
      'recommendationSessionId': context.recommendationSessionId,
  };
}

final class PlaybackReportState {
  const PlaybackReportState({
    this.entryId,
    this.createState = PlayCreateState.idle,
    this.listenedSeconds = 0,
    this.errorCode,
  });
  final String? entryId;
  final PlayCreateState createState;
  final double listenedSeconds;
  final String? errorCode;
}
