import '../../core/model/app_failure.dart';
import '../search/catalog_adapters.dart';
import '../search/catalog_models.dart';
import '../search/catalog_repository.dart';
import '../library/library_models.dart';

final class ArtistRepository extends CatalogRepository {
  static final _musicBrainzId = RegExp(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    caseSensitive: false,
  );
  ArtistRepository({
    required super.transport,
    required super.authority,
    required super.fence,
    required super.networkPolicy,
  });
  Future<CatalogDetail> load(CatalogEntityRef ref) async {
    if (ref.kind != CatalogEntityKind.artist) {
      throw ArgumentError('Artist required');
    }
    final path = switch (ref.source) {
      CatalogSource.library => '/api/library/artists/',
      CatalogSource.discovery => '/api/artists/discover/',
      CatalogSource.ytmusic => '/api/ytmusic/artist/',
    };
    Map<String, Object?> dto;
    try {
      dto = collectionObject(await get('$path${Uri.encodeComponent(ref.id)}'));
    } on AppFailure catch (e) {
      if (e.statusCode != 404 || ref.source != CatalogSource.library) {
        rethrow;
      }
      final mbid = ref.mbid;
      if (mbid == null || _musicBrainzId.stringMatch(mbid) != mbid) {
        throw const AppFailure(
          code: 'artist_unavailable',
          message: 'Этот исполнитель пока недоступен. Выберите другой результат поиска.',
          statusCode: 404,
        );
      }
      return load(
        CatalogEntityRef(
          kind: ref.kind,
          source: CatalogSource.discovery,
          id: mbid,
          mbid: ref.mbid,
          name: ref.name,
          artwork: ref.artwork,
        ),
      );
    }
    final provider = ref.source == CatalogSource.ytmusic,
        name = collectionString(dto['name']);
    final image = provider
        ? thumbnail(dto['thumbnails'])
        : coverUri(dto['heroUrl'] ?? dto['coverArt'] ?? dto['image']);
    final resolved = CatalogEntityRef(
      kind: ref.kind,
      source: ref.source,
      id: ref.id,
      name: name,
      mbid: textOrNull(dto['mbid']) ?? ref.mbid,
      artwork: image ?? ref.artwork,
    );
    final albums = <CatalogEntity>[];
    for (final raw in listOrEmpty(dto['albums'])) {
      final row = collectionObject(raw);
      final id = textOrNull(
        provider
            ? row['browseId']
            : row['owned'] == true
            ? row['id']
            : row['rgMbid'] ?? row['mbid'] ?? row['id'],
      );
      if (id == null) continue;
      albums.add(
        CatalogEntity(
          CatalogEntityRef(
            kind: CatalogEntityKind.album,
            source: provider
                ? CatalogSource.ytmusic
                : row['owned'] == true
                ? CatalogSource.library
                : CatalogSource.discovery,
            id: id,
            name: collectionString(row['title']),
            mbid: textOrNull(row['rgMbid'] ?? row['mbid']),
            subtitle: name,
            artwork: provider
                ? thumbnail(row['thumbnails'])
                : coverUri(row['coverArt'] ?? row['coverUrl']),
          ),
          year: row['year']?.toString(),
        ),
      );
    }
    final similar = <CatalogEntity>[];
    final streamingAlbums = <CatalogEntity>[];
    if (ref.source == CatalogSource.library) {
      final seen = <String>{};
      for (final raw in listOrEmpty(dto['streamingAlbums'])) {
        final row = collectionObject(raw);
        final id = textOrNull(row['id']);
        final originalIdentity = textOrNull(row['rgMbid']);
        if (row['owned'] != false ||
            row['source'] != 'youtube' ||
            row['streamSource'] != 'youtube' ||
            id == null ||
            originalIdentity == null ||
            !seen.add(id)) {
          continue;
        }
        streamingAlbums.add(
          CatalogEntity(
            CatalogEntityRef(
              kind: CatalogEntityKind.album,
              source: CatalogSource.library,
              id: id,
              name: collectionString(row['title']),
              // Remote playback keeps its original lookup. A canonical UUID
              // must not grant discovery fallback after this album vanishes.
              mbid: originalIdentity.startsWith('remote:')
                  ? originalIdentity
                  : null,
              subtitle: name,
              artwork: coverUri(row['coverArt'] ?? row['coverUrl']),
            ),
            year: row['year']?.toString(),
          ),
        );
      }
    }
    for (final raw in listOrEmpty(dto['similarArtists'])) {
      final row = collectionObject(raw), local = row['inLibrary'] == true;
      final id = textOrNull(local ? row['id'] : row['mbid']);
      if (id == null) continue;
      similar.add(
        CatalogEntity(
          CatalogEntityRef(
            kind: CatalogEntityKind.artist,
            source: local ? CatalogSource.library : CatalogSource.discovery,
            id: id,
            name: collectionString(row['name']),
            mbid: textOrNull(row['mbid']),
            artwork: coverUri(row['coverArt'] ?? row['image']),
          ),
        ),
      );
    }
    final rows = listOrEmpty(provider ? dto['songs'] : dto['topTracks']);
    return CatalogDetail(
      ref: resolved,
      popularTrackCount: rows.length,
      tracks: [
        for (final (i, raw) in rows.indexed)
          provider
              ? youtubeBrowseTrack(
                  collectionObject(raw),
                  artist: name,
                  album: '',
                  artwork: image,
                  index: i,
                )
              : detailTrack(
                  collectionObject(raw),
                  endpoint: path,
                  artistName: name,
                  artwork: image,
                  metadataOnly: ref.source == CatalogSource.discovery,
                ),
      ],
      albums: albums,
      streamingAlbums: streamingAlbums,
      similar: similar,
      bio: textOrNull(dto['bio'] ?? dto['summary'] ?? dto['description']),
      hasMore: ref.source == CatalogSource.library,
    );
  }

  /// Explicit continuation only; no background crawl of an artist's discography.
  Future<CatalogDetail> more(CatalogDetail detail) async {
    if (detail.ref.source != CatalogSource.library || !detail.hasMore) {
      return detail;
    }
    final dto = collectionObject(
      await get(
        '/api/library/artists/${Uri.encodeComponent(detail.ref.id)}/tracks',
        {'limit': '50', 'offset': '${detail.nextOffset}'},
      ),
    );
    final rows = collectionList(dto['tracks']),
        total = collectionCount(dto['total']),
        offset = collectionCount(dto['offset']);
    if (offset != detail.nextOffset || rows.length > 50) {
      throw const AppFailure(
        code: 'invalid_page',
        message: 'Сервер вернул неверную страницу треков.',
      );
    }
    final seen = <String>{};
    final next = offset + rows.length;
    return CatalogDetail(
      ref: detail.ref,
      popularTrackCount: detail.popularTrackCount,
      tracks: [
        ...detail.tracks,
        for (final row in rows)
          detailTrack(
            collectionObject(row),
            endpoint: '/api/library/artists/:id/tracks',
            artistName: detail.ref.name,
          ),
      ].where((t) => seen.add(t.ref.identityKey)),
      albums: detail.albums,
      streamingAlbums: detail.streamingAlbums,
      similar: detail.similar,
      bio: detail.bio,
      total: total,
      hasMore: rows.isNotEmpty && next < total && next <= 100000,
      nextOffset: next,
      continuationLoaded: true,
    );
  }
}
