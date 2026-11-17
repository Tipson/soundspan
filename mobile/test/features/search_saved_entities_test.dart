import 'dart:async';

import 'package:flutter/material.dart' hide SearchController;
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/design_system/theme.dart';
import 'package:soundspan/features/search/catalog_models.dart';
import 'package:soundspan/features/search/search_controller.dart';
import 'package:soundspan/features/search/search_repository.dart';
import 'package:soundspan/features/search/search_screen.dart';

import '../support/collection_fixtures.dart';

Map<String, Object?> savedRow(
  String type,
  String id, {
  String source = 'ytmusic',
}) => {
  'entityType': type,
  'source': source,
  'entityId': id,
  'title': 'Сохранено $id',
  'subtitle': 'Исполнитель',
};

ApiResponse savedResponse(
  ApiRequest request,
  List<Object?> items, {
  int? total,
}) => ApiResponse(200, {
  'items': items,
  'total': total ?? items.length,
  'search': {
    'query': request.query['q'],
    'offset': int.parse(request.query['offset']!),
    'limit': 50,
  },
});

SearchRepository savedRepository(
  CollectionTransport transport,
  CollectionAuthority authority,
) => SearchRepository(
  transport: transport,
  authority: authority,
  fence: authority.requireFence(),
  networkPolicy: const NetworkPolicy.online(),
);

SearchRepository trackedRepository(
  CollectionTransport transport,
  CollectionAuthority authority,
) {
  final repository = savedRepository(transport, authority);
  addTearDown(() async {
    repository.dispose();
    await authority.updates.close();
  });
  return repository;
}

Map<String, Object?> publicTrack() => {
  'id': 'public-track',
  'title': 'Обычный трек',
  'duration': 180,
  'album': {
    'id': 'album',
    'title': 'Альбом',
    'artist': {'id': 'artist', 'name': 'Артист'},
  },
};

void main() {
  for (final kind in SearchKind.values) {
    test(
      '$kind requests only its typed saved streams with trimmed literal query',
      () async {
        final transport = CollectionTransport(
          (r, _) => r.path == '/api/library/saved'
              ? savedResponse(r, [])
              : const ApiResponse(200, {}),
        );
        final repo = trackedRepository(transport, CollectionAuthority());
        await repo.search('  %_\\Артист  ', kind);
        final requests = transport.requests
            .where((r) => r.path == '/api/library/saved')
            .toList();
        expect(requests.map((r) => r.query['type']), switch (kind) {
          SearchKind.all => ['artist', 'album'],
          SearchKind.artists => ['artist'],
          SearchKind.albums => ['album'],
          SearchKind.tracks => <String>[],
        });
        for (final request in requests) {
          expect(request.method, ApiMethod.get);
          expect(request.query, {
            'type': request.query['type'],
            'q': '%_\\Артист',
            'limit': '50',
            'offset': '0',
          });
        }
      },
    );
  }

  for (final bad in <Map<String, Object?> Function(ApiRequest)>[
    (r) => {},
    (r) => {'query': 'Другой', 'offset': 0, 'limit': 50},
    (r) => {'query': r.query['q'], 'offset': 50, 'limit': 50},
    (r) => {'query': r.query['q'], 'offset': 0, 'limit': 100},
    (r) => {'query': r.query['q'], 'offset': '0', 'limit': 50},
  ]) {
    test(
      'missing or mismatched search echo never admits unfiltered saved rows',
      () async {
        final transport = CollectionTransport(
          (r, _) => ApiResponse(
            200,
            r.path == '/api/library/saved'
                ? {
                    'items': [savedRow('artist', 'unfiltered')],
                    'total': 1,
                    'search': bad(r),
                  }
                : {
                    'tracks': [publicTrack()],
                  },
          ),
        );
        final page = await trackedRepository(
          transport,
          CollectionAuthority(),
        ).search('Другой запрос', SearchKind.artists);
        expect(page.savedArtists, isEmpty);
        expect(page.failures.keys, ['saved:artist']);
        expect(page.savedArtistsOffset, 0);
        expect(page.tracks.single.ref, const LibraryTrackRef('public-track'));
      },
    );
  }

  test('legacy API without echo preserves ordinary groups and shows private notice', () async {
    final transport = CollectionTransport(
      (r, _) => ApiResponse(
        200,
        r.path == '/api/library/saved'
            ? {
                'items': [savedRow('album', 'unfiltered')],
                'total': 1,
              }
            : {
                'albums': [
                  {'id': 'public-album', 'title': 'Обычный альбом'},
                ],
              },
      ),
    );
    final page = await trackedRepository(
      transport,
      CollectionAuthority(),
    ).search('Альбом', SearchKind.albums);
    expect(page.savedAlbums, isEmpty);
    expect(page.albums.single.ref.id, 'public-album');
    expect(page.failures.keys, ['saved:album']);
  });

  for (final total in <Object?>[-1, 1.5, '1', 9007199254740992]) {
    test(
      'invalid total $total cannot authorize saved results or paging',
      () async {
        final transport = CollectionTransport(
          (r, _) => r.path == '/api/library/saved'
              ? ApiResponse(200, {
                  ...savedResponse(r, [savedRow('artist', 'unsafe')]).data
                      as Map,
                  'total': total,
                })
              : const ApiResponse(200, {}),
        );
        final page = await trackedRepository(
          transport,
          CollectionAuthority(),
        ).search('Артист', SearchKind.artists);
        expect(page.savedArtists, isEmpty);
        expect(page.savedArtistsHasMore, false);
        expect(page.failures.keys, ['saved:artist']);
      },
    );
  }

  test('malformed and unknown-source rows stay partial without creating local identity', () async {
    final transport = CollectionTransport(
      (r, _) => r.path == '/api/library/saved'
          ? savedResponse(r, [
              17,
              savedRow('album', 'wrong-kind'),
              savedRow('artist', 'other', source: 'spotify'),
              {...savedRow('artist', 'invalid'), 'subtitle': 12},
              savedRow('artist', 'same', source: 'library'),
              savedRow('artist', 'same', source: 'discovery'),
              savedRow('artist', 'same'),
              savedRow('artist', 'same'),
            ])
          : const ApiResponse(200, {}),
    );
    final page = await trackedRepository(
      transport,
      CollectionAuthority(),
    ).search('Артист', SearchKind.artists);
    expect(page.savedArtists.map((e) => e.ref.identityKey), [
      'artist:library:same',
      'artist:discovery:same',
      'artist:ytmusic:same',
    ]);
    expect(page.savedArtists.map((e) => e.ref.saved.identityKey), [
      'artist:library:same',
      'artist:discovery:same',
      'artist:ytmusic:same',
    ]);
    expect(page.savedArtistsOffset, 8);
    expect(page.failures.keys, ['saved:artist']);
    expect(page.artists, isEmpty);
  });

  test(
    'All uses independent raw counters and consumes fifty invalid artist rows',
    () async {
      final transport = CollectionTransport((r, _) {
        if (r.path != '/api/library/saved') return const ApiResponse(200, {});
        final artist = r.query['type'] == 'artist',
            offset = int.parse(r.query['offset']!);
        return artist
            ? savedResponse(
                r,
                offset == 0
                    ? List.filled(
                        50,
                        savedRow('artist', 'unknown', source: 'future'),
                      )
                    : [savedRow('artist', 'page2')],
                total: 51,
              )
            : savedResponse(r, [savedRow('album', 'only')]);
      });
      final repo = trackedRepository(transport, CollectionAuthority());
      final first = await repo.search('Музыка', SearchKind.all);
      expect(first.savedArtists, isEmpty);
      expect(first.savedArtistsOffset, 50);
      expect(first.savedAlbumsOffset, 1);
      expect(first.savedArtistsHasMore, true);
      expect(first.savedAlbumsHasMore, false);
      expect(first.hasMore, true);
      final second = await repo.search(
        'Музыка',
        SearchKind.all,
        previous: first,
      );
      expect(second.savedArtists.single.ref.id, 'page2');
      expect(second.savedAlbums.single.ref.id, 'only');
      expect(second.hasMore, false);
      expect(
        transport.requests
            .where((r) => r.path == '/api/library/saved')
            .map((r) => '${r.query['type']}:${r.query['offset']}'),
        ['artist:0', 'album:0', 'artist:50'],
      );
    },
  );

  test('failed saved continuation retries same raw window and retains previous groups', () async {
    var fail = true;
    final transport = CollectionTransport((r, _) {
      if (r.path != '/api/library/saved') return const ApiResponse(200, {});
      final offset = int.parse(r.query['offset']!);
      if (offset == 50 && fail) return const ApiResponse(503, {});
      return savedResponse(
        r,
        offset == 0
            ? List.generate(50, (i) => savedRow('album', '$i'))
            : [savedRow('album', '50')],
        total: 51,
      );
    });
    final repo = trackedRepository(transport, CollectionAuthority());
    final first = await repo.search('Альбом', SearchKind.albums);
    final failed = await repo.search(
      'Альбом',
      SearchKind.albums,
      previous: first,
    );
    expect(failed.savedAlbums, hasLength(50));
    expect(failed.savedAlbumsOffset, 50);
    expect(failed.savedAlbumsHasMore, true);
    expect(failed.failures.keys, ['saved:album']);
    fail = false;
    final retry = await repo.search(
      'Альбом',
      SearchKind.albums,
      previous: failed,
    );
    expect(retry.savedAlbums, hasLength(51));
    expect(retry.savedAlbumsOffset, 51);
    expect(retry.failures, isEmpty);
    expect(
      transport.requests
          .where((r) => r.path == '/api/library/saved')
          .map((r) => r.query['offset']),
      ['0', '50', '50'],
    );
  });

  for (final type in ['artist', 'album']) {
    test(
      'failed $type refresh retries zero and replaces stale saved membership only',
      () async {
        var phase = 'initial';
        final authority = CollectionAuthority();
        final transport = CollectionTransport((r, _) {
          if (r.path != '/api/library/saved') {
            return ApiResponse(
              200,
              r.path == '/api/search'
                  ? {
                      'tracks': [publicTrack()],
                      'artists': [
                        {'id': 'ordinary', 'name': 'Обычный исполнитель'},
                      ],
                    }
                  : {},
            );
          }
          final target = r.query['type'] == type;
          if (phase == 'failed' && target) return const ApiResponse(503, {});
          return savedResponse(
            r,
            phase == 'initial'
                ? target
                      ? List.generate(50, (i) => savedRow(type, '$i'))
                      : [savedRow(r.query['type']!, 'other')]
                : target
                ? [savedRow(type, 'kept')]
                : [],
          );
        });
        final controller = SearchController(
          repository: savedRepository(transport, authority),
        );
        addTearDown(() async {
          controller.dispose();
          await authority.updates.close();
        });
        await controller.submit('Музыка');
        final ordinary = controller.state.page.artists.single,
            track = controller.state.page.tracks.single;
        final publicCalls = transport.requests
            .where((r) => r.path != '/api/library/saved')
            .length;
        phase = 'failed';
        await controller.refreshSaved();
        expect(
          type == 'artist'
              ? controller.state.page.savedArtists
              : controller.state.page.savedAlbums,
          hasLength(50),
        );
        expect(controller.state.page.failures.keys, ['saved:$type']);
        phase = 'recovered';
        await controller.retrySaved();
        final rows = type == 'artist'
            ? controller.state.page.savedArtists
            : controller.state.page.savedAlbums;
        expect(rows.map((e) => e.ref.id), ['kept']);
        expect(controller.state.page.failures, isEmpty);
        expect(controller.state.page.artists.single, same(ordinary));
        expect(controller.state.page.tracks.single, same(track));
        expect(
          transport.requests
              .where((r) => r.path != '/api/library/saved')
              .length,
          publicCalls,
        );
        expect(
          transport.requests
              .where(
                (r) =>
                    r.path == '/api/library/saved' && r.query['type'] == type,
              )
              .map((r) => r.query['offset']),
          ['0', '0', '0'],
        );
        expect(
          transport.requests.where(
            (r) => r.path == '/api/library/saved' && r.query['type'] != type,
          ),
          hasLength(2),
        );
      },
    );

    test(
      '$type filtered-page notice survives a valid continuation until full refresh',
      () async {
        var refresh = false;
        final transport = CollectionTransport((r, _) {
          if (r.path != '/api/library/saved') return const ApiResponse(200, {});
          return savedResponse(
            r,
            refresh
                ? [
                    savedRow(type, 'first'),
                    savedRow(type, 'fixed'),
                    savedRow(type, 'last'),
                  ]
                : r.query['offset'] == '0'
                ? [
                    savedRow(type, 'first'),
                    savedRow(type, 'fixed', source: 'future'),
                  ]
                : [savedRow(type, 'last')],
            total: 3,
          );
        });
        final repo = trackedRepository(transport, CollectionAuthority());
        final kind = type == 'artist' ? SearchKind.artists : SearchKind.albums;
        final first = await repo.search('Музыка', kind);
        final last = await repo.search('Музыка', kind, previous: first);
        expect(
          type == 'artist' ? last.savedArtists : last.savedAlbums,
          hasLength(2),
        );
        expect(last.hasMore, false);
        expect(last.failures.keys, ['saved:$type']);
        refresh = true;
        final complete = await repo.refreshSaved('Музыка', kind, last);
        expect(
          type == 'artist' ? complete.savedArtists : complete.savedAlbums,
          hasLength(3),
        );
        expect(complete.failures, isEmpty);
      },
    );
  }

  test('saved offset ceiling reports partial instead of silently claiming completion', () async {
    final transport = CollectionTransport(
      (r, _) => r.path == '/api/library/saved'
          ? savedResponse(
              r,
              List.generate(50, (i) => savedRow('artist', '$i')),
              total: 100051,
            )
          : const ApiResponse(200, {}),
    );
    final repo = trackedRepository(transport, CollectionAuthority());
    final page = await repo.search(
      'Музыка',
      SearchKind.artists,
      previous: SearchPage(
        savedArtistsOffset: 100000,
        savedArtistsHasMore: true,
      ),
    );
    expect(page.savedArtists, hasLength(50));
    expect(page.savedArtistsHasMore, false);
    expect(page.failures.keys, ['saved:artist']);
  });

  test(
    'empty raw continuation with more total stops paging and reports partial',
    () async {
      final transport = CollectionTransport(
        (r, _) => r.path == '/api/library/saved'
            ? savedResponse(
                r,
                r.query['offset'] == '0'
                    ? List.generate(50, (i) => savedRow('artist', '$i'))
                    : [],
                total: 100,
              )
            : const ApiResponse(200, {}),
      );
      final repo = trackedRepository(transport, CollectionAuthority());
      final first = await repo.search('Артист', SearchKind.artists);
      final empty = await repo.search(
        'Артист',
        SearchKind.artists,
        previous: first,
      );
      expect(empty.savedArtists, hasLength(50));
      expect(empty.savedArtistsOffset, 50);
      expect(empty.savedArtistsHasMore, false);
      expect(empty.hasMore, false);
      expect(empty.failures.keys, ['saved:artist']);
    },
  );

  test(
    'late owner A response cannot replace same-query owner B saved results',
    () async {
      final authority = CollectionAuthority(),
          pending = Completer<ApiResponse>(),
          admitted = Completer<ApiRequest>();
      final transport = CollectionTransport((r, fence) {
        if (r.path != '/api/library/saved') return const ApiResponse(200, {});
        if (fence!.owner.userId == 'a') {
          admitted.complete(r);
          return pending.future;
        }
        return savedResponse(r, [savedRow('artist', 'owner-b')]);
      });
      final repoA = savedRepository(transport, authority);
      final controllerA = SearchController(repository: repoA);
      final first = controllerA.submit('Одинаково', kind: SearchKind.artists);
      final request = await admitted.future;
      authority.switchOwner();
      final controllerB = SearchController(
        repository: savedRepository(transport, authority),
      );
      await controllerB.submit('Одинаково', kind: SearchKind.artists);
      pending.complete(savedResponse(request, [savedRow('artist', 'owner-a')]));
      await first;
      expect(controllerA.state.stale, true);
      expect(controllerA.state.page.savedArtists, isEmpty);
      expect(controllerB.state.page.savedArtists.single.ref.id, 'owner-b');
      controllerA.dispose();
      controllerB.dispose();
      await authority.updates.close();
    },
  );

  test(
    'late saved query cannot replace current query or cleared results',
    () async {
      final authority = CollectionAuthority(),
          pending = Completer<ApiResponse>(),
          admitted = Completer<ApiRequest>();
      final transport = CollectionTransport((r, _) {
        if (r.path != '/api/library/saved') return const ApiResponse(200, {});
        if (r.query['q'] == 'Первая') {
          admitted.complete(r);
          return pending.future;
        }
        return savedResponse(r, [savedRow('album', 'current')]);
      });
      final controller = SearchController(
        repository: savedRepository(transport, authority),
      );
      addTearDown(() async {
        controller.dispose();
        await authority.updates.close();
      });
      final first = controller.submit('Первая', kind: SearchKind.albums);
      final request = await admitted.future;
      await controller.submit('Вторая', kind: SearchKind.albums);
      pending.complete(savedResponse(request, [savedRow('album', 'old')]));
      await first;
      expect(controller.state.page.savedAlbums.single.ref.id, 'current');
      controller.clear();
      expect(controller.state.page.savedAlbums, isEmpty);
    },
  );

  testWidgets(
    'saved artists remain searchable when public providers return503',
    (tester) async {
      final authority = CollectionAuthority();
      final transport = CollectionTransport(
        (request, _) => request.path == '/api/library/saved'
            ? savedResponse(
                request,
                request.query['type'] == 'artist'
                    ? [savedRow('artist', 'UCexact')]
                    : [],
              )
            : const ApiResponse(503, {}),
      );
      final controller = SearchController(
        repository: savedRepository(transport, authority),
      );
      addTearDown(() async {
        controller.dispose();
        await authority.updates.close();
      });
      await controller.submit('  Артист  ');
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: SearchScreen(controller: controller),
        ),
      );
      expect(find.text('Сохранённые исполнители'), findsOneWidget);
      expect(find.text('Сохранено UCexact'), findsOneWidget);
      expect(find.textContaining('Ничего не найдено'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('private loading is visible until saved-only results settle', (
    tester,
  ) async {
    final authority = CollectionAuthority(),
        pending = Completer<ApiResponse>(),
        admitted = Completer<ApiRequest>();
    final transport = CollectionTransport((r, _) {
      if (r.path == '/api/library/saved') {
        admitted.complete(r);
        return pending.future;
      }
      return const ApiResponse(200, {});
    });
    final controller = SearchController(
      repository: savedRepository(transport, authority),
    );
    addTearDown(() async {
      controller.dispose();
      await authority.updates.close();
    });
    final result = controller.submit('Альбом', kind: SearchKind.albums);
    final request = await admitted.future;
    await tester.pumpWidget(
      MaterialApp(
        theme: SoundspanTheme.dark(),
        home: SearchScreen(controller: controller),
      ),
    );
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(find.textContaining('Ничего не найдено'), findsNothing);
    pending.complete(
      savedResponse(request, [savedRow('album', 'private-only')]),
    );
    await result;
    await tester.pumpAndSettle();
    expect(find.text('Сохранённые альбомы'), findsOneWidget);
    expect(find.text('Сохранено private-only'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(find.textContaining('Ничего не найдено'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'private-only continuation works after fifty unsupported raw rows',
    (tester) async {
      final authority = CollectionAuthority();
      final transport = CollectionTransport(
        (r, _) => r.path == '/api/library/saved'
            ? savedResponse(
                r,
                r.query['offset'] == '0'
                    ? List.filled(
                        50,
                        savedRow('artist', 'future', source: 'future'),
                      )
                    : [savedRow('artist', 'next')],
                total: 51,
              )
            : const ApiResponse(200, {}),
      );
      final controller = SearchController(
        repository: savedRepository(transport, authority),
      );
      addTearDown(() async {
        controller.dispose();
        await authority.updates.close();
      });
      await controller.submit('Артист', kind: SearchKind.artists);
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: SearchScreen(controller: controller),
        ),
      );
      expect(find.text('Показать ещё'), findsOneWidget);
      await tester.tap(find.text('Показать ещё'));
      await tester.pumpAndSettle();
      expect(find.text('Сохранено next'), findsOneWidget);
      expect(find.text('Показать ещё'), findsNothing);
      expect(find.textContaining('Ничего не найдено'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'private retry button retries failed raw page without public refetch',
    (tester) async {
      var fail = true;
      final authority = CollectionAuthority();
      final transport = CollectionTransport((r, _) {
        if (r.path != '/api/library/saved') return const ApiResponse(200, {});
        final offset = int.parse(r.query['offset']!);
        if (offset == 50 && fail) return const ApiResponse(503, {});
        return savedResponse(
          r,
          offset == 0
              ? List.generate(50, (i) => savedRow('artist', '$i'))
              : [savedRow('artist', '50')],
          total: 51,
        );
      });
      final controller = SearchController(
        repository: savedRepository(transport, authority),
      );
      addTearDown(() async {
        controller.dispose();
        await authority.updates.close();
      });
      await controller.submit('Артист', kind: SearchKind.artists);
      await controller.loadMore();
      final publicCalls = transport.requests
          .where((r) => r.path != '/api/library/saved')
          .length;
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: SearchScreen(controller: controller),
        ),
      );
      fail = false;
      await tester.tap(find.text('Повторить поиск'));
      await tester.pumpAndSettle();
      expect(controller.state.page.savedArtists, hasLength(51));
      expect(controller.state.page.failures, isEmpty);
      expect(
        transport.requests
            .where((r) => r.path == '/api/library/saved')
            .map((r) => r.query['offset']),
        ['0', '50', '50'],
      );
      expect(
        transport.requests.where((r) => r.path != '/api/library/saved').length,
        publicCalls,
      );
      await tester.pumpWidget(const SizedBox());
    },
  );

  for (final type in ['artist', 'album']) {
    for (final source in ['library', 'discovery', 'ytmusic']) {
      testWidgets(
        'saved $type/$source route preserves opaque identity with large text',
        (tester) async {
          tester.view.physicalSize = const Size(320, 1100);
          tester.view.devicePixelRatio = 1;
          addTearDown(tester.view.resetPhysicalSize);
          addTearDown(tester.view.resetDevicePixelRatio);
          CatalogEntityRef? opened;
          final authority = CollectionAuthority();
          final transport = CollectionTransport(
            (r, _) => r.path == '/api/library/saved'
                ? savedResponse(r, [
                    savedRow(type, 'opaque:/same-name', source: source),
                  ])
                : const ApiResponse(200, {}),
          );
          final controller = SearchController(
            repository: savedRepository(transport, authority),
          );
          addTearDown(() async {
            controller.dispose();
            await authority.updates.close();
          });
          await controller.submit(
            'Сохранено',
            kind: type == 'artist' ? SearchKind.artists : SearchKind.albums,
          );
          await tester.pumpWidget(
            MaterialApp(
              theme: SoundspanTheme.dark(),
              builder: (context, child) => MediaQuery(
                data: MediaQuery.of(context)
                    .copyWith(textScaler: TextScaler.linear(1.8)),
                child: child!,
              ),
              home: SearchScreen(
                controller: controller,
                onOpenArtist: (ref) {
                  opened = ref;
                },
                onOpenAlbum: (ref) {
                  opened = ref;
                },
              ),
            ),
          );
          final tile = find.byKey(
            ValueKey('entity-$type:$source:opaque:/same-name'),
          );
          await tester.ensureVisible(tile);
          expect(tester.getSize(tile).height, greaterThanOrEqualTo(44));
          await tester.tap(tile);
          await tester.pumpAndSettle();
          expect(opened?.identityKey, '$type:$source:opaque:/same-name');
          expect(tester.takeException(), isNull);
          await tester.pumpWidget(const SizedBox());
        },
      );
    }
  }

  testWidgets(
    'returning after unsave refreshes only private groups and preserves public tracks',
    (tester) async {
      var saved = true;
      final authority = CollectionAuthority();
      final transport = CollectionTransport(
        (r, _) => r.path == '/api/library/saved'
            ? savedResponse(r, saved ? [savedRow('album', 'exact-album')] : [])
            : ApiResponse(
                200,
                r.path == '/api/search'
                    ? {
                        'tracks': [publicTrack()],
                        'albums': [
                          {'id': 'public', 'title': 'Публичный альбом'},
                        ],
                      }
                    : {},
              ),
      );
      final controller = SearchController(
        repository: savedRepository(transport, authority),
      );
      addTearDown(() async {
        controller.dispose();
        await authority.updates.close();
      });
      await controller.submit('Альбом', kind: SearchKind.albums);
      final tracks = controller.state.page.tracks,
          albums = controller.state.page.albums;
      final publicCalls = transport.requests
          .where((r) => r.path != '/api/library/saved')
          .length;
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: Builder(
            builder: (context) => SearchScreen(
              controller: controller,
              onOpenAlbum: (ref) async {
                await Navigator.of(context).push<void>(
                  MaterialPageRoute(
                    builder: (context) => Scaffold(
                      body: TextButton(
                        onPressed: () {
                          saved = false;
                          Navigator.of(context).pop();
                        },
                        child: const Text('Удалить из сохранённых'),
                      ),
                    ),
                  ),
                );
              },
            ),
          ),
        ),
      );
      await tester.tap(find.text('Сохранено exact-album'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Удалить из сохранённых'));
      await tester.pumpAndSettle();
      expect(find.text('Сохранённые альбомы'), findsNothing);
      expect(find.text('Публичный альбом'), findsOneWidget);
      expect(controller.state.page.tracks.single, same(tracks.single));
      expect(controller.state.page.albums.single, same(albums.single));
      expect(
        transport.requests.where((r) => r.path != '/api/library/saved').length,
        publicCalls,
      );
      expect(
        transport.requests.where((r) => r.path == '/api/library/saved').length,
        2,
      );
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'detail return from an older query cannot recheck current saved groups',
    (tester) async {
      final detail = Completer<void>(), authority = CollectionAuthority();
      final transport = CollectionTransport(
        (r, _) => r.path == '/api/library/saved'
            ? savedResponse(r, [savedRow('artist', r.query['q']!)])
            : const ApiResponse(200, {}),
      );
      final controller = SearchController(
        repository: savedRepository(transport, authority),
      );
      addTearDown(() async {
        controller.dispose();
        await authority.updates.close();
      });
      await controller.submit('Первая', kind: SearchKind.artists);
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: SearchScreen(
            controller: controller,
            onOpenArtist: (_) => detail.future,
          ),
        ),
      );
      await tester.tap(find.text('Сохранено Первая'));
      await controller.submit('Вторая', kind: SearchKind.artists);
      detail.complete();
      await tester.pumpAndSettle();
      expect(controller.state.page.savedArtists.single.ref.id, 'Вторая');
      expect(
        transport.requests.where((r) => r.path == '/api/library/saved').length,
        2,
      );
      await tester.pumpWidget(const SizedBox());
    },
  );
}
