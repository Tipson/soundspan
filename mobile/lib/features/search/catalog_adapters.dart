import '../../core/mapping/track_mapping.dart';
import '../../core/model/track.dart';
import '../../core/model/track_ref.dart';
import '../library/library_models.dart';
import 'catalog_models.dart';

Map<String, Object?> objectOrEmpty(Object? value) =>
    value == null ? {} : collectionObject(value);
List<Object?> listOrEmpty(Object? value) =>
    value == null ? [] : collectionList(value);
String? textOrNull(Object? value) =>
    value is String && value.isNotEmpty ? value : null;
Uri? coverUri(Object? value) => value is String ? Uri.tryParse(value) : null;

CatalogEntity entityFromLibrary(
  Map<String, Object?> row,
  CatalogEntityKind kind,
) {
  final artist = objectOrEmpty(row['artist']);
  return CatalogEntity(
    CatalogEntityRef(
      kind: kind,
      source: CatalogSource.library,
      id: collectionString(row['id']),
      name: collectionString(
        kind == CatalogEntityKind.artist ? row['name'] : row['title'],
      ),
      mbid: textOrNull(row['mbid'] ?? row['rgMbid']),
      subtitle: textOrNull(artist['name']),
      artwork: coverUri(row['coverArt'] ?? row['coverUrl'] ?? row['heroUrl']),
    ),
    year: row['year']?.toString(),
  );
}

/// /api/search returns the route's nested projection, not its SQL service row.
final class LibrarySearchAdapter {
  const LibrarySearchAdapter();
  Track map(Map<String, Object?> row) {
    const f = TrackFields('/api/search');
    final album = objectOrEmpty(row['album']),
        artist = objectOrEmpty(album['artist']);
    return f.buildTrack(
      row,
      title: f.string(row['title'], 'title', nonempty: true),
      artist: f.string(artist['name'], 'album.artist.name', nonempty: true),
      artistId: f.optionalString(artist['id'], 'album.artist.id'),
      album: f.optionalString(album['title'], 'album.title'),
      albumId: f.optionalString(album['id'], 'album.id'),
      cover: f.artwork(album['coverUrl'], 'album.coverUrl'),
      albumLoudnessLufs: f.number(
        album['albumLoudnessLufs'],
        'album.albumLoudnessLufs',
      ),
      albumTruePeakDb: f.number(
        album['albumTruePeakDb'],
        'album.albumTruePeakDb',
      ),
    );
  }
}

/// /library artist/album tracks use their own nested artist and album metadata.
Track detailTrack(
  Map<String, Object?> row, {
  required String endpoint,
  required String artistName,
  String? albumTitle,
  Uri? artwork,
  bool metadataOnly = false,
}) {
  final f = TrackFields(endpoint),
      artist = objectOrEmpty(row['artist']),
      album = objectOrEmpty(row['album']);
  final title = f.string(row['title'], 'title', nonempty: true),
      name =
          textOrNull(artist['name']) ??
          textOrNull(objectOrEmpty(album['artist'])['name']) ??
          artistName;
  final unresolved =
      metadataOnly ||
      row['id'] is String && (row['id'] as String).startsWith('lastfm-');
  if (unresolved) {
    return Track(
      ref: UnavailableTrackRef(
        f.string(row['id'], 'id', nonempty: true),
        reason: 'metadata_only',
      ),
      title: title,
      artist: name,
      album: textOrNull(album['title']) ?? albumTitle,
      artwork: coverUri(album['coverArt'] ?? album['coverUrl']) ?? artwork,
      duration: f.duration(row['duration']),
      unavailableReason: 'Для этой записи пока нет доступного источника',
    );
  }
  return f.buildTrack(
    row,
    title: title,
    artist: name,
    artistId: f.optionalString(artist['id'], 'artist.id'),
    album: textOrNull(album['title']) ?? albumTitle,
    albumId: f.optionalString(album['id'], 'album.id'),
    cover: coverUri(album['coverArt'] ?? album['coverUrl']) ?? artwork,
    albumLoudnessLufs: f.number(
      album['albumLoudnessLufs'],
      'album.albumLoudnessLufs',
    ),
    albumTruePeakDb: f.number(
      album['albumTruePeakDb'],
      'album.albumTruePeakDb',
    ),
  );
}

/// Public YouTube artist/album browse rows carry videoId, not a search DTO.
Track youtubeBrowseTrack(
  Map<String, Object?> row, {
  required String artist,
  required String album,
  Uri? artwork,
  int? index,
}) {
  final video = textOrNull(row['videoId']);
  final seconds = row['duration_seconds'] ?? row['duration'];
  Duration? duration;
  if (seconds is num && seconds.isFinite && seconds >= 0) {
    duration = Duration(milliseconds: (seconds * 1000).round());
  }
  if (seconds is String) {
    final chunks = seconds.split(':').map(int.tryParse).toList();
    if (chunks.every((n) => n != null)) {
      var total = 0;
      for (final n in chunks) {
        total = total * 60 + n!;
      }
      duration = Duration(seconds: total);
    }
  }
  return Track(
    ref: video == null
        ? UnavailableTrackRef(
            'yt:missing:$index',
            reason: 'missing_youtube_video_id',
          )
        : YoutubeTrackRef(video),
    title: collectionString(row['title']),
    artist: textOrNull(row['artist']) ?? artist,
    album: textOrNull(row['album']) ?? album,
    artwork: artwork,
    duration: duration,
    explicit: row['isExplicit'] is bool ? row['isExplicit'] as bool : null,
    trackNo: row['trackNumber'] is int ? row['trackNumber'] as int : index,
  );
}

Uri? thumbnail(Object? value) {
  final rows = listOrEmpty(value);
  for (final row in rows.reversed) {
    final url = coverUri(collectionObject(row)['url']);
    if (url != null) return url;
  }
  return null;
}
