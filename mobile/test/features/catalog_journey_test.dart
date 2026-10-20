import 'dart:async';

import 'package:flutter/material.dart' hide SearchController;
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/design_system/theme.dart';
import 'package:soundspan/features/search/search_repository.dart';
import 'package:soundspan/features/search/search_controller.dart';
import 'package:soundspan/features/search/search_screen.dart';
import 'package:soundspan/features/search/catalog_models.dart';
import 'package:soundspan/features/artist/artist_repository.dart';
import 'package:soundspan/features/album/album_repository.dart';
import 'package:soundspan/features/album/album_controller.dart';
import 'package:soundspan/features/album/album_screen.dart';
import 'package:soundspan/features/artist/artist_controller.dart';
import 'package:soundspan/features/artist/artist_screen.dart';
import 'package:soundspan/features/search/catalog_actions.dart';
import 'package:soundspan/core/model/play_context.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/features/library/library_controller.dart';
import 'package:soundspan/features/library/library_models.dart';
import 'package:soundspan/features/library/library_repository.dart';
import 'package:soundspan/features/likes/preference_controller.dart';
import 'package:soundspan/features/search/catalog_detail_controller.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/features/search/catalog_like_all.dart';

import '../support/collection_fixtures.dart';

Map<String, Object?> searchTrack(int i) => {
  'id': 's$i',
  'title': 'Песня $i',
  'duration': 180,
  'source': 'local',
  'album': {
    'id': 'al',
    'title': 'Альбом',
    'artist': {'id': 'ar', 'name': 'Артист'},
  },
};
Map<String, Object?> discoveryTrack(int i) => {
  'type': 'track',
  'id': 'yt:v$i',
  'name': 'Открытие $i',
  'artist': 'Автор',
  'youtubeVideoId': 'v$i',
  'duration': 180,
};
ApiResponse emptyFor(ApiRequest r) => ApiResponse(200, switch (r.path) {
  '/api/search' => {'tracks': [], 'artists': [], 'albums': []},
  '/api/search/discover' => {'results': []},
  _ => {'tracks': [], 'unavailable': []},
});
SearchRepository repository(
  CollectionTransport t,
  CollectionAuthority a, {
  NetworkPolicy policy = const NetworkPolicy.online(),
}) => SearchRepository(
  transport: t,
  authority: a,
  fence: collectionFence,
  networkPolicy: policy,
);

Future<
  ({
    CollectionAuthority authority,
    CollectionTransport transport,
    CatalogDetailController controller,
    PreferenceController preferences,
  })
>
likeHarness(
  WidgetTester tester, {
  CatalogEntityKind kind = CatalogEntityKind.album,
  List<Track>? tracks,
  bool hasMore = false,
  int? total,
  FutureOr<ApiResponse> Function(ApiRequest, SessionFence?)? handler,
  NetworkPolicy policy = const NetworkPolicy.online(),
}) async {
  final authority = CollectionAuthority();
  final transport = CollectionTransport(
    handler ??
        (request, fence) {
          final id = Uri.decodeComponent(request.path.split('/')[4]);
          return preferenceResponse(id, 'thumbs_up');
        },
  );
  final preferences = PreferenceController(
    transport: transport,
    authority: authority,
    fence: collectionFence,
    networkPolicy: policy,
  );
  final repo = AlbumRepository(
    transport: transport,
    authority: authority,
    fence: collectionFence,
    networkPolicy: policy,
  );
  final entity = CatalogEntityRef(
    kind: kind,
    source: CatalogSource.library,
    id: 'original',
    name: 'Музыкальная коллекция',
  );
  final controller = CatalogDetailController(
    repository: repo,
    loadDetail: (ref) async => CatalogDetail(
      ref: ref,
      tracks:
          tracks ??
          [collectionTrack(1), collectionTrack(2), collectionTrack(3)],
      hasMore: hasMore,
      total: total,
    ),
  );
  await tester.pumpWidget(
    MaterialApp(
      theme: SoundspanTheme.dark(),
      home: AlbumScreen(
        controller: controller,
        entity: entity,
        actions: CatalogActions(preferences: preferences),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return (
    authority: authority,
    transport: transport,
    controller: controller,
    preferences: preferences,
  );
}

Future<void> disposeLikeHarness(
  WidgetTester tester,
  ({
    CollectionAuthority authority,
    CollectionTransport transport,
    CatalogDetailController controller,
    PreferenceController preferences,
  })
  scope,
) async {
  await tester.pumpWidget(const SizedBox());
  scope.controller.dispose();
  scope.preferences.dispose();
  await scope.authority.updates.close();
}

Future<void> openLikeReview(WidgetTester tester) async {
  final menu = find.byTooltip('Действия');
  for (
    var attempt = 0;
    attempt < 3 && menu.hitTestable().evaluate().isEmpty;
    attempt++
  ) {
    final scroll = tester
        .state<ScrollableState>(find.byType(Scrollable).first)
        .position;
    final target = menu.evaluate().isEmpty
        ? 0.0
        : scroll.pixels +
              tester.getCenter(menu).dy -
              tester.view.physicalSize.height /
                  tester.view.devicePixelRatio /
                  2;
    scroll.jumpTo(target.clamp(scroll.minScrollExtent, scroll.maxScrollExtent));
    await tester.pumpAndSettle();
  }
  await tester.tap(menu);
  await tester.pumpAndSettle();
  await tester.tap(find.textContaining('Добавить загруженные треки в любимое'));
  await tester.pumpAndSettle();
}

class _CatalogReviewNavigation extends NavigatorObserver {
  final popped = <String?>[];
  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) {
    popped.add(route.settings.name);
  }
}

void main() {
  testWidgets('empty search keeps result controls out of the entry state', (
    tester,
  ) async {
    final authority = CollectionAuthority();
    final controller = SearchController(
      repository: repository(
        CollectionTransport((r, _) => emptyFor(r)),
        authority,
      ),
    );
    await tester.pumpWidget(
      MaterialApp(
        theme: SoundspanTheme.dark(),
        home: SearchScreen(controller: controller),
      ),
    );
    expect(find.byTooltip('Очистить поиск'), findsNothing);
    expect(find.text('Всё'), findsNothing);
    await tester.enterText(find.byType(TextField), 'Музыка');
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pumpAndSettle();
    expect(find.byTooltip('Очистить поиск'), findsOneWidget);
    expect(find.text('Всё'), findsOneWidget);
    await tester.tap(find.byTooltip('Очистить поиск'));
    await tester.pumpAndSettle();
    expect(controller.state.query, isEmpty);
    expect(find.byTooltip('Очистить поиск'), findsNothing);
    expect(find.text('Всё'), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    controller.dispose();
    await authority.updates.close();
  });
  testWidgets(
    'collection like-all 1001 loaded confirms only the reviewed first100 exact refs',
    (tester) async {
      final scope = await likeHarness(
        tester,
        tracks: List.generate(1001, collectionTrack),
        hasMore: true,
        total: 2000,
      );
      await openLikeReview(tester);
      await tester.tap(find.text('Добавить в любимое (100)'));
      await tester.pumpAndSettle();
      expect(scope.transport.requests.length, 100);
      expect(
        scope.transport.requests.first.path,
        '/api/library/tracks/local-0/preference',
      );
      expect(
        scope.transport.requests.last.path,
        '/api/library/tracks/local-99/preference',
      );
      expect(find.text('Добавлено в любимое: 100 из 100.'), findsOneWidget);
      await disposeLikeHarness(tester, scope);
    },
  );
  testWidgets(
    'collection like-all captures explicit selected refs before first await',
    (tester) async {
      final scope = await likeHarness(tester);
      final selected = [collectionTrack(1)];
      final pending = scope.controller.likeLoaded(
        detail: scope.controller.state.detail!,
        expectedRevision: scope.controller.revision,
        preferences: scope.preferences,
        selected: selected,
      );
      selected[0] = collectionTrack(2);
      await pending;
      expect(
        scope.transport.requests.single.path,
        '/api/library/tracks/local-1/preference',
      );
      await disposeLikeHarness(tester, scope);
    },
  );
  testWidgets(
    'collection like-all confirmation dismisses review and starts one batch',
    (tester) async {
      final scope = await likeHarness(tester);
      final screen =
          find.byType(AlbumScreen).evaluate().single.widget as AlbumScreen;
      final nav = GlobalKey<NavigatorState>();
      final observer = _CatalogReviewNavigation();
      await tester.pumpWidget(
        MaterialApp(
          navigatorKey: nav,
          navigatorObservers: [observer],
          theme: SoundspanTheme.dark(),
          home: const Scaffold(body: Text('Начало')),
        ),
      );
      unawaited(
        nav.currentState!.push(
          MaterialPageRoute<void>(
            settings: const RouteSettings(name: 'catalog'),
            builder: (_) => AlbumScreen(
              controller: scope.controller,
              entity: screen.entity,
              actions: screen.actions,
              autoLoad: false,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await openLikeReview(tester);
      final confirm = find.text('Добавить в любимое (3)');
      await tester.tap(confirm);
      expect(confirm.hitTestable(), findsNothing);
      await tester.pumpAndSettle();
      expect(observer.popped.where((name) => name == 'catalog'), isEmpty);
      expect(scope.transport.requests.length, 3);
      await disposeLikeHarness(tester, scope);
    },
  );
  testWidgets(
    'collection like-all user can exclude a loaded exact ref before confirmation',
    (tester) async {
      final scope = await likeHarness(tester);
      await openLikeReview(tester);
      final selected = find.byKey(
        const ValueKey('like-select-library:local-2'),
      );
      await tester.ensureVisible(selected);
      await tester.tap(selected);
      await tester.pump();
      expect(find.text('Выбрано: 2 из 3'), findsOneWidget);
      await tester.tap(find.text('Добавить в любимое (2)'));
      await tester.pumpAndSettle();
      expect(scope.transport.requests.map((r) => r.path), [
        '/api/library/tracks/local-1/preference',
        '/api/library/tracks/local-3/preference',
      ]);
      await disposeLikeHarness(tester, scope);
    },
  );
  testWidgets(
    'collection like-all old primary menu cannot target a changed detail',
    (tester) async {
      final scope = await likeHarness(tester);
      await tester.tap(find.byTooltip('Действия'));
      await tester.pumpAndSettle();
      await scope.controller.open(
        const CatalogEntityRef(
          kind: CatalogEntityKind.album,
          source: CatalogSource.library,
          id: 'changed',
          name: 'Другая коллекция',
        ),
      );
      await tester.tap(
        find.textContaining('Добавить загруженные треки в любимое'),
      );
      await tester.pumpAndSettle();
      expect(find.textContaining('Выбрано:'), findsNothing);
      expect(scope.transport.requests, isEmpty);
      await disposeLikeHarness(tester, scope);
    },
  );
  for (final size in [
    const Size(320, 900),
    const Size(390, 900),
    const Size(430, 900),
    const Size(800, 390),
  ]) {
    testWidgets('collection like-all review geometry $size text2 and Back', (
      tester,
    ) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final scope = await likeHarness(tester);
      final screen =
          find.byType(AlbumScreen).evaluate().single.widget as AlbumScreen;
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: TextScaler.linear(2)),
            child: child!,
          ),
          home: AlbumScreen(
            controller: scope.controller,
            entity: screen.entity,
            actions: screen.actions,
            autoLoad: false,
          ),
        ),
      );
      await tester.pumpAndSettle();
      final menu = find.byTooltip('Действия');
      await tester.ensureVisible(menu);
      await openLikeReview(tester);
      expect(find.text('Выбрано: 3 из 3'), findsOneWidget);
      expect(tester.takeException(), isNull);
      expect(
        tester.getBottomRight(find.text('Добавить в любимое (3)')).dy,
        lessThanOrEqualTo(size.height),
      );
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(scope.transport.requests, isEmpty);
      await disposeLikeHarness(tester, scope);
    });
  }
  for (final kind in CatalogEntityKind.values) {
    testWidgets(
      'collection like-all ${kind.name} reviews exact refs and dedupes unavailable rows',
      (tester) async {
        final native = NativeTrackRef(
          MusicRecording(
            provider: NativeMusicProvider.vk,
            id: '1_2',
            title: 'Запись',
            artists: ['Автор'],
            durationSeconds: 180,
            contentVersion: MusicContentVersion.explicit,
          ),
        );
        final tracks = [
          collectionTrack(1),
          collectionTrack(1),
          collectionTrack(2, playable: false),
          const Track(
            ref: YoutubeTrackRef('video'),
            title: 'Видео',
            artist: 'Автор',
          ),
          Track(ref: native, title: 'Запись', artist: 'Автор'),
        ];
        final scope = await likeHarness(
          tester,
          kind: kind,
          tracks: tracks,
          hasMore: kind == CatalogEntityKind.artist,
          total: kind == CatalogEntityKind.artist ? 1001 : null,
        );
        await openLikeReview(tester);
        expect(scope.transport.requests, isEmpty);
        expect(find.text('Выбрано: 3 из 3'), findsOneWidget);
        expect(find.textContaining('Загружено позиций: 5'), findsOneWidget);
        await tester.tap(find.text('Добавить в любимое (3)'));
        await tester.pumpAndSettle();
        expect(scope.transport.requests.map((r) => r.path), [
          '/api/library/tracks/local-1/preference',
          '/api/library/remote-tracks/yt%3Avideo/preference',
          '/api/library/remote-tracks/vk%3A1_2/preference',
        ]);
        expect(
          scope.transport.requests.every(
            (r) =>
                r.method == ApiMethod.post && r.body?['signal'] == 'thumbs_up',
          ),
          true,
        );
        expect(find.text('Добавлено в любимое: 3 из 3.'), findsOneWidget);
        await disposeLikeHarness(tester, scope);
      },
    );
  }
  testWidgets(
    'collection like-all review cancel makes no mutation; loaded 1001 requires explicit bounded subset',
    (tester) async {
      final scope = await likeHarness(
        tester,
        tracks: List.generate(1001, collectionTrack),
        hasMore: true,
        total: 2000,
      );
      await openLikeReview(tester);
      expect(find.text('Выбрано: 100 из 1001'), findsOneWidget);
      expect(
        find.textContaining('До 100 треков за одно действие'),
        findsOneWidget,
      );
      expect(
        find.textContaining('Остальная коллекция не загружена'),
        findsOneWidget,
      );
      expect(scope.transport.requests, isEmpty);
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(scope.transport.requests, isEmpty);
      await disposeLikeHarness(tester, scope);
    },
  );
  testWidgets(
    'collection like-all reports partial failures and continues distinct selections',
    (tester) async {
      final scope = await likeHarness(
        tester,
        handler: (r, f) {
          final id = r.path.split('/')[4];
          return id == 'local-2'
              ? const ApiResponse(503, {})
              : preferenceResponse(id, 'thumbs_up');
        },
      );
      await openLikeReview(tester);
      await tester.tap(find.text('Добавить в любимое (3)'));
      await tester.pumpAndSettle();
      expect(scope.transport.requests.length, 3);
      expect(
        find.text('Добавлено в любимое: 2 из 3. Не удалось: 1.'),
        findsOneWidget,
      );
      await disposeLikeHarness(tester, scope);
    },
  );
  for (final change in ['entity', 'owner']) {
    testWidgets(
      'collection like-all old review $change cannot start mutations',
      (tester) async {
        final scope = await likeHarness(tester);
        await openLikeReview(tester);
        if (change == 'owner') {
          scope.authority.switchOwner();
          scope.authority.active = collectionFence;
          scope.authority.updates.add(scope.authority.state);
        } else {
          await scope.controller.open(
            const CatalogEntityRef(
              kind: CatalogEntityKind.album,
              source: CatalogSource.library,
              id: 'changed',
              name: 'Другая коллекция',
            ),
          );
        }
        await tester.tap(find.text('Добавить в любимое (3)'));
        await tester.pumpAndSettle();
        expect(scope.transport.requests, isEmpty);
        await disposeLikeHarness(tester, scope);
      },
    );
    testWidgets(
      'collection like-all pending $change stops subsequent writes and late status',
      (tester) async {
        final first = Completer<ApiResponse>();
        final scope = await likeHarness(
          tester,
          handler: (r, f) => first.future,
        );
        await openLikeReview(tester);
        await tester.tap(find.text('Добавить в любимое (3)'));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 300));
        expect(scope.transport.requests.length, 1);
        if (change == 'owner') {
          scope.authority.switchOwner();
        } else {
          await scope.controller.open(
            const CatalogEntityRef(
              kind: CatalogEntityKind.album,
              source: CatalogSource.library,
              id: 'changed',
              name: 'Другая коллекция',
            ),
          );
        }
        first.complete(preferenceResponse('local-1', 'thumbs_up'));
        await tester.pumpAndSettle();
        expect(scope.transport.requests.length, 1);
        expect(find.textContaining('Добавлено в любимое:'), findsNothing);
        await disposeLikeHarness(tester, scope);
      },
    );
  }
  testWidgets(
    'collection like-all explicit offline stays disabled with zero HTTP',
    (tester) async {
      final scope = await likeHarness(
        tester,
        policy: const NetworkPolicy.offline(),
      );
      await tester.tap(find.byTooltip('Действия'));
      await tester.pumpAndSettle();
      expect(find.text('Для изменения нужна сеть.'), findsOneWidget);
      await tester.tap(
        find.textContaining('Добавить загруженные треки в любимое'),
      );
      await tester.pump();
      expect(find.textContaining('Выбрано:'), findsNothing);
      expect(scope.transport.requests, isEmpty);
      await disposeLikeHarness(tester, scope);
    },
  );
  testWidgets(
    'saved entity outside the loaded library page uses exact status before remove',
    (tester) async {
      final a = CollectionAuthority();
      final t = CollectionTransport(
        (r, _) => r.path.endsWith('/status')
            ? const ApiResponse(200, {'saved': true})
            : ApiResponse(200, {
                'id': 'al',
                'title': 'Альбом',
                'artist': {'id': 'ar', 'name': 'Артист'},
                'tracks': [],
              }),
      );
      final c = AlbumController(
        repository: AlbumRepository(
          transport: t,
          authority: a,
          fence: collectionFence,
          networkPolicy: const NetworkPolicy.online(),
        ),
      );
      final library = LibraryController(
        repository: LibraryRepository(
          transport: t,
          authority: a,
          fence: collectionFence,
        ),
      );
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: AlbumScreen(
            controller: c,
            entity: const CatalogEntityRef(
              kind: CatalogEntityKind.album,
              source: CatalogSource.library,
              id: 'al',
              name: 'Альбом',
            ),
            actions: CatalogActions(library: library),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Действия'));
      await tester.pumpAndSettle();
      expect(find.text('Убрать из коллекции'), findsOneWidget);
      expect(
        t.requests
            .where((r) => r.path.endsWith('/status'))
            .single
            .query['entityId'],
        'al',
      );
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      await tester.pumpWidget(const SizedBox());
      c.dispose();
      library.dispose();
      await a.updates.close();
    },
  );
  testWidgets(
    'track sheet reads unknown shared preference before offering unlike',
    (tester) async {
      final a = CollectionAuthority();
      final t = CollectionTransport(
        (r, _) => r.path.contains('preference')
            ? preferenceResponse('local-1', 'thumbs_up')
            : ApiResponse(200, {
                'id': 'al',
                'title': 'Альбом',
                'artist': {'id': 'ar', 'name': 'Артист'},
                'tracks': [likedDto(1)],
              }),
      );
      final c = AlbumController(
        repository: AlbumRepository(
          transport: t,
          authority: a,
          fence: collectionFence,
          networkPolicy: const NetworkPolicy.online(),
        ),
      );
      final preferences = PreferenceController(
        transport: t,
        authority: a,
        fence: collectionFence,
      );
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: AlbumScreen(
            controller: c,
            entity: const CatalogEntityRef(
              kind: CatalogEntityKind.album,
              source: CatalogSource.library,
              id: 'al',
              name: 'Альбом',
            ),
            actions: CatalogActions(preferences: preferences),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final more = find.byTooltip('Действия с треком «Песня 1»');
      await tester.scrollUntilVisible(more, 100);
      await tester.ensureVisible(more);
      await tester.tap(more);
      await tester.pumpAndSettle();
      expect(find.text('Убрать из любимого'), findsOneWidget);
      expect(
        t.requests.where((r) => r.path.contains('preference')).single.method,
        ApiMethod.get,
      );
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      await tester.pumpWidget(const SizedBox());
      c.dispose();
      preferences.dispose();
      await a.updates.close();
    },
  );
  testWidgets(
    'search to exact artist to album to selected real playback request',
    (tester) async {
      final a = CollectionAuthority();
      final t = CollectionTransport((r, _) {
        if (r.path == '/api/search') {
          return ApiResponse(200, {
            'tracks': [],
            'artists': [
              {'id': 'ar', 'name': 'Артист'},
            ],
            'albums': [],
          });
        }
        if (r.path == '/api/library/artists/ar') {
          return ApiResponse(200, {
            'id': 'ar',
            'name': 'Артист',
            'topTracks': [likedDto(1)],
            'albums': [
              {'id': 'al', 'title': 'Альбом', 'owned': true},
            ],
            'similarArtists': [],
          });
        }
        if (r.path == '/api/library/albums/al') {
          return ApiResponse(200, {
            'id': 'al',
            'title': 'Альбом',
            'artist': {'id': 'ar', 'name': 'Артист'},
            'tracks': [likedDto(1), likedDto(2)],
            'similarAlbums': [],
          });
        }
        return emptyFor(r);
      });
      final search = SearchController(repository: repository(t, a));
      final artist = ArtistController(
        repository: ArtistRepository(
          transport: t,
          authority: a,
          fence: collectionFence,
          networkPolicy: const NetworkPolicy.online(),
        ),
      );
      final album = AlbumController(
        repository: AlbumRepository(
          transport: t,
          authority: a,
          fence: collectionFence,
          networkPolicy: const NetworkPolicy.online(),
        ),
      );
      final nav = GlobalKey<NavigatorState>();
      final played = <CollectionPlaybackRequest>[];
      await search.submit('Артист');
      await tester.pumpWidget(
        MaterialApp(
          navigatorKey: nav,
          theme: SoundspanTheme.dark(),
          home: SearchScreen(
            controller: search,
            onOpenArtist: (ref) async {
              await nav.currentState!.push(
                MaterialPageRoute<void>(
                  builder: (_) => ArtistScreen(
                    controller: artist,
                    entity: ref,
                    onOpenAlbum: (ref) async {
                      await nav.currentState!.push(
                        MaterialPageRoute<void>(
                          builder: (_) => AlbumScreen(
                            controller: album,
                            entity: ref,
                            onPlay: played.add,
                          ),
                        ),
                      );
                    },
                  ),
                ),
              );
            },
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('entity-artist:library:ar')));
      await tester.pumpAndSettle();
      final al = find.byKey(const ValueKey('entity-album:library:al'));
      await tester.scrollUntilVisible(al, 150);
      await tester.ensureVisible(al);
      await tester.pumpAndSettle();
      expect(al.hitTestable(), findsOneWidget);
      await tester.tap(al);
      await tester.pumpAndSettle();
      final track = find.byKey(const ValueKey('track-play-library:local-2'));
      await tester.scrollUntilVisible(track, 150);
      await tester.ensureVisible(track);
      await tester.pumpAndSettle();
      expect(track.hitTestable(), findsOneWidget);
      await tester.tap(track);
      await tester.pumpAndSettle();
      expect(played.single.startIndex, 1);
      expect(played.single.context.surface, PlaySurface.album);
      expect(played.single.fence, collectionFence);
      expect(played.single.tracks[1].ref, const LibraryTrackRef('local-2'));
      await tester.pumpWidget(const SizedBox());
      search.dispose();
      artist.dispose();
      album.dispose();
      await a.updates.close();
    },
  );
  test(
    'shared preference capability from a different owner fence is hidden',
    () async {
      final a = CollectionAuthority();
      a.active = SessionFence(owner: collectionOwner, epoch: 2);
      final t = CollectionTransport(
        (r, _) => preferenceResponse('local-1', 'thumbs_up'),
      );
      final preferences = PreferenceController(
        transport: t,
        authority: a,
        fence: a.active!,
      );
      final actions = catalogTrackActions(
        actions: CatalogActions(preferences: preferences),
        track: collectionTrack(1),
        fence: collectionFence,
        run: (action) async {
          await action();
        },
      );
      expect(actions.where((a) => a.id == 'like'), isEmpty);
      expect(t.requests, isEmpty);
      preferences.dispose();
      await a.updates.close();
    },
  );
  test('detail response after owner switch is discarded and offline detail makes zero HTTP', () async {
    final a = CollectionAuthority();
    final pending = Completer<ApiResponse>();
    final t = CollectionTransport((r, _) => pending.future);
    final c = AlbumController(
      repository: AlbumRepository(
        transport: t,
        authority: a,
        fence: collectionFence,
        networkPolicy: const NetworkPolicy.online(),
      ),
    );
    const entity = CatalogEntityRef(
      kind: CatalogEntityKind.album,
      source: CatalogSource.library,
      id: 'al',
      name: 'Альбом',
    );
    final operation = c.open(entity);
    await Future<void>.delayed(Duration.zero);
    a.switchOwner();
    pending.complete(
      ApiResponse(200, {
        'title': 'Секретный альбом',
        'artist': {'name': 'Артист'},
        'tracks': [],
      }),
    );
    await operation;
    expect(c.state.stale, true);
    expect(c.state.detail, isNull);
    c.dispose();
    await a.updates.close();
    final b = CollectionAuthority();
    final off = CollectionTransport((r, _) => emptyFor(r));
    final repo = AlbumRepository(
      transport: off,
      authority: b,
      fence: collectionFence,
      networkPolicy: const NetworkPolicy.offline(),
    );
    await expectLater(repo.load(entity), throwsA(anything));
    expect(off.requests, isEmpty);
    repo.dispose();
    await b.updates.close();
  });
  test('partial all-category continuation retries failed offset without skipping rows', () async {
    final a = CollectionAuthority();
    var fail = true;
    final t = CollectionTransport((r, _) {
      if (r.path == '/api/music-sources/catalog') {
        return const ApiResponse(200, {
          'tracks': [],
          'unavailable': ['vk'],
        });
      }
      if (r.path != '/api/search') return emptyFor(r);
      if (r.query['offset'] == '50' && r.query['type'] == 'artists' && fail) {
        return const ApiResponse(503, {});
      }
      return ApiResponse(200, {
        'tracks': List.generate(
          50,
          (i) => searchTrack(i + int.parse(r.query['offset']!)),
        ),
        'artists': [],
        'albums': [],
      });
    });
    final c = SearchController(repository: repository(t, a));
    await c.submit('Музыка');
    await c.loadMore();
    expect(c.state.page.localOffset, 50);
    expect(c.state.page.failures, contains('native:vk'));
    fail = false;
    await c.loadMore();
    expect(c.state.page.localOffset, 100);
    expect(c.state.page.failures.containsKey('library:artists'), false);
    c.dispose();
    await a.updates.close();
  });
  testWidgets(
    'artist download stays explicit popular subset after continuation and save does not like or download',
    (tester) async {
      final a = CollectionAuthority();
      final t = CollectionTransport((r, _) {
        if (r.path.endsWith('/tracks')) {
          return ApiResponse(200, {
            'tracks': [likedDto(1), likedDto(2)],
            'offset': 0,
            'total': 2,
          });
        }
        if (r.path.endsWith('/status')) {
          return const ApiResponse(200, {'saved': false});
        }
        if (r.method == ApiMethod.put) {
          return const ApiResponse(200, {'saved': true});
        }
        return ApiResponse(200, {
          'id': 'ar',
          'name': 'Артист',
          'topTracks': [likedDto(1)],
          'albums': [],
          'similarArtists': [],
        });
      });
      final c = ArtistController(
        repository: ArtistRepository(
          transport: t,
          authority: a,
          fence: collectionFence,
          networkPolicy: const NetworkPolicy.online(),
        ),
      );
      final library = LibraryController(
        repository: LibraryRepository(
          transport: t,
          authority: a,
          fence: collectionFence,
        ),
      );
      final preferences = PreferenceController(
        transport: t,
        authority: a,
        fence: collectionFence,
      );
      var downloaded = 0;
      const entity = CatalogEntityRef(
        kind: CatalogEntityKind.artist,
        source: CatalogSource.library,
        id: 'ar',
        name: 'Артист',
      );
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: ArtistScreen(
            controller: c,
            entity: entity,
            actions: CatalogActions(
              library: library,
              preferences: preferences,
              download: (tracks, fence) {
                downloaded = tracks.length;
              },
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await c.loadMore();
      await tester.pump();
      await tester.tap(find.byTooltip('Действия'));
      await tester.pumpAndSettle();
      expect(
        find.text('Скачать загруженные популярные треки (1)'),
        findsOneWidget,
      );
      await tester.tap(find.text('Сохранить в коллекцию'));
      await tester.pumpAndSettle();
      expect(downloaded, 0);
      expect(t.requests.where((r) => r.method == ApiMethod.put).length, 1);
      expect(
        t.requests.where((r) => r.method == ApiMethod.put).single.path,
        '/api/library/saved',
      );
      await tester.tap(find.byTooltip('Действия'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Скачать загруженные популярные треки (1)'));
      await tester.pumpAndSettle();
      expect(downloaded, 1);
      expect(t.requests.where((r) => r.path.contains('preference')), isEmpty);
      await tester.pumpWidget(const SizedBox());
      c.dispose();
      library.dispose();
      preferences.dispose();
      await a.updates.close();
    },
  );
  test(
    'all category continuation uses pageable single-type library endpoints',
    () async {
      final a = CollectionAuthority();
      final t = CollectionTransport((r, _) {
        if (r.path != '/api/search') return emptyFor(r);
        final start = r.query['type'] == 'all'
            ? 0
            : int.parse(r.query['offset']!);
        return ApiResponse(200, {
          'tracks': List.generate(50, (i) => searchTrack(start + i)),
          'artists': [],
          'albums': [],
        });
      });
      final c = SearchController(repository: repository(t, a));
      await c.submit('Все');
      await c.loadMore();
      expect(c.state.page.tracks.length, 100);
      expect(
        t.requests
            .where((r) => r.path == '/api/search' && r.query['offset'] == '50')
            .every((r) => r.query['type'] != 'all'),
        true,
      );
      c.dispose();
      await a.updates.close();
    },
  );
  test('native exact versions survive with no YouTube replacement', () async {
    final a = CollectionAuthority();
    final t = CollectionTransport(
      (r, _) => r.path == '/api/music-sources/catalog'
          ? ApiResponse(200, {
              'tracks': [
                for (final version in ['explicit', 'clean'])
                  {
                    'provider': 'vk',
                    'id': version == 'explicit' ? '1_2' : '1_3',
                    'title': 'Песня',
                    'artists': ['Автор'],
                    'duration': 180,
                    'contentVersion': version,
                    'preview': false,
                  },
              ],
              'unavailable': ['yandex'],
            })
          : emptyFor(r),
    );
    final repo = repository(t, a);
    final page = await repo.search('Песня', SearchKind.tracks);
    expect(page.tracks.map((t) => t.ref.identityKey), ['vk:1_2', 'vk:1_3']);
    expect(page.tracks.map((t) => t.explicit), [true, false]);
    expect(page.failures, contains('native:yandex'));
    repo.dispose();
    await a.updates.close();
  });
  test(
    'clear while request pending and category switch invalidate old results',
    () async {
      final a = CollectionAuthority();
      final pending = Completer<ApiResponse>();
      final t = CollectionTransport(
        (r, _) => r.path == '/api/search' && r.query['type'] == 'tracks'
            ? pending.future
            : emptyFor(r),
      );
      final c = SearchController(repository: repository(t, a));
      final old = c.submit('Запрос', kind: SearchKind.tracks);
      await c.setKind(SearchKind.albums);
      c.clear();
      pending.complete(
        ApiResponse(200, {
          'tracks': [searchTrack(1)],
        }),
      );
      await old;
      expect(c.state.query, isEmpty);
      expect(c.state.page.tracks, isEmpty);
      expect(c.state.kind, SearchKind.albums);
      c.dispose();
      await a.updates.close();
    },
  );
  test('artist pages count actual wire rows, collapse repeated popular recording, stop on empty', () async {
    final a = CollectionAuthority();
    final t = CollectionTransport(
      (r, _) => r.path.endsWith('/tracks')
          ? ApiResponse(200, {
              'tracks': int.parse(r.query['offset']!) == 0
                  ? [likedDto(0), likedDto(1)]
                  : [],
              'offset': int.parse(r.query['offset']!),
              'total': 10,
            })
          : ApiResponse(200, {
              'id': 'ar',
              'name': 'Артист',
              'topTracks': [likedDto(0)],
              'albums': [],
              'similarArtists': [],
            }),
    );
    final repo = ArtistRepository(
      transport: t,
      authority: a,
      fence: collectionFence,
      networkPolicy: const NetworkPolicy.online(),
    );
    final c = ArtistController(repository: repo);
    await c.open(
      const CatalogEntityRef(
        kind: CatalogEntityKind.artist,
        source: CatalogSource.library,
        id: 'ar',
        name: 'Артист',
      ),
    );
    await c.loadMore();
    expect(c.state.detail!.tracks.length, 2);
    expect(c.state.detail!.nextOffset, 2);
    await c.loadMore();
    expect(c.state.detail!.hasMore, false);
    expect(c.state.detail!.nextOffset, 2);
    c.dispose();
    await a.updates.close();
  });
  test(
    'selected occurrence and shuffle preserve exact artist/album context',
    () async {
      final a = CollectionAuthority();
      final t = CollectionTransport(
        (r, _) => ApiResponse(200, {
          'id': 'al',
          'title': 'Альбом',
          'artist': {'id': 'ar', 'name': 'Артист'},
          'tracks': [
            likedDto(1),
            {'id': 'lastfm-pending', 'title': 'Ожидание', 'duration': 180},
            likedDto(1),
          ],
          'similarAlbums': [],
        }),
      );
      final c = AlbumController(
        repository: AlbumRepository(
          transport: t,
          authority: a,
          fence: collectionFence,
          networkPolicy: const NetworkPolicy.online(),
        ),
      );
      await c.open(
        const CatalogEntityRef(
          kind: CatalogEntityKind.album,
          source: CatalogSource.library,
          id: 'al',
          name: 'Альбом',
        ),
      );
      final request = c.playbackRequest(2, shuffle: true);
      expect(request.tracks.length, 2);
      expect(request.startIndex, 1);
      expect(request.context.surface, PlaySurface.album);
      expect(request.shuffle, true);
      expect(() => c.playbackRequest(1), throwsArgumentError);
      c.dispose();
      await a.updates.close();
    },
  );
  for (final width in [320.0, 390.0, 430.0, 800.0]) {
    for (final scale in [1.0, 2.0]) {
      testWidgets(
        'album detail layout $width scale $scale, first-track sheet and Back',
        (tester) async {
          tester.view.physicalSize = Size(width, width == 800 ? 390 : 900);
          tester.view.devicePixelRatio = 1;
          addTearDown(tester.view.resetPhysicalSize);
          addTearDown(tester.view.resetDevicePixelRatio);
          final a = CollectionAuthority();
          final t = CollectionTransport(
            (r, _) => ApiResponse(200, {
              'id': 'al',
              'title': 'Очень длинное русское название альбома музыкального коллектива',
              'artist': {'id': 'ar', 'name': 'Очень длинное имя исполнителя'},
              'tracks': [likedDto(1)],
              'similarAlbums': [],
            }),
          );
          final c = AlbumController(
            repository: AlbumRepository(
              transport: t,
              authority: a,
              fence: collectionFence,
              networkPolicy: const NetworkPolicy.online(),
            ),
          );
          const entity = CatalogEntityRef(
            kind: CatalogEntityKind.album,
            source: CatalogSource.library,
            id: 'al',
            name: 'Альбом',
          );
          var queued = 0;
          await tester.pumpWidget(
            MaterialApp(
              theme: SoundspanTheme.dark(),
              builder: (ctx, child) => MediaQuery(
                data: MediaQuery.of(ctx)
                    .copyWith(textScaler: TextScaler.linear(scale)),
                child: child!,
              ),
              home: AlbumScreen(
                controller: c,
                entity: entity,
                onPlay: (_) {},
                actions: CatalogActions(
                  enqueueEnd: (tracks, fence) {
                    queued += tracks.length;
                  },
                ),
              ),
            ),
          );
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull);
          final more = find.byTooltip('Действия с треком «Песня 1»');
          await tester.scrollUntilVisible(
            more,
            200,
            scrollable: find.byType(Scrollable).first,
          );
          await tester.drag(
            find.byType(CustomScrollView).first,
            const Offset(0, -120),
          );
          await tester.pumpAndSettle();
          await tester.tap(more);
          await tester.pumpAndSettle();
          expect(find.text('В конец очереди'), findsOneWidget);
          await tester.binding.handlePopRoute();
          await tester.pumpAndSettle();
          expect(queued, 0);
          expect(find.text('В конец очереди'), findsNothing);
          expect(tester.takeException(), isNull);
          await tester.pumpWidget(const SizedBox());
          c.dispose();
          await a.updates.close();
        },
      );
    }
  }
  testWidgets(
    'old sheet after changed entity and changed owner cannot enqueue',
    (tester) async {
      final a = CollectionAuthority();
      final t = CollectionTransport(
        (r, _) => ApiResponse(200, {
          'id': 'al',
          'title': 'Альбом',
          'artist': {'id': 'ar', 'name': 'Артист'},
          'tracks': [likedDto(1)],
          'similarAlbums': [],
        }),
      );
      final c = AlbumController(
        repository: AlbumRepository(
          transport: t,
          authority: a,
          fence: collectionFence,
          networkPolicy: const NetworkPolicy.online(),
        ),
      );
      const entity = CatalogEntityRef(
        kind: CatalogEntityKind.album,
        source: CatalogSource.library,
        id: 'al',
        name: 'Альбом',
      );
      var queued = 0;
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: AlbumScreen(
            controller: c,
            entity: entity,
            actions: CatalogActions(
              enqueueEnd: (tracks, fence) {
                queued++;
              },
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final more = find.byTooltip('Действия с треком «Песня 1»');
      await tester.scrollUntilVisible(more, 150);
      await tester.tap(more);
      await tester.pumpAndSettle();
      await c.open(
        const CatalogEntityRef(
          kind: CatalogEntityKind.album,
          source: CatalogSource.library,
          id: 'new',
          name: 'Другой',
        ),
      );
      await tester.tap(find.text('В конец очереди'));
      await tester.pumpAndSettle();
      expect(queued, 0);
      await tester.tap(more);
      await tester.pumpAndSettle();
      a.switchOwner();
      a.active = collectionFence;
      a.updates.add(a.state);
      await tester.tap(find.text('В конец очереди'));
      await tester.pumpAndSettle();
      expect(queued, 0);
      await tester.pumpWidget(const SizedBox());
      c.dispose();
      await a.updates.close();
    },
  );
  test('actual nested local wire, discovery name, partial native failure retain local', () async {
    final a = CollectionAuthority();
    final t = CollectionTransport(
      (r, _) => switch (r.path) {
        '/api/search' => ApiResponse(200, {
          'tracks': [searchTrack(1)],
          'artists': [
            {'id': 'a1', 'name': 'Одинаковые'},
            {'id': 'a2', 'name': 'Одинаковые'},
          ],
          'albums': [],
        }),
        '/api/search/discover' => ApiResponse(200, {
          'results': [discoveryTrack(1)],
        }),
        _ => const ApiResponse(503, {}),
      },
    );
    final repo = repository(t, a);
    final page = await repo.search('Музыка', SearchKind.all);
    expect(page.tracks.map((t) => t.title), ['Песня 1', 'Открытие 1']);
    expect(page.tracks.first.ref, const LibraryTrackRef('s1'));
    expect(page.artists.map((a) => a.ref.id), ['a1', 'a2']);
    expect(page.failures.keys, contains('native'));
    expect(t.requests.any((r) => r.path == '/api/music-sources/search'), false);
    repo.dispose();
    await a.updates.close();
  });
  test(
    '50 then 100 discovery prefix and local offset 50, no duplicate prefix',
    () async {
      final a = CollectionAuthority();
      final t = CollectionTransport((r, _) {
        if (r.path == '/api/search') {
          final offset = int.parse(r.query['offset']!);
          return ApiResponse(200, {
            'tracks': List.generate(50, (i) => searchTrack(i + offset)),
            'artists': [],
            'albums': [],
          });
        }
        if (r.path == '/api/search/discover') {
          final n = int.parse(r.query['limit']!);
          return ApiResponse(200, {
            'results': List.generate(n, discoveryTrack),
            'pageInfo': {'canRequestMoreTracks': n < 100},
          });
        }
        return emptyFor(r);
      });
      final c = SearchController(repository: repository(t, a));
      await c.submit('Свет', kind: SearchKind.tracks);
      await c.loadMore();
      expect(c.state.page.tracks.length, 200);
      expect(
        t.requests.where((r) => r.path == '/api/search').last.query['offset'],
        '50',
      );
      expect(
        t.requests
            .where((r) => r.path == '/api/search/discover')
            .last
            .query['limit'],
        '100',
      );
      c.dispose();
      await a.updates.close();
    },
  );
  test('new Cyrillic query wins and clear invalidates pending; revoked owner never revives', () async {
    final a = CollectionAuthority();
    final first = Completer<ApiResponse>();
    final t = CollectionTransport(
      (r, _) => r.path == '/api/search' && r.query['q'] == 'Первый'
          ? first.future
          : emptyFor(r),
    );
    final c = SearchController(repository: repository(t, a));
    final pending = c.submit('Первый');
    await c.submit('Второй');
    first.complete(
      ApiResponse(200, {
        'tracks': [searchTrack(1)],
        'artists': [],
        'albums': [],
      }),
    );
    await pending;
    expect(c.state.query, 'Второй');
    expect(c.state.page.tracks, isEmpty);
    c.clear();
    expect(c.state.query, isEmpty);
    a.switchOwner();
    a.active = collectionFence;
    a.updates.add(a.state);
    expect(c.isCurrent, false);
    c.dispose();
    await a.updates.close();
  });
  test(
    'explicit offline makes zero HTTP; locally restored online still searches',
    () async {
      final a = CollectionAuthority()..restoreLocally();
      final t = CollectionTransport((r, _) => emptyFor(r));
      final off = repository(t, a, policy: const NetworkPolicy.offline());
      await expectLater(off.search('Тест', SearchKind.all), throwsA(anything));
      expect(t.requests, isEmpty);
      off.dispose();
      final online = repository(t, a);
      await online.search('Тест', SearchKind.all);
      expect(t.requests.length, 3);
      online.dispose();
      await a.updates.close();
    },
  );
  test('exact entity source routes and metadata-only discovery tracks stay unavailable', () async {
    final a = CollectionAuthority();
    final t = CollectionTransport(
      (r, _) => ApiResponse(
        200,
        r.path.contains('/album/')
            ? {
                'id': 'mbid',
                'title': 'Альбом',
                'artist': {'name': 'Автор', 'mbid': 'artist-mbid'},
                'tracks': [
                  {
                    'id': 'mb-recording',
                    'title': 'Недоступная',
                    'duration': 180,
                  },
                ],
                'similarAlbums': [],
              }
            : {
                'id': 'ar',
                'name': 'Артист',
                'topTracks': [
                  {'id': 'lastfm-meta', 'title': 'Метаданные', 'duration': 180},
                ],
                'albums': [],
                'similarArtists': [],
              },
      ),
    );
    final artist = ArtistRepository(
      transport: t,
      authority: a,
      fence: collectionFence,
      networkPolicy: const NetworkPolicy.online(),
    );
    final album = AlbumRepository(
      transport: t,
      authority: a,
      fence: collectionFence,
      networkPolicy: const NetworkPolicy.online(),
    );
    final ar = await artist.load(
      const CatalogEntityRef(
        kind: CatalogEntityKind.artist,
        source: CatalogSource.discovery,
        id: 'artist-mbid',
        name: 'Автор',
      ),
    );
    final al = await album.load(
      const CatalogEntityRef(
        kind: CatalogEntityKind.album,
        source: CatalogSource.discovery,
        id: 'mbid',
        name: 'Альбом',
      ),
    );
    expect(ar.tracks.single.playable, false);
    expect(al.tracks.single.playable, false);
    expect(t.requests.map((r) => r.path), [
      '/api/artists/discover/artist-mbid',
      '/api/artists/album/mbid',
    ]);
    artist.dispose();
    album.dispose();
    await a.updates.close();
  });
  testWidgets(
    'search debounce and real journey expose artists, albums and exact track',
    (tester) async {
      final a = CollectionAuthority();
      final t = CollectionTransport(
        (r, _) => r.path == '/api/search'
            ? ApiResponse(200, {
                'tracks': [searchTrack(1)],
                'artists': [
                  {'id': 'ar', 'name': 'Артист'},
                ],
                'albums': [
                  {
                    'id': 'al',
                    'title': 'Альбом',
                    'artist': {'name': 'Артист'},
                  },
                ],
              })
            : emptyFor(r),
      );
      final c = SearchController(repository: repository(t, a));
      final opened = <String>[];
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: SearchScreen(
            controller: c,
            onOpenArtist: (r) => opened.add(r.id),
            onOpenAlbum: (r) => opened.add(r.id),
          ),
        ),
      );
      await tester.enterText(find.byType(TextField), 'Музыка');
      await tester.pump(const Duration(milliseconds: 299));
      expect(t.requests, isEmpty);
      await tester.pump(const Duration(milliseconds: 1));
      await tester.pumpAndSettle();
      expect(find.text('Песня 1'), findsOneWidget);
      expect(find.text('Артисты'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('entity-artist:library:ar')));
      await tester.pump();
      expect(opened, ['ar']);
      await tester.pumpWidget(const SizedBox());
      c.dispose();
      await a.updates.close();
    },
  );
}
