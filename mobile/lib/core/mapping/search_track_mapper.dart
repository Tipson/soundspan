import '../model/track.dart';
import '../model/track_ref.dart';
import 'track_mapping.dart';

/// Search endpoints have three explicit adapters rather than one guessed DTO.
final class SearchTrackMapper {
  const SearchTrackMapper();

  Track map(Map<String, Object?> dto) {
    if (dto.containsKey('type')) return mapDiscovery(dto);
    if (dto['provider'] is String) return mapCatalog(dto);
    return mapLibrary(dto);
  }

  /// /api/music-sources/catalog tracks are bare public exact recordings.
  Track mapCatalog(Map<String, Object?> dto) {
    const fields = TrackFields('/api/music-sources/catalog');
    final recording = fields.recording(dto);
    return Track(
      ref: NativeTrackRef(recording),
      title: recording.title,
      artist: recording.artists.join(', '),
      duration: recording.duration,
      explicit: switch (recording.contentVersion) {
        MusicContentVersion.explicit => true,
        MusicContentVersion.clean => false,
        MusicContentVersion.unknown => null,
      },
    );
  }

  /// /api/search/discover has name and optional string artist/album/image.
  Track mapDiscovery(Map<String, Object?> dto) {
    const fields = TrackFields('/api/search/discover');
    if (dto['type'] != 'track') fields.fail('type');
    final title = fields.string(dto['name'], 'name', nonempty: true);
    final artist = fields.optionalString(dto['artist'], 'artist') ?? '';
    final videoId = fields.optionalString(
      dto['youtubeVideoId'],
      'youtubeVideoId',
    );
    final id = fields.optionalString(dto['id'], 'id');
    if (videoId == null || videoId.trim().isEmpty) {
      return Track(
        ref: UnavailableTrackRef(
          id ?? 'unresolved:missing-provider-track',
          reason: 'missing_provider_track',
        ),
        title: title,
        artist: artist,
        album: fields.optionalString(dto['album'], 'album'),
        artwork: fields.artwork(dto['image'], 'image'),
        unavailableReason: 'missing_provider_track',
      );
    }
    return fields.buildTrack(
      {...dto, 'id': id ?? 'yt:$videoId', 'source': 'youtube'},
      title: title,
      artist: artist,
      album: fields.optionalString(dto['album'], 'album'),
      cover: fields.artwork(dto['image'], 'image'),
    );
  }

  /// /api/search TrackSearchResult is the flat SQL projection from search.ts.
  Track mapLibrary(Map<String, Object?> dto) {
    const fields = TrackFields('/api/search');
    return fields.buildTrack(
      {...dto, 'source': dto['source'] ?? 'local'},
      title: fields.string(dto['title'], 'title', nonempty: true),
      artist: fields.string(dto['artistName'], 'artistName', nonempty: true),
      artistId: fields.optionalString(dto['artistId'], 'artistId'),
      album: fields.string(dto['albumTitle'], 'albumTitle'),
      albumId: fields.optionalString(dto['albumId'], 'albumId'),
      albumLoudnessLufs: fields.number(
        dto['albumLoudnessLufs'],
        'albumLoudnessLufs',
      ),
      albumTruePeakDb: fields.number(dto['albumTruePeakDb'], 'albumTruePeakDb'),
    );
  }
}
