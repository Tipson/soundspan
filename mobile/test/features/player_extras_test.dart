import 'package:flutter_test/flutter_test.dart';

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/design_system/theme.dart';
import 'package:soundspan/features/lyrics/lyrics_controller.dart';
import 'package:soundspan/features/lyrics/lyrics_sheet.dart';
import 'package:soundspan/features/related/related_controller.dart';
import 'package:soundspan/features/related/related_sheet.dart';
import 'package:soundspan/features/radio/radio_controller.dart';
import 'package:soundspan/features/radio/radio_screen.dart';
import 'package:soundspan/features/history/history_controller.dart';
import 'package:soundspan/features/history/history_screen.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/features/lyrics/lyrics_repository.dart';
import 'package:soundspan/features/related/related_repository.dart';
import 'package:soundspan/features/radio/radio_repository.dart';
import 'package:soundspan/features/history/history_repository.dart';

import '../support/collection_fixtures.dart';

class ExtrasAdmissionAuthority extends CollectionAuthority {
  Completer<void>? gate;
  @override
  Future<void> assertCurrent(fence) async {
    await gate?.future;
    await super.assertCurrent(fence);
  }
}

void main() {
  late CollectionAuthority authority;
  late CollectionTransport transport;
  setUp(() {
    authority = CollectionAuthority();
    transport = CollectionTransport(
      (r, _) => ApiResponse(200, switch (r.path) {
        '/api/lyrics/local-1' => {
          'plainLyrics': 'Строка',
          'syncedLyrics': null,
          'source': 'lrclib',
          'synced': false,
        },
        '/api/player/related' => {
          'tracks': [],
          'artists': [],
          'albums': [],
          'nextCursor': null,
          'degradedSources': [],
        },
        '/api/library/radio/playlists' => {
          'playlistId': 'station',
          'entries': [],
        },
        '/api/playlists/station' => {
          'id': 'station',
          'name': 'Radio',
          'mergedItems': [],
          'totalItemCount': 0,
          'pagination': {'hasMore': false, 'nextCursor': null},
        },
        _ => {'success': true, 'range': r.query['range'], 'deletedCount': 0},
      }),
    );
  });
  tearDown(() async => authority.updates.close());
  test('lyrics metadata goes to mounted route', () async {
    final repo = LyricsRepository(
      transport: transport,
      authority: authority,
      fence: collectionFence,
      networkPolicy: const NetworkPolicy.online(),
    );
    addTearDown(repo.dispose);
    final value = await repo.lookup(collectionTrack(1));
    expect(value.plain, 'Строка');
    expect(transport.requests.single.path, '/api/lyrics/local-1');
    expect(
      transport.requests.single.query['artist'],
      collectionTrack(1).artist,
    );
    expect(transport.fences.single, collectionFence);
  });
  test('related exact seed and metadata use player route', () async {
    final repo = RelatedRepository(
      transport: transport,
      authority: authority,
      fence: collectionFence,
      networkPolicy: const NetworkPolicy.online(),
    );
    addTearDown(repo.dispose);
    await repo.lookup(collectionTrack(1));
    expect(transport.requests.single.path, '/api/player/related');
    expect(transport.requests.single.query['seedTrackId'], 'local-1');
  });
  test('genre creation uses supported filter and never autoplay', () async {
    final repo = RadioRepository(
      transport: transport,
      authority: authority,
      fence: collectionFence,
      networkPolicy: const NetworkPolicy.online(),
    );
    addTearDown(repo.dispose);
    await repo.start(const RadioSeed.genre('rock'));
    expect(transport.requests.first.method, ApiMethod.post);
    expect(transport.requests.first.body, {
      'filter': {'type': 'genre', 'value': 'rock'},
      'size': 25,
    });
  });
  test('history every clear range matches server query', () async {
    final repo = HistoryRepository(
      transport: transport,
      authority: authority,
      fence: collectionFence,
      networkPolicy: const NetworkPolicy.online(),
    );
    addTearDown(repo.dispose);
    for (final range in HistoryRange.values) {
      await repo.clear(range);
    }
    expect(transport.requests.map((r) => r.query['range']), [
      '7d',
      '30d',
      '365d',
      'all',
    ]);
    expect(
      transport.requests.every(
        (r) => r.method == ApiMethod.delete && r.path == '/api/plays/history',
      ),
      isTrue,
    );
  });
  LyricsRepository lyricsRepo({
    NetworkPolicy policy = const NetworkPolicy.online(),
  }) => LyricsRepository(
    transport: transport,
    authority: authority,
    fence: collectionFence,
    networkPolicy: policy,
  );
  RelatedRepository relatedRepo() => RelatedRepository(
    transport: transport,
    authority: authority,
    fence: collectionFence,
    networkPolicy: const NetworkPolicy.online(),
  );
  RadioRepository radioRepo() => RadioRepository(
    transport: transport,
    authority: authority,
    fence: collectionFence,
    networkPolicy: const NetworkPolicy.online(),
  );
  HistoryRepository historyRepo() => HistoryRepository(
    transport: transport,
    authority: authority,
    fence: collectionFence,
    networkPolicy: const NetworkPolicy.online(),
  );
  QueueSnapshot state(int id, {int generation = 1}) => QueueSnapshot(
    fence: collectionFence,
    entries: [
      QueueEntry(
        entryId: 'entry-$id',
        track: collectionTrack(id),
        context: const PlayContext(surface: PlaySurface.library),
      ),
    ],
    currentEntryId: 'entry-$id',
    lineage: 1,
    generation: generation,
    duration: const Duration(seconds: 180),
  );
  test('lyrics stale response cannot replace next occurrence and timestamp guards exact entry', () async {
    final first = Completer<ApiResponse>();
    transport = CollectionTransport(
      (r, _) => r.path.endsWith('local-1')
          ? first.future
          : const ApiResponse(200, {
              'plainLyrics': null,
              'syncedLyrics': '[00:12.30] Строка',
              'synced': true,
              'source': 'lrclib',
            }),
    );
    final playback = CollectionPlayback(state(1));
    final c = LyricsController(repository: lyricsRepo(), playback: playback);
    addTearDown(c.dispose);
    final old = c.follow();
    await Future<void>.delayed(Duration.zero);
    playback.value = state(2, generation: 2);
    await c.follow();
    first.complete(
      const ApiResponse(200, {
        'plainLyrics': 'Старый текст',
        'syncedLyrics': null,
        'synced': false,
        'source': 'lrclib',
      }),
    );
    await old;
    expect(
      c.document!.lines.single.position,
      const Duration(milliseconds: 12300),
    );
    final line = c.document!.lines.single;
    await c.seek(line);
    expect(
      (playback.commands.single as Seek).position,
      const Duration(milliseconds: 12300),
    );
    playback.value = state(3, generation: 3);
    await c.seek(line);
    expect(playback.commands.length, 1);
  });
  test('offline lyrics exits loading and no network call', () async {
    final c = LyricsController(
      repository: lyricsRepo(policy: const NetworkPolicy.offline()),
      playback: CollectionPlayback(state(1)),
    );
    addTearDown(c.dispose);
    await c.follow();
    expect(c.busy, isFalse);
    expect(c.failure!.code, 'offline_mode');
    expect(transport.requests, isEmpty);
  });
  test('related stale seed stays latest and native identity is unavailable without tuple', () async {
    final old = Completer<ApiResponse>();
    transport = CollectionTransport(
      (r, _) => r.query['seedTrackId'] == 'local-1'
          ? old.future
          : ApiResponse(200, {
              'tracks': [
                {
                  'id': 'vk:1_2',
                  'title': 'Трек',
                  'artist': 'Артист',
                  'duration': 180,
                  'streamSource': 'vk',
                  'album': {'title': 'A'},
                },
              ],
              'artists': [],
              'albums': [],
              'degradedSources': ['vk'],
              'nextCursor': null,
            }),
    );
    final c = RelatedController(
      repository: relatedRepo(),
      playback: CollectionPlayback(state(1)),
    );
    addTearDown(c.dispose);
    final pending = c.open(collectionTrack(1));
    await Future<void>.delayed(Duration.zero);
    await c.open(collectionTrack(2));
    old.complete(
      const ApiResponse(200, {
        'tracks': [],
        'artists': [],
        'albums': [],
        'degradedSources': [],
        'nextCursor': null,
      }),
    );
    await pending;
    expect(c.feed!.tracks.single.ref.identityKey, 'vk:1_2');
    expect(c.feed!.tracks.single.playable, isFalse);
  });
  test('radio seeds use actual GET contracts without POST guess', () async {
    transport = CollectionTransport(
      (r, _) => const ApiResponse(200, {'tracks': [], 'nextCursor': null}),
    );
    final r = radioRepo();
    addTearDown(r.dispose);
    await r.start(RadioSeed.track(collectionTrack(1)));
    await r.start(const RadioSeed.artist('artist-1'));
    await r.start(const RadioSeed.artist('Исполнитель', discoveryArtist: true));
    await r.start(const RadioSeed.playlist('playlist-1'));
    await r.start(
      const RadioSeed.track(
        Track(ref: YoutubeTrackRef('abcdefghijk'), title: 'T', artist: 'A'),
      ),
    );
    expect(transport.requests.map((r) => r.query['type']), [
      'vibe',
      'artist',
      'artist-name',
      'playlist',
      'youtube',
    ]);
    expect(transport.requests.map((r) => r.path), [
      '/api/personalized/radio',
      '/api/personalized/radio',
      '/api/personalized/radio',
      '/api/library/radio',
      '/api/personalized/radio',
    ]);
    expect(transport.requests.every((r) => r.method == ApiMethod.get), isTrue);
  });
  test(
    'history widens snapshot to200 honestly, removed and retired refs remain',
    () async {
      transport = CollectionTransport(
        (r, _) => ApiResponse(
          200,
          r.path.endsWith('summary')
              ? {
                  'allTime': 400,
                  'last7Days': 5,
                  'last30Days': 8,
                  'last365Days': 300,
                }
              : [
                  for (var i = 0; i < int.parse(r.query['limit']!); i++)
                    {
                      'id': 'play-$i',
                      'playedAt': '2026-10-15T10:00:00Z',
                      'source': 'LOCAL',
                      'track': {
                        ...likedDto(i),
                        'source': 'library',
                        if (i == 0)
                          'playback': {
                            'isPlayable': false,
                            'reason': 'track_removed',
                          },
                      },
                    },
                ],
        ),
      );
      final playback = CollectionPlayback(state(1));
      final c = HistoryController(
        repository: historyRepo(),
        playback: playback,
      );
      addTearDown(c.dispose);
      await c.load();
      await c.more();
      await c.more();
      await c.more();
      await c.more();
      expect(c.page!.entries.length, 200);
      expect(c.page!.nextCursor, isNull);
      expect(c.page!.reachedServerLimit, isTrue);
      expect(c.summary!.allTime, 400);
      expect(c.page!.entries.first.track.playable, isFalse);
      expect(
        transport.requests
            .where((r) => r.path == '/api/plays')
            .map((r) => r.query),
        [
          {'limit': '50'},
          {'limit': '100'},
          {'limit': '150'},
          {'limit': '200'},
        ],
      );
      expect(playback.commands, isEmpty);
    },
  );
  Future<void> mount(WidgetTester tester, Widget child) =>
      tester.pumpWidget(MaterialApp(theme: SoundspanTheme.dark(), home: child));
  testWidgets('lyrics sheet has no-track and offline terminal states', (
    tester,
  ) async {
    final playback = CollectionPlayback(QueueSnapshot(fence: collectionFence));
    final c = LyricsController(
      repository: lyricsRepo(policy: const NetworkPolicy.offline()),
      playback: playback,
    );
    addTearDown(c.dispose);
    await mount(tester, LyricsSheet(controller: c));
    await tester.pumpAndSettle();
    expect(find.text('Сейчас ничего не играет'), findsOneWidget);
    playback.value = state(1);
    await c.follow();
    await tester.pumpAndSettle();
    expect(find.textContaining('офлайн'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsNothing);
  });
  testWidgets(
    'radio mount does not create or autoplay and offers explicit generation',
    (tester) async {
      final playback = CollectionPlayback(state(1));
      final c = RadioController(repository: radioRepo(), playback: playback);
      addTearDown(c.dispose);
      await mount(
        tester,
        RadioScreen(controller: c, seed: const RadioSeed.genre('rock')),
      );
      await tester.pumpAndSettle();
      expect(transport.requests, isEmpty);
      expect(playback.commands, isEmpty);
      expect(find.text('Собрать радио'), findsOneWidget);
    },
  );
  testWidgets('history screen shows summary and confirms exact clear range', (
    tester,
  ) async {
    transport = CollectionTransport(
      (r, _) => ApiResponse(
        200,
        r.path == '/api/plays'
            ? []
            : r.path.endsWith('summary')
            ? {
                'allTime': 300,
                'last7Days': 7,
                'last30Days': 30,
                'last365Days': 250,
              }
            : {'success': true, 'range': r.query['range'], 'deletedCount': 1},
      ),
    );
    final c = HistoryController(
      repository: historyRepo(),
      playback: CollectionPlayback(state(1)),
    );
    addTearDown(c.dispose);
    await mount(tester, HistoryScreen(controller: c));
    await tester.pumpAndSettle();
    expect(find.textContaining('300'), findsOneWidget);
    await tester.tap(find.text('Очистить историю'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('За год'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Удалить'));
    await tester.pumpAndSettle();
    expect(
      transport.requests
          .where((r) => r.method == ApiMethod.delete)
          .single
          .query,
      {'range': '365d'},
    );
  });
  testWidgets('related screen contains seed and honest empty state', (
    tester,
  ) async {
    final c = RelatedController(
      repository: relatedRepo(),
      playback: CollectionPlayback(state(1)),
    );
    addTearDown(c.dispose);
    await mount(tester, RelatedSheet(controller: c, track: collectionTrack(1)));
    await tester.pumpAndSettle();
    expect(find.text('Похожие треки пока не найдены'), findsOneWidget);
  });
  Map<String, Object?> playlistReadback({
    List<Map<String, Object?>> tracks = const [],
  }) => {
    'id': 'station',
    'name': 'Радио',
    'totalItemCount': tracks.length,
    'pagination': {'hasMore': false, 'nextCursor': null},
    'mergedItems': [
      for (final (i, t) in tracks.indexed)
        {
          'id': 'item-$i',
          'sort': i,
          'type': 'track',
          'track': {
            ...t,
            'album': {...(t['album'] as Map), 'artist': t['artist']},
          },
          'playback': {'isPlayable': true},
        },
    ],
  };
  test(
    'ambiguous append never replays POST and reconciles GET exact station',
    () async {
      var lost = false;
      transport = CollectionTransport((r, _) {
        if (r.path.endsWith('/append')) {
          lost = true;
          throw StateError('connection lost after server commit');
        }
        if (r.path == '/api/playlists/station') {
          return ApiResponse(
            200,
            playlistReadback(tracks: [likedDto(lost ? 2 : 1)]),
          );
        }
        return const ApiResponse(200, {'playlistId': 'station', 'entries': []});
      });
      final p = CollectionPlayback(state(1));
      final c = RadioController(repository: radioRepo(), playback: p);
      addTearDown(c.dispose);
      c.select(const RadioSeed.genre('rock'));
      await c.generate();
      await c.append();
      expect(c.uncertain, isTrue);
      expect(c.canMutate, isFalse);
      await c.append();
      await c.generate();
      expect(
        transport.requests.where((r) => r.path.endsWith('/append')).length,
        1,
      );
      await c.reconcile();
      expect(c.uncertain, isFalse);
      expect(c.station!.tracks.single.ref, const LibraryTrackRef('local-2'));
      expect(p.commands, isEmpty);
      await c.play();
      final command = p.commands.single as ReplaceQueue;
      expect(command.fence, collectionFence);
      expect(
        command.entries.single.track.ref,
        const LibraryTrackRef('local-2'),
      );
    },
  );
  test(
    'create acknowledged ID survives failed metadata readback for GET recovery',
    () async {
      var fail = true;
      transport = CollectionTransport((r, _) {
        if (r.method == ApiMethod.post) {
          return const ApiResponse(200, {
            'playlistId': 'station',
            'entries': [],
          });
        }
        if (fail) throw StateError('readback failed');
        return ApiResponse(200, playlistReadback(tracks: [likedDto(1)]));
      });
      final c = RadioController(
        repository: radioRepo(),
        playback: CollectionPlayback(state(1)),
      );
      addTearDown(c.dispose);
      c.select(const RadioSeed.genre('rock'));
      await c.generate();
      expect(c.uncertain, isTrue);
      expect(c.canReconcile, isTrue);
      fail = false;
      await c.reconcile();
      expect(c.station!.playlistId, 'station');
      expect(
        transport.requests.where((r) => r.method == ApiMethod.post).length,
        1,
      );
    },
  );
  test(
    'queued play retains captured queue lineage across admission await',
    () async {
      final a = ExtrasAdmissionAuthority();
      authority = a;
      final p = CollectionPlayback(state(1));
      final c = RelatedController(repository: relatedRepo(), playback: p);
      addTearDown(c.dispose);
      a.gate = Completer<void>();
      final pending = c.playTracks([collectionTrack(2)], 0);
      p.value = QueueSnapshot(fence: collectionFence, lineage: 9);
      a.gate!.complete();
      await pending;
      expect(p.commands, isEmpty);
    },
  );
  test(
    'session owner swap retires outstanding loads and mutation targets',
    () async {
      final response = Completer<ApiResponse>();
      transport = CollectionTransport((r, _) => response.future);
      final p = CollectionPlayback(state(1));
      final c = RelatedController(repository: relatedRepo(), playback: p);
      addTearDown(c.dispose);
      final pending = c.open(collectionTrack(1));
      await Future<void>.delayed(Duration.zero);
      final target = c.target([collectionTrack(1)]);
      authority.switchOwner();
      response.complete(
        const ApiResponse(200, {
          'tracks': [],
          'artists': [],
          'albums': [],
          'degradedSources': [],
          'nextCursor': null,
        }),
      );
      await pending;
      expect(c.isCurrent, isFalse);
      expect(c.feed, isNull);
      expect(target.isCurrent, isFalse);
      await expectLater(target.assertCurrent(), throwsA(isA<AppFailure>()));
      await c.playTracks([collectionTrack(1)], 0);
      expect(p.commands, isEmpty);
    },
  );
  testWidgets('Back cancels preadmission clear action without waiting', (
    tester,
  ) async {
    final a = ExtrasAdmissionAuthority();
    authority = a;
    transport = CollectionTransport(
      (r, _) => ApiResponse(
        200,
        r.path.endsWith('summary')
            ? {'allTime': 1, 'last7Days': 1, 'last30Days': 1, 'last365Days': 1}
            : [],
      ),
    );
    final c = HistoryController(
      repository: historyRepo(),
      playback: CollectionPlayback(state(1)),
    );
    addTearDown(c.dispose);
    await mount(tester, HistoryScreen(controller: c));
    await tester.pumpAndSettle();
    a.gate = Completer<void>();
    final pending = c.clear(HistoryRange.all, confirmationRevision: c.revision);
    await tester.pump();
    await tester.tap(find.byTooltip('Назад'));
    await tester.pump();
    a.gate!.complete();
    await pending;
    expect(
      transport.requests.where((r) => r.method == ApiMethod.delete),
      isEmpty,
    );
  });
  testWidgets('history clear cancelled confirmation sends no DELETE', (
    tester,
  ) async {
    transport = CollectionTransport(
      (r, _) => ApiResponse(
        200,
        r.path.endsWith('summary')
            ? {'allTime': 1, 'last7Days': 1, 'last30Days': 1, 'last365Days': 1}
            : [],
      ),
    );
    final c = HistoryController(
      repository: historyRepo(),
      playback: CollectionPlayback(state(1)),
    );
    addTearDown(c.dispose);
    await mount(tester, HistoryScreen(controller: c));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Очистить историю'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('За всё время'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Отмена'));
    await tester.pumpAndSettle();
    expect(
      transport.requests.where((r) => r.method == ApiMethod.delete),
      isEmpty,
    );
  });
  Map<String, Object?> nativeDto(String provider, String id) => {
    'id': '$provider:$id',
    'title': 'Точная запись',
    'duration': 180,
    'trackNo': null,
    'source': provider,
    'streamSource': provider,
    'artist': {'id': null, 'name': 'Исполнитель'},
    'album': {'id': null, 'title': '', 'coverArt': null},
    'provider': {
      'source': provider,
      'providerTrackId': id,
      'youtubeVideoId': null,
      'tidalTrackId': null,
    },
    'musicSourceRecording': {
      'provider': provider,
      'id': id,
      'title': 'Точная запись',
      'artists': ['Исполнитель'],
      'duration': 180,
      'contentVersion': 'clean',
      'preview': false,
      'isrc': 'RUABC1234567',
    },
  };
  test(
    'native radio exact tuples and provenance reach existing playback service',
    () async {
      final row = nativeDto('vk', '-001_002');
      transport = CollectionTransport(
        (r, _) => ApiResponse(200, {
          'tracks': [row],
          'generationId': 'generation-1',
          'nextCursor': 1,
          'degradedSources': [],
        }),
      );
      final p = CollectionPlayback(state(1));
      final c = RadioController(repository: radioRepo(), playback: p);
      addTearDown(c.dispose);
      final exact = radioTrack(row);
      c.select(RadioSeed.track(exact));
      await c.generate();
      expect(transport.requests.single.query['type'], 'vk');
      expect(transport.requests.single.query['value'], '-001_002');
      expect(p.commands, isEmpty);
      await c.play();
      final entry = (p.commands.single as ReplaceQueue).entries.single;
      expect(
        (entry.track.ref as NativeTrackRef).recording.toJson(),
        row['musicSourceRecording'],
      );
      expect(entry.context.recommendationGenerationId, 'generation-1');
    },
  );
  test(
    'history retains exact native and retired, removed and missing entries',
    () async {
      transport = CollectionTransport(
        (r, _) => ApiResponse(200, [
          {
            'id': 'native',
            'playedAt': '2026-10-15T12:00:00Z',
            'track': nativeDto('yandex', '0007'),
          },
          {
            'id': 'retired',
            'playedAt': '2026-10-15T12:00:00Z',
            'track': {
              ...likedDto(2),
              'filePath': null,
              'id': 'tidal:7',
              'source': 'tidal',
              'streamSource': 'tidal',
              'provider': {'tidalTrackId': '7'},
            },
          },
          {'id': 'missing', 'playedAt': '2026-10-15T12:00:00Z', 'track': null},
        ]),
      );
      final r = historyRepo();
      addTearDown(r.dispose);
      final page = await r.page();
      expect(page.entries.length, 3);
      expect(
        (page.entries.first.track.ref as NativeTrackRef).recording.id,
        '0007',
      );
      expect(page.entries[1].track.ref, isA<UnavailableTrackRef>());
      expect(page.entries[2].track.ref.identityKey, 'history:missing');
    },
  );
  test('related actual youtube/local IDs and unsupported native never fall back to lookalike', () {
    final youtube = relatedTrack({
      'id': 'yt:abcdefghijk',
      'title': 'Песня',
      'artist': 'Артист',
      'streamSource': 'youtube',
      'youtubeVideoId': 'abcdefghijk',
      'inLibrary': false,
      'album': {'title': 'Single'},
    });
    final local = relatedTrack({
      'id': 'db-id',
      'title': 'Песня',
      'artist': 'Артист',
      'streamSource': 'library',
      'inLibrary': false,
      'album': {'title': 'Single'},
    });
    final unknown = relatedTrack({
      'id': 'mystery',
      'title': 'Песня',
      'artist': 'Артист',
      'inLibrary': false,
      'album': {'title': 'Single'},
    });
    expect(youtube.ref, const YoutubeTrackRef('abcdefghijk'));
    expect(local.ref, const LibraryTrackRef('db-id'));
    expect(unknown.playable, isFalse);
  });
  test(
    'unknown create outcome remains blocked and has no replay/readback fiction',
    () async {
      transport = CollectionTransport(
        (r, _) => throw StateError('lost response'),
      );
      final c = RadioController(
        repository: radioRepo(),
        playback: CollectionPlayback(state(1)),
      );
      addTearDown(c.dispose);
      c.select(const RadioSeed.genre('rock'));
      await c.generate();
      await c.generate();
      await c.reconcile();
      expect(c.uncertain, isTrue);
      expect(c.canReconcile, isFalse);
      expect(transport.requests.length, 1);
      expect(transport.requests.single.method, ApiMethod.post);
    },
  );
  test(
    'latest radio seed wins and opening seed never changes current queue',
    () async {
      final first = Completer<ApiResponse>();
      transport = CollectionTransport(
        (r, _) => r.query['value'] == 'first'
            ? first.future
            : ApiResponse(200, {
                'tracks': [nativeDto('yandex', '7')],
                'nextCursor': null,
              }),
      );
      final p = CollectionPlayback(state(1));
      final c = RadioController(repository: radioRepo(), playback: p);
      addTearDown(c.dispose);
      c.select(const RadioSeed.artist('first'));
      final old = c.generate();
      await Future<void>.delayed(Duration.zero);
      c.select(const RadioSeed.artist('second'));
      await c.generate();
      first.complete(
        const ApiResponse(200, {'tracks': [], 'nextCursor': null}),
      );
      await old;
      expect(c.station!.tracks.single.ref.identityKey, 'yandex:7');
      expect(p.commands, isEmpty);
    },
  );
  for (final content in ['plain', 'missing', 'error']) {
    testWidgets('lyrics renders $content without stuck loading', (
      tester,
    ) async {
      transport = CollectionTransport(
        (r, _) => content == 'error'
            ? const ApiResponse(503, null)
            : ApiResponse(200, {
                'plainLyrics': content == 'plain'
                    ? 'Первая строка\nВторая строка'
                    : null,
                'syncedLyrics': null,
                'synced': false,
                'source': content == 'plain' ? 'lrclib' : 'none',
              }),
      );
      final c = LyricsController(
        repository: lyricsRepo(),
        playback: CollectionPlayback(state(1)),
      );
      addTearDown(c.dispose);
      await mount(tester, LyricsSheet(controller: c));
      await tester.pumpAndSettle();
      expect(c.busy, isFalse);
      expect(find.byType(LinearProgressIndicator), findsNothing);
      if (content == 'plain') {
        expect(find.byType(SelectableText), findsOneWidget);
      }
      if (content == 'missing') {
        expect(find.text('Текст песни пока не найден'), findsOneWidget);
      }
      if (content == 'error') expect(find.text('Повторить'), findsOneWidget);
    });
  }
  test('radio starts first playable row and each queue occurrence keeps own generation', () async {
    var page = 0;
    transport = CollectionTransport(
      (r, _) => ApiResponse(200, {
        'tracks': page == 0
            ? [
                {...nativeDto('vk', '1_2'), 'source': 'vk'},
              ]
            : [nativeDto('yandex', '7')],
        'nextCursor': page++ == 0 ? 1 : null,
        'generationId': page == 1 ? 'first-gen' : 'second-gen',
        'degradedSources': [],
      }),
    );
    final p = CollectionPlayback(state(1));
    final c = RadioController(repository: radioRepo(), playback: p);
    addTearDown(c.dispose);
    c.select(RadioSeed.track(collectionTrack(1)));
    await c.generate();
    await c.more();
    await c.play();
    final entries = (p.commands.single as ReplaceQueue).entries;
    expect(entries.map((e) => e.context.recommendationGenerationId), [
      'first-gen',
      'second-gen',
    ]);
    expect(entries.map((e) => e.track.ref.identityKey), ['vk:1_2', 'yandex:7']);
  });
  test('radio primary play skips unavailable first row without dropping display row', () async {
    transport = CollectionTransport(
      (r, _) => ApiResponse(200, {
        'tracks': [
          {
            ...likedDto(1),
            'filePath': null,
            'id': 'tidal:1',
            'source': 'tidal',
            'provider': {'tidalTrackId': '1'},
          },
          {...likedDto(2), 'source': 'library'},
        ],
        'nextCursor': null,
      }),
    );
    final p = CollectionPlayback(state(1));
    final c = RadioController(repository: radioRepo(), playback: p);
    addTearDown(c.dispose);
    c.select(RadioSeed.track(collectionTrack(1)));
    await c.generate();
    await c.play();
    expect(c.station!.tracks.length, 2);
    expect(p.commands, isNotEmpty);
    expect(
      (p.commands.single as ReplaceQueue).entries.single.track.ref,
      const LibraryTrackRef('local-2'),
    );
  });
  testWidgets(
    'four extras layouts fit narrow/landscape text scale2 and large data is lazy',
    (tester) async {
      transport = CollectionTransport((r, _) {
        if (r.path.startsWith('/api/lyrics/')) {
          return const ApiResponse(200, {
            'plainLyrics': null,
            'syncedLyrics': '[00:01.00] Очень длинная русская строка песни и продолжение строки',
            'synced': true,
            'source': 'lrclib',
          });
        }
        if (r.path == '/api/player/related') {
          return ApiResponse(200, {
            'tracks': [
              for (var i = 0; i < 25; i++)
                {
                  'id': 'l-$i',
                  'title': collectionTrack(i).title,
                  'artist': collectionTrack(i).artist,
                  'streamSource': 'library',
                  'album': {'title': 'Альбом'},
                },
            ],
            'artists': [
              {
                'name': 'Очень длинное имя исполнителя без namespace',
                'providerId': 'opaque',
              },
            ],
            'albums': [],
            'degradedSources': ['a'],
            'nextCursor': null,
          });
        }
        if (r.path == '/api/plays/summary') {
          return const ApiResponse(200, {
            'allTime': 300,
            'last7Days': 7,
            'last30Days': 30,
            'last365Days': 250,
          });
        }
        if (r.path == '/api/plays') {
          return ApiResponse(200, [
            for (var i = 0; i < 50; i++)
              {
                'id': 'h-$i',
                'playedAt': '2026-10-15T12:00:00Z',
                'track': likedDto(i),
              },
          ]);
        }
        return const ApiResponse(200, {'tracks': [], 'nextCursor': null});
      });
      final p = CollectionPlayback(state(1));
      final l = LyricsController(repository: lyricsRepo(), playback: p),
          r = RelatedController(repository: relatedRepo(), playback: p),
          radio = RadioController(repository: radioRepo(), playback: p),
          h = HistoryController(repository: historyRepo(), playback: p);
      addTearDown(l.dispose);
      addTearDown(r.dispose);
      addTearDown(radio.dispose);
      addTearDown(h.dispose);
      addTearDown(() => tester.view.resetPhysicalSize());
      addTearDown(() => tester.view.resetDevicePixelRatio());
      tester.view.devicePixelRatio = 1;
      for (final size in [
        const Size(320, 720),
        const Size(390, 844),
        const Size(430, 932),
        const Size(640, 360),
      ]) {
        tester.view.physicalSize = size;
        for (final child in [
          LyricsSheet(controller: l),
          RelatedSheet(controller: r, track: collectionTrack(1)),
          RadioScreen(
            controller: radio,
            seed: RadioSeed.track(collectionTrack(1)),
          ),
          HistoryScreen(controller: h),
        ]) {
          await tester.pumpWidget(
            MaterialApp(
              theme: SoundspanTheme.dark(),
              builder: (context, widget) => MediaQuery(
                data: MediaQuery.of(context).copyWith(
                  textScaler: const TextScaler.linear(2),
                  disableAnimations: true,
                ),
                child: widget!,
              ),
              home: child,
            ),
          );
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull, reason: '$size $child');
          await tester.drag(find.byType(ListView).first, const Offset(0, -600));
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull);
        }
      }
    },
  );
  test(
    'history known refusal is not presented as an uncertain delete',
    () async {
      transport = CollectionTransport((r, _) => const ApiResponse(403, null));
      final c = HistoryController(
        repository: historyRepo(),
        playback: CollectionPlayback(state(1)),
      );
      addTearDown(c.dispose);
      await c.clear(HistoryRange.all, confirmationRevision: c.revision);
      expect(c.uncertain, isFalse);
      expect(c.failure!.statusCode, 403);
    },
  );
  test(
    'history acknowledged clear retains honest result when GET readback fails',
    () async {
      transport = CollectionTransport(
        (r, _) => r.method == ApiMethod.delete
            ? ApiResponse(200, {
                'success': true,
                'range': r.query['range'],
                'deletedCount': 9,
              })
            : throw StateError('readback lost'),
      );
      final c = HistoryController(
        repository: historyRepo(),
        playback: CollectionPlayback(state(1)),
      );
      addTearDown(c.dispose);
      await c.clear(HistoryRange.all, confirmationRevision: c.revision);
      expect(c.uncertain, isTrue);
      expect(c.message, contains('9'));
      expect(c.message, contains('обновить'));
    },
  );
  testWidgets('radio offers working genre decade and quick station selection', (
    tester,
  ) async {
    final c = RadioController(
      repository: radioRepo(),
      playback: CollectionPlayback(state(1)),
    );
    addTearDown(c.dispose);
    await mount(tester, RadioScreen(controller: c));
    await tester.pumpAndSettle();
    expect(find.text('Открытия'), findsOneWidget);
    expect(find.text('1990-е'), findsOneWidget);
    await tester.ensureVisible(find.text('1990-е'));
    await tester.tap(find.text('1990-е'));
    await tester.pumpAndSettle();
    expect(c.seed!.kind, RadioSeedKind.decade);
    expect(c.seed!.value, '1990');
    expect(transport.requests, isEmpty);
  });
  for (final operation in ['append', 'regenerate']) {
    for (final status in [403, 404, 429]) {
      test(
        'acknowledged $operation keeps ID and blocks replay after GET$status',
        () async {
          var acknowledged = false, restored = false;
          transport = CollectionTransport((r, _) {
            if (r.path.endsWith('/$operation')) {
              acknowledged = true;
              return const ApiResponse(200, {
                'playlistId': 'station',
                'entries': [],
              });
            }
            if (r.path == '/api/playlists/station') {
              return acknowledged && !restored
                  ? ApiResponse(status, null)
                  : ApiResponse(
                      200,
                      playlistReadback(tracks: [likedDto(restored ? 2 : 1)]),
                    );
            }
            return const ApiResponse(200, {
              'playlistId': 'station',
              'entries': [],
            });
          });
          final playback = CollectionPlayback(state(1));
          final c = RadioController(
            repository: radioRepo(),
            playback: playback,
          );
          addTearDown(c.dispose);
          c.select(const RadioSeed.genre('rock'));
          await c.generate();
          if (operation == 'append') {
            await c.append();
          } else {
            await c.regenerate();
          }
          expect(c.uncertain, isTrue);
          expect(c.canMutate, isFalse);
          expect(c.canReconcile, isTrue);
          expect(c.failure, isA<RadioReadbackFailure>());
          expect((c.failure as RadioReadbackFailure).playlistId, 'station');
          await c.append();
          await c.regenerate();
          await c.generate();
          expect(
            transport.requests.where((r) => r.method == ApiMethod.post).length,
            2,
          );
          await c.reconcile();
          expect(c.uncertain, isTrue);
          restored = true;
          await c.reconcile();
          expect(c.uncertain, isFalse);
          expect(
            c.station!.tracks.single.ref,
            const LibraryTrackRef('local-2'),
          );
          expect(
            transport.requests.where((r) => r.method == ApiMethod.post).length,
            2,
          );
          expect(playback.commands, isEmpty);
        },
      );
      test(
        '$operation POST$status is a known refusal without readback or uncertainty',
        () async {
          transport = CollectionTransport((r, _) {
            if (r.path.endsWith('/$operation')) {
              return ApiResponse(status, null);
            }
            if (r.path == '/api/playlists/station') {
              return ApiResponse(200, playlistReadback());
            }
            return const ApiResponse(200, {
              'playlistId': 'station',
              'entries': [],
            });
          });
          final c = RadioController(
            repository: radioRepo(),
            playback: CollectionPlayback(state(1)),
          );
          addTearDown(c.dispose);
          c.select(const RadioSeed.genre('rock'));
          await c.generate();
          if (operation == 'append') {
            await c.append();
          } else {
            await c.regenerate();
          }
          expect(c.uncertain, isFalse);
          expect(c.failure!.statusCode, status);
          expect(
            transport.requests.where((r) => r.method == ApiMethod.get).length,
            1,
          );
        },
      );
    }
  }
  for (final filtered in [0, 1, 49]) {
    test(
      'filtered history window length$filtered can still expand through rawcap200',
      () async {
        transport = CollectionTransport(
          (r, _) => ApiResponse(
            200,
            r.path.endsWith('summary')
                ? {
                    'allTime': 250,
                    'last7Days': 5,
                    'last30Days': 25,
                    'last365Days': 200,
                  }
                : [
                    for (
                      var i = 0;
                      i < (int.parse(r.query['limit']!) - 50 + filtered);
                      i++
                    )
                      {
                        'id': 'play-$i',
                        'playedAt': '2026-10-15T12:00:00Z',
                        'track': likedDto(i),
                      },
                  ],
          ),
        );
        final c = HistoryController(
          repository: historyRepo(),
          playback: CollectionPlayback(state(1)),
        );
        addTearDown(c.dispose);
        await c.load();
        expect(c.page!.entries.length, filtered);
        for (var i = 0; i < 5; i++) {
          await c.more();
        }
        expect(c.page!.requestedLimit, 200);
        expect(c.page!.entries.length, 150 + filtered);
        expect(c.page!.nextCursor, isNull);
        expect(c.page!.reachedServerLimit, isTrue);
        expect(
          transport.requests
              .where((r) => r.path == '/api/plays')
              .map((r) => r.query['limit']),
          ['50', '100', '150', '200'],
        );
      },
    );
  }
  testWidgets(
    'history cap names raw window rather than claiming 200 visible rows',
    (tester) async {
      transport = CollectionTransport(
        (r, _) => ApiResponse(
          200,
          r.path.endsWith('summary')
              ? {
                  'allTime': 250,
                  'last7Days': 5,
                  'last30Days': 25,
                  'last365Days': 200,
                }
              : [
                  for (var i = 0; i < int.parse(r.query['limit']!) - 1; i++)
                    {
                      'id': 'play-$i',
                      'playedAt': '2026-10-15T12:00:00Z',
                      'track': likedDto(i),
                    },
                ],
        ),
      );
      final c = HistoryController(
        repository: historyRepo(),
        playback: CollectionPlayback(state(1)),
      );
      addTearDown(c.dispose);
      await mount(tester, HistoryScreen(controller: c));
      await tester.pumpAndSettle();
      await c.more();
      await c.more();
      await c.more();
      await tester.pumpAndSettle();
      expect(find.textContaining('Окно последних 200 записей'), findsOneWidget);
      expect(
        find.textContaining('Показаны последние 200 записей'),
        findsNothing,
      );
    },
  );
}
