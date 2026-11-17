import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/features/search/catalog_models.dart';
import 'package:soundspan/features/search/search_controller.dart';
import 'package:soundspan/features/search/search_repository.dart';

import '../support/collection_fixtures.dart';

Map<String, Object?> savedNative(String provider, String id) => {
  'id': '$provider:$id',
  'title': 'Одна песня',
  'duration': 180.125,
  'artist': {'id': null, 'name': 'Исполнитель'},
  'album': {'id': null, 'title': '', 'coverArt': null},
  'source': provider,
  'streamSource': provider,
  'provider': {
    'source': provider,
    'providerTrackId': id,
    'youtubeVideoId': null,
    'tidalTrackId': null,
  },
  'musicSourceRecording': {
    'provider': provider,
    'id': id,
    'title': 'Одна песня',
    'artists': ['Исполнитель'],
    'duration': 180.125,
    'contentVersion': 'explicit',
    'preview': false,
  },
};

Map<String, Object?> savedYoutube(String id) => {
  'id': 'yt:$id',
  'title': 'Сохранённая песня',
  'duration': 180.125,
  'source': 'youtube',
  'streamSource': 'youtube',
  'provider': {'source': 'youtube', 'youtubeVideoId': id},
  'artist': {'id': null, 'name': 'Исполнитель'},
  'album': {'id': null, 'title': '', 'coverArt': null},
};

Map<String, Object?> localTrack() => {
  'id': 'local-song',
  'title': 'Одна песня',
  'source': 'local',
  'album': {
    'id': 'local-album',
    'title': 'Альбом',
    'artist': {'id': 'local-artist', 'name': 'Исполнитель'},
  },
  'duration': 180.125,
};

Map<String, Object?> discoveredTrack(String id) => {
  'type': 'track',
  'id': 'discovery:$id',
  'name': 'Одна песня',
  'artist': 'Исполнитель',
  'youtubeVideoId': id,
  'duration': 180.125,
};

Map<String, Object?> rawPage(int offset, {bool hasMore = false}) => {
  'offset': offset,
  'limit': 50,
  'hasMore': hasMore,
};

SearchRepository repository(
  CollectionTransport transport,
  CollectionAuthority authority,
) {
  final result = SearchRepository(
    transport: transport,
    authority: authority,
    fence: collectionFence,
    networkPolicy: const NetworkPolicy.online(),
  );
  addTearDown(() async {
    result.dispose();
    await authority.updates.close();
  });
  return result;
}

void main() {
  for (final kind in [SearchKind.all, SearchKind.tracks]) {
    test(
      '$kind retries a failed personal page before advancing raw offset',
      () async {
        final requested = <int>[];
        var unavailable = true;
        final transport = CollectionTransport((request, _) {
          if (request.path != '/api/search') return const ApiResponse(200, {});
          final offset = int.parse(request.query['offset']!);
          if (request.query['type'] != kind.name &&
              request.query['type'] != 'tracks') {
            return const ApiResponse(200, {});
          }
          requested.add(offset);
          final failed = offset == 50 && unavailable;
          return ApiResponse(200, {
            'tracks': List.generate(
              50,
              (i) => {...localTrack(), 'id': 'local-${offset + i}'},
            ),
            'streamingTracks': failed ? [] : [savedYoutube('saved-$offset')],
            'streamingPage': rawPage(offset, hasMore: !failed),
            if (failed) 'streamingUnavailable': true,
          });
        });
        final repo = repository(transport, CollectionAuthority());
        final first = await repo.search('Песня', kind);
        expect(first.localOffset, 50);
        final failed = await repo.search('Песня', kind, previous: first);
        expect(failed.localOffset, 50);
        expect(failed.localHasMore, true);
        expect(failed.failures, contains('liked'));
        unavailable = false;
        final recovered = await repo.search('Песня', kind, previous: failed);
        expect(requested, [0, 50, 50]);
        expect(recovered.localOffset, 100);
        expect(recovered.failures, isEmpty);
        expect(
          recovered.tracks.where((t) => t.ref is LibraryTrackRef),
          hasLength(100),
        );
        expect(
          recovered.tracks.map((t) => t.ref.identityKey),
          contains('yt:saved-50'),
        );
      },
    );
  }

  test('stored VK, Yandex and YouTube survive provider HTTP 503', () async {
    final transport = CollectionTransport(
      (request, _) => switch (request.path) {
        '/api/search' => ApiResponse(200, {
          'tracks': [localTrack()],
          'streamingTracks': [
            savedNative('vk', '-12_34'),
            savedNative('yandex', '56'),
            savedYoutube('saved-video'),
          ],
          'streamingPage': rawPage(0),
        }),
        '/api/search/discover' => ApiResponse(200, {
          'results': [discoveredTrack('discovered-video')],
        }),
        _ => const ApiResponse(503, {}),
      },
    );
    final page = await repository(
      transport,
      CollectionAuthority(),
    ).search('Песня', SearchKind.all);

    expect(page.tracks.map((track) => track.ref.identityKey), [
      'vk:-12_34',
      'yandex:56',
      'yt:saved-video',
      'library:local-song',
      'yt:discovered-video',
    ]);
    expect(page.tracks.every((track) => track.playable), true);
    expect(page.tracks.first.ref, isA<NativeTrackRef>());
    expect(page.tracks.first.explicit, true);
    expect(page.tracks.first.duration, const Duration(milliseconds: 180125));
    expect(page.failures.keys, ['native']);
    expect(transport.fences, everyElement(collectionFence));
  });

  test(
    'only exact transport identities dedupe personal and catalog hits',
    () async {
      final vk = savedNative('vk', '-12_34');
      final transport = CollectionTransport(
        (request, _) => ApiResponse(200, switch (request.path) {
          '/api/search' => {
            'tracks': [localTrack()],
            'streamingTracks': [vk, savedYoutube('same-video')],
            'streamingPage': rawPage(0),
          },
          '/api/search/discover' => {
            'results': [
              discoveredTrack('same-video'),
              discoveredTrack('other-video'),
            ],
          },
          _ => {
            'tracks': [
              vk['musicSourceRecording'],
              savedNative('yandex', '56')['musicSourceRecording'],
            ],
          },
        }),
      );
      final page = await repository(
        transport,
        CollectionAuthority(),
      ).search('Песня', SearchKind.tracks);

      expect(page.tracks.map((track) => track.ref.identityKey), [
        'vk:-12_34',
        'yt:same-video',
        'library:local-song',
        'yt:other-video',
        'yandex:56',
      ]);
      expect(page.tracks[1].title, 'Сохранённая песня');
    },
  );

  for (final kind in [SearchKind.all, SearchKind.tracks]) {
    test('$kind continues an empty visible raw personal page by 50', () async {
      final transport = CollectionTransport((request, _) {
        if (request.path != '/api/search') return const ApiResponse(200, {});
        final offset = int.parse(request.query['offset']!);
        return ApiResponse(200, {
          'tracks': [],
          'artists': request.query['type'] == 'artists'
              ? [
                  {'id': 'artist-50', 'name': 'Следующий артист'},
                ]
              : [],
          'albums': [],
          'streamingTracks': offset == 0
              ? []
              : [
                  savedYoutube(
                    request.query['type'] == 'tracks'
                        ? 'next'
                        : 'wrong-category',
                  ),
                ],
          'streamingPage': rawPage(offset, hasMore: offset == 0),
        });
      });
      final repo = repository(transport, CollectionAuthority());
      final first = await repo.search('Песня', kind);

      expect(first.tracks, isEmpty);
      expect(first.localHasMore, true);
      expect(first.localOffset, 50);
      final next = await repo.search('Песня', kind, previous: first);
      expect(next.tracks.map((track) => track.ref.identityKey), ['yt:next']);
      expect(next.localHasMore, false);
      expect(next.localOffset, 100);
      final requests = transport.requests
          .where((request) => request.path == '/api/search')
          .toList();
      expect(requests.first.query['offset'], '0');
      expect(
        requests.skip(1).map((request) => request.query['offset']),
        everyElement('50'),
      );
      expect(
        requests.map((request) => request.query['limit']),
        everyElement('50'),
      );
      expect(
        requests.map((request) => request.query['source']),
        everyElement('all'),
      );
      expect(
        requests.map((request) => request.query['type']),
        kind == SearchKind.all
            ? ['all', 'tracks', 'artists', 'albums']
            : ['tracks', 'tracks'],
      );
      if (kind == SearchKind.all) {
        expect(next.artists.single.ref.id, 'artist-50');
      }
    });
  }

  test(
    'malformed personal rows cannot hide valid rows or invent local IDs',
    () async {
      final malformed = savedNative('vk', '-12_34')
        ..remove('musicSourceRecording');
      final mismatch = savedNative('yandex', '56')..['id'] = 'yandex:57';
      final transport = CollectionTransport(
        (request, _) => ApiResponse(
          200,
          request.path == '/api/search'
              ? {
                  'tracks': [localTrack()],
                  'streamingTracks': [
                    savedYoutube('first'),
                    17,
                    malformed,
                    mismatch,
                    likedDto(99),
                    savedNative('vk', '-99_100'),
                  ],
                  'streamingPage': rawPage(0, hasMore: true),
                }
              : {},
        ),
      );
      final page = await repository(
        transport,
        CollectionAuthority(),
      ).search('Песня', SearchKind.tracks);

      expect(page.tracks.map((track) => track.ref.identityKey), [
        'yt:first',
        'vk:-99_100',
        'library:local-song',
      ]);
      expect(page.localOffset, 50);
      expect(page.localHasMore, true);
      expect(page.failures.keys, contains('liked'));
    },
  );

  test(
    'private failure preserves library and discovery and retry clears notice',
    () async {
      var unavailable = true;
      final transport = CollectionTransport(
        (request, _) => ApiResponse(200, switch (request.path) {
          '/api/search' => {
            'tracks': [localTrack()],
            'streamingTracks': unavailable ? [] : [savedYoutube('recovered')],
            'streamingPage': rawPage(0),
            if (unavailable) 'streamingUnavailable': true,
          },
          '/api/search/discover' => {
            'results': [discoveredTrack('discovery')],
          },
          _ => {},
        }),
      );
      final repo = repository(transport, CollectionAuthority());
      final failed = await repo.search('Песня', SearchKind.all);
      expect(failed.tracks.map((track) => track.ref.identityKey), [
        'library:local-song',
        'yt:discovery',
      ]);
      expect(failed.failures.keys, ['liked']);
      expect(failed.failures['liked']!.message, contains('любим'));
      unavailable = false;
      final recovered = await repo.search('Песня', SearchKind.all);
      expect(recovered.tracks.first.ref, const YoutubeTrackRef('recovered'));
      expect(recovered.failures, isEmpty);
    },
  );

  test(
    'invalid optional personal list preserves existing search results',
    () async {
      final transport = CollectionTransport(
        (request, _) => ApiResponse(
          200,
          request.path == '/api/search'
              ? {
                  'tracks': [localTrack()],
                  'streamingTracks': {'id': 'not-a-list'},
                  'streamingPage': rawPage(0, hasMore: true),
                }
              : {},
        ),
      );
      final page = await repository(
        transport,
        CollectionAuthority(),
      ).search('Песня', SearchKind.tracks);
      expect(page.tracks.single.ref, const LibraryTrackRef('local-song'));
      expect(page.failures.keys, ['liked']);
      expect(page.localHasMore, false);
    },
  );

  for (final invalidPage in <Object?>[
    'not-an-object',
    {'offset': 0, 'limit': 50, 'hasMore': 'true'},
    {'offset': '0', 'limit': 50, 'hasMore': true},
    {'offset': 50, 'limit': 50, 'hasMore': true},
    {'offset': 0, 'limit': 0, 'hasMore': true},
    {'offset': 0, 'limit': 100, 'hasMore': true},
  ]) {
    test(
      'invalid personal page $invalidPage cannot authorize continuation',
      () async {
        final transport = CollectionTransport(
          (request, _) => ApiResponse(
            200,
            request.path == '/api/search'
                ? {
                    'tracks': [localTrack()],
                    'streamingTracks': [savedYoutube('saved')],
                    'streamingPage': invalidPage,
                  }
                : {},
          ),
        );
        final page = await repository(
          transport,
          CollectionAuthority(),
        ).search('Песня', SearchKind.tracks);
        expect(page.tracks.map((track) => track.ref.identityKey), [
          'yt:saved',
          'library:local-song',
        ]);
        expect(page.localHasMore, false);
        expect(page.failures.keys, ['liked']);
      },
    );
  }

  test(
    'legacy server without optional fields keeps normal local search',
    () async {
      final transport = CollectionTransport(
        (request, _) => ApiResponse(
          200,
          request.path == '/api/search'
              ? {
                  'tracks': [localTrack()],
                }
              : {},
        ),
      );
      final page = await repository(
        transport,
        CollectionAuthority(),
      ).search('Песня', SearchKind.tracks);
      expect(page.tracks.single.ref, const LibraryTrackRef('local-song'));
      expect(page.failures, isEmpty);
      expect(page.localHasMore, false);
    },
  );

  for (final kind in [SearchKind.artists, SearchKind.albums]) {
    test('$kind cannot admit unexpected personal fields', () async {
      final transport = CollectionTransport(
        (request, _) => ApiResponse(200, {
          'streamingTracks': [savedYoutube('unexpected')],
          'streamingPage': rawPage(0, hasMore: true),
          'streamingUnavailable': true,
        }),
      );
      final page = await repository(
        transport,
        CollectionAuthority(),
      ).search('Песня', kind);
      expect(page.tracks, isEmpty);
      expect(page.localHasMore, false);
      expect(page.failures, isEmpty);
    });
  }

  test('late personal response is rejected after owner changes', () async {
    final authority = CollectionAuthority();
    final pending = Completer<ApiResponse>();
    final admitted = Completer<void>();
    final transport = CollectionTransport((request, _) {
      if (request.path != '/api/search') return const ApiResponse(200, {});
      admitted.complete();
      return pending.future;
    });
    final repo = repository(transport, authority);
    final result = repo.search('Песня', SearchKind.tracks);
    final assertion = expectLater(
      result,
      throwsA(
        isA<AppFailure>().having(
          (failure) => failure.code,
          'code',
          'stale_session',
        ),
      ),
    );
    await admitted.future;
    authority.switchOwner();
    pending.complete(
      ApiResponse(200, {
        'streamingTracks': [savedYoutube('old-owner')],
        'streamingPage': rawPage(0),
      }),
    );
    await assertion;
    final before = transport.requests.length;
    await expectLater(
      repo.search('Ещё', SearchKind.tracks),
      throwsA(isA<AppFailure>()),
    );
    expect(transport.requests, hasLength(before));
  });

  test('late personal query cannot replace the current query', () async {
    final pending = Completer<ApiResponse>();
    final admitted = Completer<void>();
    final transport = CollectionTransport((request, _) {
      if (request.path != '/api/search') return const ApiResponse(200, {});
      if (request.query['q'] == 'Первая') {
        admitted.complete();
        return pending.future;
      }
      return ApiResponse(200, {
        'streamingTracks': [savedYoutube('current-query')],
        'streamingPage': rawPage(0),
      });
    });
    final controller = SearchController(
      repository: repository(transport, CollectionAuthority()),
    );
    addTearDown(controller.dispose);
    final first = controller.submit('Первая', kind: SearchKind.tracks);
    await admitted.future;
    await controller.submit('Вторая', kind: SearchKind.tracks);
    pending.complete(
      ApiResponse(200, {
        'streamingTracks': [savedYoutube('old-query')],
        'streamingPage': rawPage(0),
      }),
    );
    await first;
    expect(controller.state.query, 'Вторая');
    expect(
      controller.state.page.tracks.single.ref,
      const YoutubeTrackRef('current-query'),
    );
  });
}
