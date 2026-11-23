import '../../core/model/app_failure.dart';
import '../library/library_models.dart';
import '../search/catalog_adapters.dart';
import '../search/catalog_models.dart';
import '../search/catalog_repository.dart';

final class AlbumRepository extends CatalogRepository {
  static final _musicBrainzId = RegExp(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    caseSensitive: false,
  );
  AlbumRepository({
    required super.transport,
    required super.authority,
    required super.fence,
    required super.networkPolicy,
  });
  Future<CatalogDetail> load(CatalogEntityRef ref) async {
    if (ref.kind != CatalogEntityKind.album) {
      throw ArgumentError('Album required');
    }
    final path = switch (ref.source) {
      CatalogSource.library => '/api/library/albums/',
      CatalogSource.discovery => '/api/artists/album/',
      CatalogSource.ytmusic => '/api/ytmusic/album/',
    };
    Map<String, Object?> dto;
    try {
      dto = collectionObject(await get('$path${Uri.encodeComponent(ref.id)}'));
    } on AppFailure catch (e) {
      if (e.statusCode != 404 || ref.source != CatalogSource.library) {
        rethrow;
      }
      // Persisted rgMbid also carries remote/federation identities. Only an
      // exact MusicBrainz UUID may cross into its discovery endpoint.
      final mbid = ref.mbid;
      if (mbid == null || _musicBrainzId.stringMatch(mbid) != mbid) {
        throw const AppFailure(
          code: 'album_unavailable',
          message:
              'Этот альбом пока недоступен. Выберите другой результат поиска.',
          statusCode: 404,
        );
      }
      return load(
        CatalogEntityRef(
          kind: ref.kind,
          source: CatalogSource.discovery,
          id: mbid,
          mbid: mbid,
          name: ref.name,
          artwork: ref.artwork,
        ),
      );
    }
    final provider = ref.source == CatalogSource.ytmusic,
        title = collectionString(dto['title']);
    final artist = provider
        ? <String, Object?>{'name': dto['artist']}
        : objectOrEmpty(dto['artist']);
    final name = textOrNull(artist['name']) ?? ref.subtitle ?? '';
    final image =
        coverUri(dto['coverArt'] ?? dto['coverUrl']) ??
        (provider ? thumbnail(dto['thumbnails']) : null) ??
        ref.artwork;
    final resolved = CatalogEntityRef(
      kind: ref.kind,
      source: ref.source,
      id: ref.id,
      name: title,
      subtitle: name,
      mbid: textOrNull(dto['rgMbid'] ?? dto['mbid']) ?? ref.mbid,
      artwork: image,
    );
    final artistId = textOrNull(
      ref.source == CatalogSource.library ? artist['id'] : artist['mbid'],
    );
    final similar = <CatalogEntity>[];
    for (final raw in listOrEmpty(dto['similarAlbums'])) {
      final row = collectionObject(raw), local = row['owned'] == true;
      final id = textOrNull(local ? row['id'] : row['rgMbid'] ?? row['mbid']);
      if (id == null) continue;
      similar.add(
        CatalogEntity(
          CatalogEntityRef(
            kind: CatalogEntityKind.album,
            source: local ? CatalogSource.library : CatalogSource.discovery,
            id: id,
            name: collectionString(row['title']),
            subtitle: textOrNull(objectOrEmpty(row['artist'])['name']),
            mbid: textOrNull(row['rgMbid'] ?? row['mbid']),
            artwork: coverUri(row['coverArt'] ?? row['coverUrl']),
          ),
        ),
      );
    }
    return CatalogDetail(
      ref: resolved,
      artist: artistId == null
          ? null
          : CatalogEntityRef(
              kind: CatalogEntityKind.artist,
              source: ref.source,
              id: artistId,
              name: name,
              mbid: textOrNull(artist['mbid']),
            ),
      tracks: [
        for (final (i, raw) in listOrEmpty(dto['tracks']).indexed)
          provider
              ? youtubeBrowseTrack(
                  collectionObject(raw),
                  artist: name,
                  album: title,
                  artwork: image,
                  index: i + 1,
                )
              : detailTrack(
                  collectionObject(raw),
                  endpoint: path,
                  artistName: name,
                  albumTitle: title,
                  artwork: image,
                  metadataOnly: ref.source == CatalogSource.discovery,
                ),
      ],
      similar: similar,
      bio: textOrNull(dto['bio'] ?? dto['description']),
      year: dto['year']?.toString(),
    );
  }
}
