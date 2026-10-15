import '../../core/model/track.dart';
import '../../core/model/app_failure.dart';
import '../library/library_models.dart';

enum CatalogSource { library, discovery, ytmusic }

enum CatalogEntityKind { artist, album }

enum SearchKind { all, tracks, artists, albums }

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
    Map<String, AppFailure> failures = const {},
    this.localHasMore = false,
    this.discoveryHasMore = false,
    this.localOffset = 0,
    this.discoveryLimit = 50,
    this.alias,
  }) : tracks = List.unmodifiable(tracks),
       artists = List.unmodifiable(artists),
       albums = List.unmodifiable(albums),
       failures = Map.unmodifiable(failures);
  final List<Track> tracks;
  final List<CatalogEntity> artists;
  final List<CatalogEntity> albums;
  final Map<String, AppFailure> failures;
  final bool localHasMore, discoveryHasMore;
  final int localOffset, discoveryLimit;
  final String? alias;
  bool get hasMore => localHasMore || discoveryHasMore;
}

/// A detail's tracks have already passed its endpoint-specific adapter.
final class CatalogDetail {
  CatalogDetail({
    required this.ref,
    Iterable<Track> tracks = const [],
    Iterable<CatalogEntity> albums = const [],
    Iterable<CatalogEntity> similar = const [],
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
       similar = List.unmodifiable(similar);
  final CatalogEntityRef ref;
  final CatalogEntityRef? artist;
  final List<Track> tracks;
  final List<CatalogEntity> albums, similar;
  final String? bio, year;
  final int? total;
  final bool hasMore, continuationLoaded;
  final int nextOffset;
  final int popularTrackCount;
}
