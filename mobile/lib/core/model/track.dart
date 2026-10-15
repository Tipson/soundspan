import 'track_ref.dart';

/// Immutable display/playback metadata. Server file paths and leases are
/// intentionally absent: device downloads belong to the offline repository.
final class Track {
  const Track({
    required this.ref,
    required this.title,
    required this.artist,
    this.album,
    this.artwork,
    this.duration,
    this.explicit,
    this.artistId,
    this.albumId,
    this.trackNo,
    this.loudnessLufs,
    this.truePeakDb,
    this.albumLoudnessLufs,
    this.albumTruePeakDb,
    this.recommendationGenerationId,
    this.playbackAllowed = true,
    this.unavailableReason,
  });

  final TrackRef ref;
  final String title;
  final String artist;
  final String? album;
  final Uri? artwork;
  final Duration? duration;
  final bool? explicit;
  final String? artistId;
  final String? albumId;
  final int? trackNo;
  final double? loudnessLufs;
  final double? truePeakDb;
  final double? albumLoudnessLufs;
  final double? albumTruePeakDb;
  final String? recommendationGenerationId;
  final bool playbackAllowed;
  final String? unavailableReason;

  bool get playable => ref.playable && playbackAllowed;
}
