import '../model/track.dart';
import '../model/track_ref.dart';
import 'track_mapping.dart';

/// One resolved playlist item, never a pending import or preview cover row.
final class PlaylistTrackMapper {
  const PlaylistTrackMapper();

  Track map(Map<String, Object?> dto) {
    const fields = TrackFields('/api/playlists/:id');
    if (dto['type'] != 'track') fields.fail('type');
    final playback = dto['playback'] == null
        ? <String, Object?>{}
        : fields.object(dto['playback'], 'playback');
    final allowed =
        fields.boolean(playback['isPlayable'], 'playback.isPlayable') ?? true;
    final reason = fields.optionalString(playback['reason'], 'playback.reason');
    if (dto['track'] == null) {
      final id = fields.string(dto['id'], 'id', nonempty: true);
      return Track(
        ref: UnavailableTrackRef(
          'playlist-item:$id',
          reason: reason ?? 'missing_provider_track',
        ),
        title: '',
        artist: '',
        playbackAllowed: false,
        unavailableReason: reason ?? 'missing_provider_track',
      );
    }
    final track = fields.object(dto['track'], 'track');
    final album = fields.object(track['album'], 'track.album');
    final artist = fields.object(album['artist'], 'track.album.artist');
    return fields.buildTrack(
      track,
      title: fields.string(track['title'], 'track.title', nonempty: true),
      artist: fields.string(
        artist['name'],
        'track.album.artist.name',
        nonempty: true,
      ),
      artistId: fields.optionalString(artist['id'], 'track.album.artist.id'),
      album: fields.string(album['title'], 'track.album.title'),
      albumId: fields.optionalString(album['id'], 'track.album.id'),
      cover: fields.artwork(album['coverArt'], 'track.album.coverArt'),
      albumLoudnessLufs: fields.number(
        album['albumLoudnessLufs'],
        'album.albumLoudnessLufs',
      ),
      albumTruePeakDb: fields.number(
        album['albumTruePeakDb'],
        'album.albumTruePeakDb',
      ),
      playbackAllowed: allowed,
      unavailableReason: reason,
    );
  }
}
