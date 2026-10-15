import '../model/track.dart';
import 'track_mapping.dart';

/// Current discovery track, including saved local discovery and online weekly.
/// Snapshot isLiked is intentionally not copied into authoritative preferences.
final class WeeklyTrackMapper {
  const WeeklyTrackMapper();

  Track map(Map<String, Object?> dto) {
    const fields = TrackFields('/api/discover/current');
    final source = fields.string(
      dto['sourceType'],
      'sourceType',
      nonempty: true,
    );
    return fields.buildTrack(
      {...dto, 'source': source},
      title: fields.string(dto['title'], 'title', nonempty: true),
      artist: fields.string(dto['artist'], 'artist', nonempty: true),
      album: fields.string(dto['album'], 'album'),
      albumId: fields.optionalString(dto['albumId'], 'albumId'),
      cover: fields.artwork(dto['coverUrl'], 'coverUrl'),
      albumLoudnessLufs: fields.number(
        dto['albumLoudnessLufs'],
        'albumLoudnessLufs',
      ),
      albumTruePeakDb: fields.number(dto['albumTruePeakDb'], 'albumTruePeakDb'),
      playbackAllowed: fields.boolean(dto['available'], 'available') ?? true,
      unavailableReason: dto['available'] == false
          ? 'provider_unavailable'
          : null,
    );
  }
}
