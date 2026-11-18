import '../../core/model/track.dart';
import '../../core/model/app_failure.dart';
import '../../core/model/owner_key.dart';
import '../library/library_models.dart';

enum CatalogSource { library, discovery, ytmusic }

enum CatalogEntityKind { artist, album }

enum SearchKind { all, tracks, artists, albums }

/// Ephemeral result ownership; a retry cannot adopt another query or session.
final class SearchPageBinding {
  const SearchPageBinding(this.fence, this.query, this.kind);
  final SessionFence fence;
  final String query;
  final SearchKind kind;
  bool matches(SessionFence owner, String text, SearchKind category) =>
      fence == owner && query == text && kind == category;
}

/// Endpoint provenance for the current page, not a persisted search cache.
final class SearchResultPart {
  SearchResultPart({
    Iterable<Track> tracks = const [],
    Iterable<CatalogEntity> artists = const [],
    Iterable<CatalogEntity> albums = const [],
  }) : tracks = List.unmodifiable(tracks),
       artists = List.unmodifiable(artists),
       albums = List.unmodifiable(albums);
  final List<Track> tracks;
  final List<CatalogEntity> artists, albums;
}

/// A failed raw library window and the successful prefix preceding it.
/// Its partial membership is replaced on recovery, not retained as old likes.
final class SearchLocalRecovery {
  SearchLocalRecovery(this.offset, Map<String, SearchResultPart> prefix)
    : prefix = Map.unmodifiable(prefix);
  final int offset;
  final Map<String, SearchResultPart> prefix;
}

/// Source and opaque ID own navigation. Names are display metadata only.
final class CatalogEntityRef {
  const CatalogEntityRef({
    required this.kind,
    required this.source,
    required this.id,
    required this.name,
    this.mbid,
    this.subtitle,
    this.artwork,
  });
  final CatalogEntityKind kind;
  final CatalogSource source;
  final String id, name;
  final String? mbid, subtitle;
  final Uri? artwork;
  String get identityKey => '${kind.name}:${source.name}:$id';
  SavedEntityRef get saved => SavedEntityRef(
    kind: kind == CatalogEntityKind.artist
        ? SavedEntityKind.artist
        : SavedEntityKind.album,
    source: source == CatalogSource.ytmusic
        ? 'ytmusic'
        : source == CatalogSource.library
        ? 'library'
        : 'discovery',
    entityId: id,
    title: name,
    subtitle: subtitle,
    image: artwork,
  );
}

final class CatalogEntity {
  const CatalogEntity(this.ref, {this.year});
  final CatalogEntityRef ref;
  final String? year;
}

final class SearchPage {
  SearchPage({
    Iterable<Track> tracks = const [],
    Iterable<CatalogEntity> artists = const [],
    Iterable<CatalogEntity> albums = const [],
    Iterable<CatalogEntity> savedArtists = const [],
    Iterable<CatalogEntity> savedAlbums = const [],
    Map<String, AppFailure> failures = const {},
    this.localHasMore = false,
    this.discoveryHasMore = false,
    this.localOffset = 0,
    this.discoveryLimit = 50,
    this.savedArtistsOffset = 0,
    this.savedAlbumsOffset = 0,
    this.savedArtistsHasMore = false,
    this.savedAlbumsHasMore = false,
    this.savedArtistsRefreshPending = false,
    this.savedAlbumsRefreshPending = false,
    this.savedArtistsPartialSeen = false,
    this.savedAlbumsPartialSeen = false,
    this.alias,
    this.binding,
    this.localRecovery,
    Map<String, SearchResultPart> parts = const {},
  }) : tracks = List.unmodifiable(tracks),
       artists = List.unmodifiable(artists),
       albums = List.unmodifiable(albums),
       savedArtists = List.unmodifiable(savedArtists),
       savedAlbums = List.unmodifiable(savedAlbums),
       failures = Map.unmodifiable(failures),
       parts = Map.unmodifiable(parts);
  final List<Track> tracks;
  final List<CatalogEntity> artists;
  final List<CatalogEntity> albums;
  final List<CatalogEntity> savedArtists, savedAlbums;
  final Map<String, AppFailure> failures;
  final bool localHasMore, discoveryHasMore;
  final int localOffset, discoveryLimit;
  final int savedArtistsOffset, savedAlbumsOffset;
  final bool savedArtistsHasMore, savedAlbumsHasMore;

  /// Failed replacement reads must retry from zero without appending stale rows.
  final bool savedArtistsRefreshPending, savedAlbumsRefreshPending;

  /// Omitted raw rows remain disclosed until a successful replacement read.
  final bool savedArtistsPartialSeen, savedAlbumsPartialSeen;
  final String? alias;
  final SearchPageBinding? binding;
  final SearchLocalRecovery? localRecovery;
  final Map<String, SearchResultPart> parts;
  bool get hasMore =>
      localHasMore ||
      discoveryHasMore ||
      savedArtistsHasMore ||
      savedAlbumsHasMore;
  bool get hasUnresolvedTracks =>
      tracks.any((t) => t.unavailableReason == 'missing_provider_track');

  /// Replace private groups while retaining the ordinary search and queue order.
  SearchPage withSaved({
    required Iterable<CatalogEntity> artists,
    required Iterable<CatalogEntity> albums,
    required int artistsOffset,
    required int albumsOffset,
    required bool artistsHasMore,
    required bool albumsHasMore,
    required bool artistsRefreshPending,
    required bool albumsRefreshPending,
    required bool artistsPartialSeen,
    required bool albumsPartialSeen,
    required Map<String, AppFailure> savedFailures,
  }) => SearchPage(
    tracks: tracks,
    artists: this.artists,
    albums: this.albums,
    localOffset: localOffset,
    localHasMore: localHasMore,
    discoveryLimit: discoveryLimit,
    discoveryHasMore: discoveryHasMore,
    alias: alias,
    binding: binding,
    localRecovery: localRecovery,
    parts: parts,
    savedArtists: artists,
    savedAlbums: albums,
    savedArtistsOffset: artistsOffset,
    savedAlbumsOffset: albumsOffset,
    savedArtistsHasMore: artistsHasMore,
    savedAlbumsHasMore: albumsHasMore,
    savedArtistsRefreshPending: artistsRefreshPending,
    savedAlbumsRefreshPending: albumsRefreshPending,
    savedArtistsPartialSeen: artistsPartialSeen,
    savedAlbumsPartialSeen: albumsPartialSeen,
    failures: {
      for (final entry in failures.entries)
        if (!entry.key.startsWith('saved:')) entry.key: entry.value,
      for (final entry in savedFailures.entries)
        if (entry.key.startsWith('saved:')) entry.key: entry.value,
    },
  );
}

/// A detail's tracks have already passed its endpoint-specific adapter.
final class CatalogDetail {
  CatalogDetail({
    required this.ref,
    Iterable<Track> tracks = const [],
    Iterable<CatalogEntity> albums = const [],
    Iterable<CatalogEntity> similar = const [],
    Iterable<CatalogEntity> streamingAlbums = const [],
    this.artist,
    this.bio,
    this.year,
    this.total,
    this.hasMore = false,
    this.nextOffset = 0,
    this.continuationLoaded = false,
    this.popularTrackCount = 0,
  }) : tracks = List.unmodifiable(tracks),
       albums = List.unmodifiable(albums),
       streamingAlbums = List.unmodifiable(streamingAlbums),
       similar = List.unmodifiable(similar);
  final CatalogEntityRef ref;
  final CatalogEntityRef? artist;
  final List<Track> tracks;
  final List<CatalogEntity> albums, similar;

  /// Owner-saved remote releases, separate from locally held/catalog albums.
  final List<CatalogEntity> streamingAlbums;
  final String? bio, year;
  final int? total;
  final bool hasMore, continuationLoaded;
  final int nextOffset;
  final int popularTrackCount;
}
