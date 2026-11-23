import '../../core/mapping/track_mapping.dart';
import '../../core/model/track.dart';
import '../../core/model/track_ref.dart';
import '../library/library_models.dart';
import '../lyrics/lyrics_repository.dart';

/// IDs retain provider evidence; this route supplies no artist namespace.
class RelatedEntity {
  const RelatedEntity({
    required this.id,
    required this.title,
    this.provider,
    this.artwork,
    required this.artist,
  });
  final String? id, provider;
  final String title;
  final Uri? artwork;
  final bool artist;
}

class RelatedFeed {
  RelatedFeed({
    Iterable<Track> tracks = const [],
    Iterable<RelatedEntity> artists = const [],
    Iterable<RelatedEntity> albums = const [],
    Iterable<String> degradedSources = const [],
    this.nextCursor,
    this.generationId,
  }) : tracks = List.unmodifiable(tracks),
       artists = List.unmodifiable(artists),
       albums = List.unmodifiable(albums),
       degradedSources = List.unmodifiable(degradedSources);
  final List<Track> tracks;
  final List<RelatedEntity> artists, albums;
  final List<String> degradedSources;
  final int? nextCursor;
  final String? generationId;
}

class RelatedRepository extends ExtrasRepository {
  RelatedRepository({
    required super.transport,
    required super.authority,
    required super.fence,
    required super.networkPolicy,
  });
  Future<RelatedFeed> get(Track track) => lookup(track);
  Future<RelatedFeed> lookup(Track track, {int? cursor}) async {
    final dto = collectionObject(
      await request(
        '/api/player/related',
        query: {
          'seedTrackId': extrasTrackId(track),
          'artist': track.artist,
          'title': track.title,
          'limit': '12',
          if (cursor != null) 'cursor': '$cursor',
        },
      ),
    );
    final next = dto['nextCursor'];
    if (next != null && (next is! int || next < 0)) {
      throw collectionFailure(StateError('related cursor'));
    }
    List<RelatedEntity> entities(String field, bool artist) => [
      for (final raw in collectionList(dto[field]))
        _entity(collectionObject(raw), artist),
    ];
    return RelatedFeed(
      tracks: [
        for (final raw in collectionList(dto['tracks']))
          relatedTrack({
            ...collectionObject(raw),
            'recommendationGenerationId': dto['generationId'],
          }),
      ],
      artists: entities('artists', true),
      albums: entities('albums', false),
      degradedSources: collectionList(dto['degradedSources'])
          .map(collectionString),
      nextCursor: next as int?,
      generationId: dto['generationId'] as String?,
    );
  }

  RelatedEntity _entity(Map<String, Object?> row, bool artist) => RelatedEntity(
    id: row[artist ? 'providerId' : 'id'] as String?,
    title: collectionString(row[artist ? 'name' : 'title']),
    provider: row['provider'] as String?,
    artwork: row[artist ? 'image' : 'coverArt'] is String
        ? Uri.tryParse(row[artist ? 'image' : 'coverArt'] as String)
        : null,
    artist: artist,
  );
}

/// /player/related omits native recording tuples: preserve unavailable rows.
Track relatedTrack(Map<String, Object?> row) {
  const fields = TrackFields('/api/player/related');
  final title = fields.string(row['title'], 'title', nonempty: true);
  final artist = fields.string(row['artist'], 'artist', nonempty: true);
  final id = fields.string(row['id'], 'id', nonempty: true);
  final album = row['album'] == null
      ? <String, Object?>{}
      : fields.object(row['album'], 'album');
  if ((row['streamSource'] == 'vk' ||
          row['streamSource'] == 'yandex' ||
          RegExp(r'^(vk|yandex):').hasMatch(id)) &&
      row['musicSourceRecording'] == null) {
    return Track(
      ref: UnavailableTrackRef(id, reason: 'missing_native_recording'),
      title: title,
      artist: artist,
      album: album['title'] as String?,
      artwork: fields.artwork(album['coverArt'], 'album.coverArt'),
      duration: fields.duration(row['duration']),
      unavailableReason: 'missing_native_recording',
    );
  }
  final source = row['streamSource'];
  return fields.buildTrack(
    {
      ...row,
      if (row['inLibrary'] == true) 'source': 'library',
      if (row['inLibrary'] != true &&
          source == null &&
          row['youtubeVideoId'] == null)
        'source': 'unknown',
    },
    title: title,
    artist: artist,
    album: album['title'] as String?,
    cover: fields.artwork(album['coverArt'], 'album.coverArt'),
  );
}
