import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/features/lyrics/lyrics_controller.dart';
import 'package:soundspan/features/lyrics/lyrics_repository.dart';
import 'package:soundspan/features/radio/radio_controller.dart';
import 'package:soundspan/features/radio/radio_repository.dart';
import 'package:soundspan/features/history/history_controller.dart';
import 'package:soundspan/features/history/history_repository.dart';

import '../support/collection_fixtures.dart';

class ReviewAuthority extends CollectionAuthority {
  Completer<void>? gate;
  @override
  Future<void> assertCurrent(fence) async {
    await gate?.future;
    await super.assertCurrent(fence);
  }
}

QueueSnapshot selected({int generation = 1}) => QueueSnapshot(
  fence: collectionFence,
  lineage: 1,
  generation: generation,
  entries: [
    QueueEntry(
      entryId: 'same',
      track: collectionTrack(1),
      context: const PlayContext(surface: PlaySurface.library),
    ),
  ],
  currentEntryId: 'same',
  duration: const Duration(seconds: 180),
);

Map<String, Object?> station() => {
  'id': 'station',
  'name': 'Radio',
  'totalItemCount': 0,
  'mergedItems': [],
  'pagination': {'hasMore': false, 'nextCursor': null},
};

Map<String, Object?> playRow(int index) => {
  'id': 'play-$index',
  'playedAt': '2026-10-15T12:00:00Z',
  'track': {...likedDto(index), 'source': 'library'},
};

void main() {
  late ReviewAuthority authority;
  late CollectionPlayback playback;
  setUp(() {
    authority = ReviewAuthority();
    playback = CollectionPlayback(selected());
  });
  tearDown(() async {
    await authority.updates.close();
  });
  RadioController radio(CollectionTransport transport) {
    final c = RadioController(
      repository: RadioRepository(
        transport: transport,
        authority: authority,
        fence: collectionFence,
        networkPolicy: const NetworkPolicy.online(),
      ),
      playback: playback,
    );
    addTearDown(c.dispose);
    return c;
  }

  HistoryController history(CollectionTransport transport) {
    final c = HistoryController(
      repository: HistoryRepository(
        transport: transport,
        authority: authority,
        fence: collectionFence,
        networkPolicy: const NetworkPolicy.online(),
      ),
      playback: playback,
    );
    addTearDown(c.dispose);
    return c;
  }

  LyricsController lyrics(CollectionTransport transport) {
    final c = LyricsController(
      repository: LyricsRepository(
        transport: transport,
        authority: authority,
        fence: collectionFence,
        networkPolicy: const NetworkPolicy.online(),
      ),
      playback: playback,
    );
    addTearDown(c.dispose);
    return c;
  }

  test(
    'review: owner revocation discards late lyrics and callback capability',
    () async {
      final response = Completer<ApiResponse>();
      final transport = CollectionTransport((r, f) => response.future);
      final c = lyrics(transport);
      final pending = c.follow();
      await Future<void>.delayed(Duration.zero);
      final target = c.target([collectionTrack(1)]);
      authority.switchOwner();
      response.complete(
        const ApiResponse(200, {
          'plainLyrics': 'owner A',
          'syncedLyrics': null,
          'synced': false,
          'source': 'lrclib',
        }),
      );
      await pending;
      expect(c.document, isNull);
      expect(c.track, isNull);
      expect(c.busy, isFalse);
      await expectLater(target.assertCurrent(), throwsA(isA<AppFailure>()));
      expect(playback.commands, isEmpty);
    },
  );

  test(
    'review: same occurrence new run cannot receive delayed lyric seek',
    () async {
      final c = lyrics(
        CollectionTransport(
          (r, f) => const ApiResponse(200, {
            'plainLyrics': null,
            'syncedLyrics': '[00:03.45]line',
            'synced': true,
            'source': 'lrclib',
          }),
        ),
      );
      await c.follow();
      final line = c.document!.lines.single;
      authority.gate = Completer<void>();
      final pending = c.seek(line);
      playback.value = selected(generation: 2);
      authority.gate!.complete();
      await pending;
      expect(playback.commands, isEmpty);
    },
  );

  test('review: radio mixed pages preserve occurrence provenance and do not autoplay', () async {
    var page = 0;
    final c = radio(
      CollectionTransport((r, f) {
        page++;
        return ApiResponse(200, {
          'tracks': [likedDto(page)],
          'generationId': 'g$page',
          'nextCursor': page == 1 ? 25 : null,
          'degradedSources': [],
        });
      }),
    );
    c.select(RadioSeed.track(collectionTrack(1)));
    await c.generate();
    await c.more();
    expect(playback.commands, isEmpty);
    await c.play(1);
    final command = playback.commands.single as ReplaceQueue;
    expect(command.initialEntryId, command.entries[1].entryId);
    expect(command.entries.map((e) => e.context.recommendationGenerationId), [
      'g1',
      'g2',
    ]);
  });

  for (final operation in ['append', 'regenerate']) {
    test(
      'review: acknowledged $operation with forbidden readback blocks repeat mutation',
      () async {
        var acknowledged = false;
        final transport = CollectionTransport((r, f) {
          if (r.path.endsWith('/$operation')) {
            acknowledged = true;
            return const ApiResponse(200, {'playlistId': 'station'});
          }
          if (r.path == '/api/playlists/station') {
            return acknowledged
                ? const ApiResponse(403, {'error': 'Forbidden'})
                : ApiResponse(200, station());
          }
          return const ApiResponse(200, {'playlistId': 'station'});
        });
        final c = radio(transport);
        c.select(const RadioSeed.genre('rock'));
        await c.generate();
        if (operation == 'append') {
          await c.append();
        } else {
          await c.regenerate();
        }
        expect(
          c.uncertain,
          isTrue,
          reason:
              'POST succeeded; failed readback does not mean POST was refused',
        );
        expect(c.canMutate, isFalse);
        expect(c.canReconcile, isTrue);
        if (operation == 'append') {
          await c.append();
        } else {
          await c.regenerate();
        }
        expect(
          transport.requests
              .where((r) => r.path.endsWith('/$operation'))
              .length,
          1,
        );
      },
    );
  }

  test(
    'review: lost create has no duplicate POST or fabricated reconciliation',
    () async {
      final transport = CollectionTransport(
        (r, f) => throw StateError('lost after commit'),
      );
      final c = radio(transport);
      c.select(const RadioSeed.genre('rock'));
      await c.generate();
      await c.generate();
      await c.reconcile();
      expect(c.uncertain, isTrue);
      expect(c.canReconcile, isFalse);
      expect(transport.requests.length, 1);
    },
  );

  test('review: filtered history response must not hide older rows inside server cap', () async {
    final transport = CollectionTransport((r, f) {
      if (r.path.endsWith('/summary')) {
        return const ApiResponse(200, {
          'allTime': 250,
          'last7Days': 250,
          'last30Days': 250,
          'last365Days': 250,
        });
      }
      final limit = int.parse(r.query['limit']!);
      // Actual server first takes limit raw plays, then drops rows without any track.
      return ApiResponse(200, [for (var i = 1; i < limit; i++) playRow(i)]);
    });
    final c = history(transport);
    await c.load();
    expect(c.page!.entries.length, 49);
    expect(c.summary!.allTime, 250);
    await c.more();
    expect(
      transport.requests
          .where((r) => r.path == '/api/plays')
          .map((r) => r.query['limit']),
      ['50', '100'],
      reason: '49 DTO rows can represent a full 50-row raw window',
    );
    expect(c.page!.entries.length, 99);
  });

  test(
    'review: history cap stops at 200 without duplicate accumulation',
    () async {
      final transport = CollectionTransport(
        (r, f) => ApiResponse(
          200,
          r.path.endsWith('/summary')
              ? {
                  'allTime': 250,
                  'last7Days': 250,
                  'last30Days': 250,
                  'last365Days': 250,
                }
              : [
                  for (var i = 0; i < int.parse(r.query['limit']!); i++)
                    playRow(i),
                ],
        ),
      );
      final c = history(transport);
      await c.load();
      for (var i = 0; i < 5; i++) {
        await c.more();
      }
      expect(c.page!.entries.length, 200);
      expect(c.page!.entries.map((e) => e.id).toSet().length, 200);
      expect(c.page!.reachedServerLimit, isTrue);
      expect(c.page!.nextCursor, isNull);
      expect(transport.requests.where((r) => r.path == '/api/plays').length, 4);
    },
  );
}
