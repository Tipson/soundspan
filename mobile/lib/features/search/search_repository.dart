import '../../core/mapping/search_track_mapper.dart';
import '../../core/model/track.dart';
import '../../core/model/app_failure.dart';
import '../library/library_models.dart';
import 'catalog_adapters.dart';
import 'catalog_models.dart';
import 'catalog_repository.dart';

final class SearchRepository extends CatalogRepository {
  SearchRepository({
    required super.transport,
    required super.authority,
    required super.fence,
    required super.networkPolicy,
  });
  Future<SearchPage> search(
    String query,
    SearchKind kind, {
    SearchPage? previous,
  }) async {
    networkPolicy.requireNetwork();
    await guard();
    final q = query.trim();
    if (q.isEmpty) return SearchPage();
    if (q.length > 500) {
      throw const AppFailure(
        code: 'query_too_long',
        message: 'Введите не более 500 символов.',
      );
    }
    final offset = previous?.localOffset ?? 0,
        limit = (previous?.discoveryLimit ?? 0) + 50;
    final failures = <String, AppFailure>{...?previous?.failures};
    Future<Map<String, Object?>?> part(
      String key,
      Future<Object?> Function() action,
    ) async {
      try {
        final result = collectionObject(await action());
        failures.remove(key);
        return result;
      } catch (e) {
        if (!isCurrent) rethrow;
        failures[key] = collectionFailure(e);
        return null;
      }
    }

    Future<Object?> localPage() async {
      if (kind != SearchKind.all || previous == null) {
        return get('/api/search', {
          'q': q,
          'type': kind.name,
          'limit': '50',
          'offset': '$offset',
          'source': 'all',
        });
      }
      // searchAll ignores offset. Continuations use the three bounded music
      // projections; each response contributes only its requested category.
      final kinds = [SearchKind.tracks, SearchKind.artists, SearchKind.albums];
      final pages = await Future.wait([
        for (final category in kinds)
          part(
            'library:${category.name}',
            () => get('/api/search', {
              'q': q,
              'type': category.name,
              'limit': '50',
              'offset': '$offset',
              'source': 'all',
            }),
          ),
      ]);
      return {
        for (final (i, category) in kinds.indexed)
          category.name: pages[i]?[category.name] ?? [],
      };
    }

    final results = await Future.wait([
      if (previous == null || previous.localHasMore)
        part('library', localPage)
      else
        Future<Map<String, Object?>?>.value(null),
      if (previous == null || previous.discoveryHasMore)
        part(
          'discovery',
          () => get('/api/search/discover', {
            'q': q,
            'type': 'music',
            'scope': kind.name,
            'limit': '${limit.clamp(50, 500)}',
          }),
        )
      else
        Future<Map<String, Object?>?>.value(null),
      if (previous == null &&
          q.length <= 200 &&
          (kind == SearchKind.all || kind == SearchKind.tracks))
        part('native', () => get('/api/music-sources/catalog', {'query': q}))
      else
        Future<Map<String, Object?>?>.value(null),
    ]);
    await guard();
    final local = results[0], discovery = results[1], native = results[2];
    final tracks = <Track>[...?previous?.tracks],
        artists = <CatalogEntity>[...?previous?.artists],
        albums = <CatalogEntity>[...?previous?.albums];
    final trackIds = tracks.map((t) => t.ref.identityKey).toSet(),
        entityIds = {
          ...artists,
          ...albums,
        }.map((e) => e.ref.identityKey).toSet();
    void addTrack(Track t) {
      if (trackIds.add(t.ref.identityKey)) tracks.add(t);
    }

    void addEntity(CatalogEntity e) {
      if (entityIds.add(e.ref.identityKey)) {
        (e.ref.kind == CatalogEntityKind.artist ? artists : albums).add(e);
      }
    }

    if (local != null) {
      for (final row in listOrEmpty(local['tracks'])) {
        addTrack(const LibrarySearchAdapter().map(collectionObject(row)));
      }
      for (final row in listOrEmpty(local['artists'])) {
        addEntity(
          entityFromLibrary(collectionObject(row), CatalogEntityKind.artist),
        );
      }
      for (final row in listOrEmpty(local['albums'])) {
        addEntity(
          entityFromLibrary(collectionObject(row), CatalogEntityKind.album),
        );
      }
    }
    if (discovery != null) {
      for (final raw in listOrEmpty(discovery['results'])) {
        final row = collectionObject(raw);
        switch (row['type']) {
          case 'track':
            addTrack(const SearchTrackMapper().mapDiscovery(row));
          case 'music':
          case 'artist':
          case 'album':
            final isAlbum = row['type'] == 'album',
                provider = row['provider'] == 'ytmusic';
            final id = textOrNull(
              provider
                  ? (isAlbum ? row['browseId'] : row['youtubeChannelId'])
                  : row['mbid'],
            );
            // A name-only Last.fm hit cannot safely identify a same-name artist.
            if (id == null) continue;
            addEntity(
              CatalogEntity(
                CatalogEntityRef(
                  kind: isAlbum
                      ? CatalogEntityKind.album
                      : CatalogEntityKind.artist,
                  source: provider
                      ? CatalogSource.ytmusic
                      : CatalogSource.discovery,
                  id: id,
                  name: collectionString(row['name']),
                  mbid: textOrNull(row['mbid']),
                  subtitle: textOrNull(row['artist']),
                  artwork: coverUri(row['image']),
                ),
                year: row['year']?.toString(),
              ),
            );
        }
      }
      if (discovery['partialFailure'] == true ||
          discovery['externalSearchFailed'] == true) {
        failures['discovery'] = const AppFailure(
          code: 'partial_search',
          message: 'Часть внешнего поиска недоступна.',
        );
      }
    }
    if (native != null) {
      for (final raw in listOrEmpty(native['tracks'])) {
        addTrack(const SearchTrackMapper().mapCatalog(collectionObject(raw)));
      }
      for (final provider in listOrEmpty(native['unavailable'])) {
        failures['native:$provider'] = AppFailure(
          code: 'provider_unavailable',
          message: 'Каталог $provider временно недоступен.',
        );
      }
    }
    final localCount = local == null
        ? 0
        : kind == SearchKind.all
        ? [
            listOrEmpty(local['tracks']).length,
            listOrEmpty(local['artists']).length,
            listOrEmpty(local['albums']).length,
          ].reduce((a, b) => a > b ? a : b)
        : listOrEmpty(local[kind.name]).length;
    final pageInfo = objectOrEmpty(discovery?['pageInfo']);
    return SearchPage(
      tracks: tracks,
      artists: artists,
      albums: albums,
      failures: failures,
      localOffset:
          local == null ||
              failures.keys.any((key) => key.startsWith('library:'))
          ? offset
          : offset + 50,
      localHasMore:
          offset < 10000 &&
          (local == null
              ? failures.containsKey('library') &&
                    (previous?.localHasMore ?? false)
              : localCount >= 50 ||
                    failures.keys.any((key) => key.startsWith('library:'))),
      discoveryLimit: discovery == null
          ? (previous?.discoveryLimit ?? 50)
          : limit,
      discoveryHasMore:
          limit < 500 &&
          (discovery == null
              ? failures.containsKey('discovery') &&
                    (previous?.discoveryHasMore ?? false)
              : pageInfo['canRequestMoreTracks'] == true),
      alias:
          textOrNull(objectOrEmpty(discovery?['aliasInfo'])['canonical']) ??
          previous?.alias,
    );
  }
}
