import 'dart:async';

import 'package:flutter/material.dart' hide SearchController;
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/design_system/theme.dart';
import 'package:soundspan/features/search/catalog_models.dart';
import 'package:soundspan/features/search/search_controller.dart';
import 'package:soundspan/features/search/search_repository.dart';
import 'package:soundspan/features/search/search_screen.dart';

import 'search_saved_entities_test.dart' show savedRow, savedResponse;
import 'search_liked_tracks_test.dart'
    show discoveredTrack, savedYoutube, rawPage;

import '../support/collection_fixtures.dart';

Map<String, Object?> partialLocalTrack(String id) => {
  'id': id,
  'title': 'Полезный результат',
  'duration': 180,
  'album': {
    'id': 'album',
    'title': 'Album',
    'artist': {'id': 'artist', 'name': 'Artist'},
  },
};

void main() {
  for (final delayed in [true, false]) {
    testWidgets(
      'explicit retry keeps useful local row ${delayed ? 'during await' : 'after total outage'}',
      (tester) async {
        final authority = CollectionAuthority();
        final held = Completer<void>();
        var retrying = false;
        final transport = CollectionTransport((request, _) async {
          if (request.path == '/api/search/discover') {
            if (retrying && delayed) await held.future;
            return const ApiResponse(503, {});
          }
          if (retrying) return const ApiResponse(503, {});
          return ApiResponse(
            200,
            request.path == '/api/search'
                ? {
                    'tracks': [partialLocalTrack('local')],
                  }
                : {},
          );
        });
        final controller = SearchController(
          repository: SearchRepository(
            transport: transport,
            authority: authority,
            fence: collectionFence,
            networkPolicy: const NetworkPolicy.online(),
          ),
        );
        addTearDown(() async {
          if (!held.isCompleted) held.complete();
          controller.dispose();
          await authority.updates.close();
        });
        await controller.submit('same', kind: SearchKind.tracks);
        expect(
          controller.state.page.tracks.single.ref.identityKey,
          'library:local',
        );
        await tester.pumpWidget(
          MaterialApp(
            theme: SoundspanTheme.dark(),
            home: SearchScreen(controller: controller),
          ),
        );
        retrying = true;
        await tester.tap(find.text('Повторить поиск'));
        if (!delayed) await tester.pumpAndSettle();
        expect(controller.state.page.tracks.map((t) => t.ref.identityKey), [
          'library:local',
        ]);
        if (!held.isCompleted) held.complete();
        await tester.pumpAndSettle();
        expect(controller.state.page.tracks.map((t) => t.ref.identityKey), [
          'library:local',
        ]);
        expect(controller.state.page.failures, contains('discovery'));
        await tester.pumpWidget(const SizedBox.shrink());
      },
    );
  }

  SearchController controller(
    CollectionAuthority authority,
    CollectionTransport transport,
  ) {
    final result = SearchController(
      repository: SearchRepository(
        transport: transport,
        authority: authority,
        fence: authority.requireFence(),
        networkPolicy: const NetworkPolicy.online(),
      ),
    );
    addTearDown(() async {
      result.dispose();
      await authority.updates.close();
    });
    return result;
  }

  for (final intent in ['query', 'category', 'clear', 'owner']) {
    test(
      'retry cannot revive rows after $intent retires the captured search',
      () async {
        final authority = CollectionAuthority();
        final held = Completer<void>();
        var discoverCalls = 0;
        final c = controller(
          authority,
          CollectionTransport((request, _) async {
            if (request.path == '/api/search/discover') {
              if (++discoverCalls == 2) await held.future;
              return const ApiResponse(503, {});
            }
            if (request.path == '/api/library/saved') {
              return savedResponse(request, []);
            }
            return ApiResponse(
              200,
              request.path == '/api/search'
                  ? {
                      'tracks': [partialLocalTrack(request.query['q']!)],
                    }
                  : {},
            );
          }),
        );
        await c.submit('A', kind: SearchKind.tracks);
        final retry = c.retry();
        await Future<void>.delayed(Duration.zero);
        switch (intent) {
          case 'query':
            final pending = c.submit('B');
            expect(c.state.page.tracks, isEmpty);
            await pending;
          case 'category':
            final pending = c.setKind(SearchKind.albums);
            expect(c.state.page.tracks, isEmpty);
            await pending;
          case 'clear':
            c.clear();
          case 'owner':
            authority.switchOwner();
        }
        held.complete();
        await retry;
        if (intent == 'query') {
          expect(c.state.query, 'B');
          expect(c.state.page.tracks.single.ref.identityKey, 'library:B');
        } else if (intent == 'category') {
          expect(c.state.kind, SearchKind.albums);
        } else {
          expect(c.state.page.tracks, isEmpty);
        }
      },
    );
  }

  test('retry requests failed discovery only and keeps distinct same-title exact IDs', () async {
    var available = false;
    final transport = CollectionTransport((request, _) {
      if (request.path == '/api/search/discover') {
        return available
            ? ApiResponse(200, {
                'results': [discoveredTrack('one'), discoveredTrack('two')],
              })
            : const ApiResponse(503, {});
      }
      return ApiResponse(
        200,
        request.path == '/api/search'
            ? {
                'tracks': [partialLocalTrack('local')],
              }
            : {},
      );
    });
    final c = controller(CollectionAuthority(), transport);
    await c.submit('same', kind: SearchKind.tracks);
    final offset = c.state.page.localOffset;
    available = true;
    await c.retry();
    await c.retry();
    expect(c.state.page.tracks.map((t) => t.ref.identityKey), [
      'library:local',
      'yt:one',
      'yt:two',
    ]);
    expect(c.state.page.localOffset, offset);
    expect(transport.requests.where((r) => r.path == '/api/search').length, 1);
    expect(
      transport.requests
          .where((r) => r.path == '/api/search/discover')
          .map((r) => r.query['limit']),
      ['50', '50'],
    );
  });

  test(
    'failed library retries offsetzero without using the continuation cursor',
    () async {
      var available = false;
      final transport = CollectionTransport((request, _) {
        if (request.path == '/api/search') {
          return available
              ? ApiResponse(200, {
                  'tracks': [partialLocalTrack('local')],
                })
              : const ApiResponse(503, {});
        }
        return ApiResponse(
          200,
          request.path == '/api/search/discover'
              ? {
                  'results': [discoveredTrack('valid')],
                }
              : {},
        );
      });
      final c = controller(CollectionAuthority(), transport);
      await c.submit('same', kind: SearchKind.tracks);
      available = true;
      await c.retry();
      expect(c.state.page.tracks.map((t) => t.ref.identityKey), [
        'yt:valid',
        'library:local',
      ]);
      expect(
        transport.requests
            .where((r) => r.path == '/api/search')
            .map((r) => r.query['offset']),
        ['0', '0'],
      );
      expect(
        transport.requests
            .where((r) => r.path == '/api/search/discover')
            .length,
        1,
      );
    },
  );

  test(
    'successful replacement removes only its obsolete partial source rows',
    () async {
      var recovered = false;
      final c = controller(
        CollectionAuthority(),
        CollectionTransport(
          (request, _) => ApiResponse(
            200,
            request.path == '/api/search/discover'
                ? {
                    'results': recovered ? [] : [discoveredTrack('obsolete')],
                    'partialFailure': !recovered,
                  }
                : request.path == '/api/search'
                ? {
                    'tracks': [partialLocalTrack('keep')],
                  }
                : {},
          ),
        ),
      );
      await c.submit('same', kind: SearchKind.tracks);
      expect(c.state.page.tracks, hasLength(2));
      recovered = true;
      await c.retry();
      expect(c.state.page.tracks.single.ref.identityKey, 'library:keep');
      expect(c.state.page.failures, isEmpty);
    },
  );

  test('saved mutation supersedes a delayed public retry and never restores deleted membership', () async {
    final held = Completer<void>();
    var saved = true, discovers = 0;
    final transport = CollectionTransport((request, _) async {
      if (request.path == '/api/library/saved') {
        return savedResponse(
          request,
          saved ? [savedRow('album', 'private')] : [],
        );
      }
      if (request.path == '/api/search/discover') {
        if (++discovers == 2) await held.future;
        return const ApiResponse(503, {});
      }
      return const ApiResponse(200, {});
    });
    final c = controller(CollectionAuthority(), transport);
    await c.submit('same', kind: SearchKind.albums);
    expect(c.state.page.savedAlbums, hasLength(1));
    final retry = c.retry();
    await Future<void>.delayed(Duration.zero);
    saved = false;
    await c.refreshSaved();
    expect(c.state.page.savedAlbums, isEmpty);
    held.complete();
    await retry;
    expect(c.state.page.savedAlbums, isEmpty);
    expect(
      transport.requests.where((r) => r.path == '/api/library/saved').length,
      2,
    );
  });

  test('loaded library pages and raw cursor survive a failed-source retry without duplicate rows', () async {
    var available = false;
    final transport = CollectionTransport((request, _) {
      if (request.path == '/api/search/discover') {
        return available
            ? ApiResponse(200, {
                'results': [discoveredTrack('recovered')],
              })
            : const ApiResponse(503, {});
      }
      if (request.path != '/api/search') return const ApiResponse(200, {});
      final offset = int.parse(request.query['offset']!);
      return ApiResponse(200, {
        'tracks': offset < 100
            ? List.generate(50, (i) => partialLocalTrack('${offset + i}'))
            : [],
      });
    });
    final c = controller(CollectionAuthority(), transport);
    await c.submit('same', kind: SearchKind.tracks);
    await c.loadMore();
    expect(c.state.page.localOffset, 100);
    available = true;
    await c.retry();
    expect(c.state.page.localOffset, 100);
    expect(c.state.page.tracks, hasLength(101));
    await c.loadMore();
    expect(
      c.state.page.tracks.map((t) => t.ref.identityKey).toSet(),
      hasLength(101),
    );
    expect(
      transport.requests
          .where((r) => r.path == '/api/search')
          .map((r) => r.query['offset']),
      ['0', '50', '100'],
    );
  });

  test('retry recovers a later failed library window without discarding its successful prefix', () async {
    var recovered = false;
    final transport = CollectionTransport((request, _) {
      if (request.path != '/api/search') return const ApiResponse(200, {});
      final offset = int.parse(request.query['offset']!);
      if (offset == 100 && !recovered) return const ApiResponse(503, {});
      return ApiResponse(200, {
        'tracks': List.generate(50, (i) => partialLocalTrack('${offset + i}')),
      });
    });
    final c = controller(CollectionAuthority(), transport);
    await c.submit('same', kind: SearchKind.tracks);
    await c.loadMore();
    await c.loadMore();
    expect(c.state.page.tracks, hasLength(100));
    expect(c.state.page.localOffset, 100);
    recovered = true;
    await c.retry();
    expect(
      c.state.page.tracks.map((t) => t.ref.identityKey).toSet(),
      containsAll(List.generate(100, (i) => 'library:$i')),
    );
    expect(c.state.page.localOffset, greaterThanOrEqualTo(100));
    expect(c.state.page.failures, isEmpty);
    expect(
      transport.requests
          .where((r) => r.path == '/api/search')
          .last
          .query['offset'],
      '100',
    );
  });

  test('all-category recovery replaces only failed-window membership and retains earlier windows', () async {
    var recovered = false;
    final transport = CollectionTransport((request, _) {
      if (request.path == '/api/library/saved') {
        return savedResponse(request, []);
      }
      if (request.path != '/api/search') return const ApiResponse(200, {});
      final offset = int.parse(request.query['offset']!);
      if (request.query['type'] == 'albums' && offset == 100 && !recovered) {
        return const ApiResponse(503, {});
      }
      if (!['all', 'tracks'].contains(request.query['type'])) {
        return const ApiResponse(200, {});
      }
      return ApiResponse(200, {
        'tracks': List.generate(50, (i) => partialLocalTrack('${offset + i}')),
        'streamingTracks': [
          if (offset == 100 && !recovered)
            savedYoutube('removed-from-failed-window'),
        ],
        'streamingPage': rawPage(offset),
      });
    });
    final c = controller(CollectionAuthority(), transport);
    await c.submit('same');
    await c.loadMore();
    await c.loadMore();
    expect(
      c.state.page.tracks.any(
        (t) => t.ref.identityKey == 'yt:removed-from-failed-window',
      ),
      isTrue,
    );
    expect(c.state.page.failures, contains('library:albums'));
    recovered = true;
    await c.retry();
    final identities = c.state.page.tracks
        .map((t) => t.ref.identityKey)
        .toSet();
    expect(identities, containsAll(List.generate(100, (i) => 'library:$i')));
    expect(identities, isNot(contains('yt:removed-from-failed-window')));
    expect(c.state.page.localOffset, 150);
    expect(c.state.page.failures, isEmpty);
  });
}
