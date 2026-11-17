import '../../core/mapping/liked_track_mapper.dart';
import '../../core/mapping/search_track_mapper.dart';
import '../../core/model/track.dart';
import '../../core/model/app_failure.dart';
import '../../core/model/track_ref.dart';
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
    final saved = _searchSaved(q, kind, previous: previous);
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
        for (final key in [
          'streamingTracks',
          'streamingPage',
          'streamingUnavailable',
        ])
          if (pages[0]?.containsKey(key) == true) key: pages[0]![key],
      };
    }

    final results = await Future.wait<Object?>([
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
      saved,
    ]);
    await guard();
    final local = results[0] as Map<String, Object?>?,
        discovery = results[1] as Map<String, Object?>?,
        native = results[2] as Map<String, Object?>?,
        savedPage = results[3] as SearchPage;
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

    var personalHasMore = false;
    var personalPageFailed = false;
    if (local != null) {
      if (kind == SearchKind.all || kind == SearchKind.tracks) {
        var partial = local['streamingUnavailable'] == true;
        final hasPersonalFields = [
          'streamingTracks',
          'streamingPage',
          'streamingUnavailable',
        ].any(local.containsKey);
        if (hasPersonalFields) {
          final rows = local['streamingTracks'], page = local['streamingPage'];
          final validPage =
              page is Map &&
              page['offset'] is int &&
              page['offset'] == offset &&
              page['limit'] is int &&
              page['limit'] == 50 &&
              page['hasMore'] is bool;
          personalPageFailed =
              partial ||
              rows is! List ||
              !validPage ||
              (local.containsKey('streamingUnavailable') &&
                  local['streamingUnavailable'] is! bool);
          partial = personalPageFailed;
          if (rows is List && local['streamingUnavailable'] != true) {
            for (final row in rows) {
              try {
                final track = const LikedTrackMapper().map(
                  collectionObject(row),
                );
                if (track.ref is! NativeTrackRef &&
                    track.ref is! YoutubeTrackRef) {
                  partial = true;
                  continue;
                }
                addTrack(track);
              } on AppFailure {
                partial = true;
              }
            }
            // The server filters malformed metadata after its raw take. A
            // short or empty visible page still consumes the requested 50 rows.
            personalHasMore = validPage && page['hasMore'] == true;
          }
        }
        if (partial) {
          failures['liked'] = const AppFailure(
            code: 'partial_search',
            message: 'Часть поиска по любимым трекам недоступна.',
          );
        } else {
          failures.remove('liked');
        }
      }
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
      artists: _browseFirst(artists),
      albums: _browseFirst(albums),
      failures: failures,
      localOffset:
          local == null ||
              personalPageFailed ||
              failures.keys.any((key) => key.startsWith('library:'))
          ? offset
          : offset + 50,
      localHasMore:
          offset < 10000 &&
          (local == null
              ? failures.containsKey('library') &&
                    (previous?.localHasMore ?? false)
              : localCount >= 50 ||
                    personalHasMore ||
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
      // Saved failures belong to their independent streams, not public paging.
      // Replace their old notices only after both private parts have settled.
    ).withSaved(
      artists: savedPage.savedArtists,
      albums: savedPage.savedAlbums,
      artistsOffset: savedPage.savedArtistsOffset,
      albumsOffset: savedPage.savedAlbumsOffset,
      artistsHasMore: savedPage.savedArtistsHasMore,
      albumsHasMore: savedPage.savedAlbumsHasMore,
      artistsRefreshPending: savedPage.savedArtistsRefreshPending,
      albumsRefreshPending: savedPage.savedAlbumsRefreshPending,
      artistsPartialSeen: savedPage.savedArtistsPartialSeen,
      albumsPartialSeen: savedPage.savedAlbumsPartialSeen,
      savedFailures: savedPage.failures,
    );
  }

  /// Recheck collection membership without querying external catalogues again.
  Future<SearchPage> refreshSaved(
    String query,
    SearchKind kind,
    SearchPage previous,
  ) => _searchSaved(query.trim(), kind, previous: previous, refresh: true);

  /// Retry private failed windows without resetting their independent offsets.
  Future<SearchPage> retrySaved(
    String query,
    SearchKind kind,
    SearchPage previous,
  ) => _searchSaved(query.trim(), kind, previous: previous, retry: true);

  Future<SearchPage> _searchSaved(
    String query,
    SearchKind kind, {
    SearchPage? previous,
    bool refresh = false,
    bool retry = false,
  }) async {
    final before = previous ?? SearchPage();
    if (query.isEmpty || kind == SearchKind.tracks) return before;
    final failures = <String, AppFailure>{
      for (final entry in before.failures.entries)
        if (entry.key.startsWith('saved:')) entry.key: entry.value,
    };
    Future<
      ({
        List<CatalogEntity> items,
        int offset,
        bool hasMore,
        bool refreshPending,
        bool partialSeen,
      })
    >
    load(
      CatalogEntityKind entityKind,
      List<CatalogEntity> old,
      int oldOffset,
      bool hadMore,
      bool refreshPending,
      bool partialSeen,
    ) async {
      final key = 'saved:${entityKind.name}';
      if ((kind == SearchKind.artists &&
              entityKind != CatalogEntityKind.artist) ||
          (kind == SearchKind.albums &&
              entityKind != CatalogEntityKind.album) ||
          (retry && !failures.containsKey(key)) ||
          (!refresh &&
              !retry &&
              !refreshPending &&
              previous != null &&
              !hadMore)) {
        return (
          items: old,
          offset: oldOffset,
          hasMore: hadMore,
          refreshPending: refreshPending,
          partialSeen: partialSeen,
        );
      }
      final replace = refresh || refreshPending;
      final offset = replace ? 0 : oldOffset;
      const partial = AppFailure(
        code: 'partial_saved_search',
        message: 'Часть поиска по сохранённым альбомам и исполнителям недоступна. Повторите попытку.',
        retryable: true,
      );
      try {
        final dto = collectionObject(
          await get('/api/library/saved', {
            'type': entityKind.name,
            'q': query,
            'limit': '50',
            'offset': '$offset',
          }),
        );
        final echo = collectionObject(dto['search']);
        if (echo['query'] != query ||
            echo['offset'] is! int ||
            echo['offset'] != offset ||
            echo['limit'] is! int ||
            echo['limit'] != 50) {
          throw partial;
        }
        final rows = collectionList(dto['items']),
            total = collectionCount(dto['total']);
        if (rows.isEmpty && offset < total) {
          failures[key] = partial;
          return (
            items: old,
            offset: oldOffset,
            hasMore: false,
            refreshPending: replace,
            partialSeen: partialSeen,
          );
        }
        if (total > 9007199254740991 ||
            rows.length > 50 ||
            (rows.isNotEmpty && offset + rows.length > total)) {
          throw partial;
        }
        final items = <CatalogEntity>[if (!replace) ...old];
        final identities = items.map((e) => e.ref.identityKey).toSet();
        var malformed = false;
        for (final raw in rows) {
          try {
            final row = collectionObject(raw);
            if (row['entityType'] != entityKind.name) throw partial;
            final source = switch (row['source']) {
              'library' => CatalogSource.library,
              'discovery' => CatalogSource.discovery,
              'ytmusic' => CatalogSource.ytmusic,
              _ => throw partial,
            };
            final id = collectionString(row['entityId']);
            final title = collectionString(row['title']);
            if (id.trim().isEmpty ||
                title.trim().isEmpty ||
                (row['subtitle'] != null && row['subtitle'] is! String) ||
                (row['imageUrl'] != null && row['imageUrl'] is! String)) {
              throw partial;
            }
            final entity = CatalogEntity(
              CatalogEntityRef(
                kind: entityKind,
                source: source,
                id: id,
                name: title,
                subtitle: row['subtitle'] as String?,
                artwork: coverUri(row['imageUrl']),
              ),
            );
            if (identities.add(entity.ref.identityKey)) items.add(entity);
          } on AppFailure {
            malformed = true;
          }
        }
        final next = offset + rows.length;
        final incomplete =
            (!replace && partialSeen) ||
            malformed ||
            (next < total && next > 100000);
        if (incomplete) {
          failures[key] = partial;
        } else {
          failures.remove(key);
        }
        return (
          items: items,
          offset: next,
          hasMore: next < total && next <= 100000,
          refreshPending: false,
          partialSeen: incomplete,
        );
      } catch (_) {
        if (!isCurrent) rethrow;
        failures[key] = partial;
        // A failed request never consumes its raw window or drops good rows.
        return (
          items: old,
          offset: oldOffset,
          hasMore: hadMore,
          refreshPending: replace,
          partialSeen: partialSeen,
        );
      }
    }

    final pages = await Future.wait([
      load(
        CatalogEntityKind.artist,
        before.savedArtists,
        before.savedArtistsOffset,
        before.savedArtistsHasMore,
        before.savedArtistsRefreshPending,
        before.savedArtistsPartialSeen,
      ),
      load(
        CatalogEntityKind.album,
        before.savedAlbums,
        before.savedAlbumsOffset,
        before.savedAlbumsHasMore,
        before.savedAlbumsRefreshPending,
        before.savedAlbumsPartialSeen,
      ),
    ]);
    await guard();
    return before.withSaved(
      artists: pages[0].items,
      albums: pages[1].items,
      artistsOffset: pages[0].offset,
      albumsOffset: pages[1].offset,
      artistsHasMore: pages[0].hasMore,
      albumsHasMore: pages[1].hasMore,
      artistsRefreshPending: pages[0].refreshPending,
      albumsRefreshPending: pages[1].refreshPending,
      artistsPartialSeen: pages[0].partialSeen,
      albumsPartialSeen: pages[1].partialSeen,
      savedFailures: failures,
    );
  }

  // Keep the server's relevance order inside each group. Provider browse IDs
  // lead directly to a music catalogue; names never establish shared identity.
  Iterable<CatalogEntity> _browseFirst(List<CatalogEntity> entities) sync* {
    for (final source in [
      CatalogSource.ytmusic,
      CatalogSource.library,
      CatalogSource.discovery,
    ]) {
      yield* entities.where((entity) => entity.ref.source == source);
    }
  }
}
