import '../model/track.dart';
import 'track_mapping.dart';

/// One liked playlist track. Cursor IDs are response pagination, never parsed
/// here. Server filePath cannot create a device download.
final class LikedTrackMapper {
  const LikedTrackMapper();

  Track map(Map<String, Object?> dto) {
    const fields = TrackFields('/api/library/liked');
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
