import '../model/track.dart';
import 'track_mapping.dart';

/// One PersonalizedTrack from home/daily-mixes. Nested display DTO only.
final class HomeTrackMapper {
  const HomeTrackMapper();

  Track map(Map<String, Object?> dto) {
    const fields = TrackFields('/api/personalized/home');
    final artist = fields.object(dto['artist'], 'artist');
    final album = fields.object(dto['album'], 'album');
    return fields.buildTrack(
      dto,
      title: fields.string(dto['title'], 'title', nonempty: true),
      artist: fields.string(artist['name'], 'artist.name', nonempty: true),
      artistId: fields.optionalString(artist['id'], 'artist.id'),
      album: fields.string(album['title'], 'album.title'),
      albumId: fields.optionalString(album['id'], 'album.id'),
      cover: fields.artwork(album['coverArt'], 'album.coverArt'),
      albumLoudnessLufs: fields.number(
        album['albumLoudnessLufs'],
        'album.albumLoudnessLufs',
      ),
      albumTruePeakDb: fields.number(
        album['albumTruePeakDb'],
        'album.albumTruePeakDb',
      ),
    );
  }
}
