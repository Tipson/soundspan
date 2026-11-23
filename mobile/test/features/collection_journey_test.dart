import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/design_system/design_system.dart';
import 'package:soundspan/features/library/library_models.dart';
import 'package:soundspan/features/library/library_repository.dart';
import 'package:soundspan/features/library/library_controller.dart';
import 'package:soundspan/features/library/library_screen.dart';
import 'package:soundspan/features/likes/likes_models.dart';
import 'package:soundspan/features/likes/likes_repository.dart';
import 'package:soundspan/features/likes/likes_controller.dart';
import 'package:soundspan/features/likes/likes_screen.dart';
import 'package:soundspan/features/likes/preference_controller.dart';
import 'package:soundspan/playback/playback_controller.dart';

import '../support/collection_fixtures.dart';

void main() {
  late CollectionAuthority authority;
  setUp(() => authority = CollectionAuthority());
  tearDown(() => authority.updates.close());
  LikesRepository likes(CollectionTransport transport) => LikesRepository(
    transport: transport,
    authority: authority,
    fence: collectionFence,
  );
  LibraryRepository library(CollectionTransport transport) => LibraryRepository(
    transport: transport,
    authority: authority,
    fence: collectionFence,
  );
  PreferenceController preferences(
    CollectionTransport transport, {
    PlaybackController? playback,
    NetworkPolicy networkPolicy = const NetworkPolicy.online(),
  }) => PreferenceController(
    transport: transport,
    authority: authority,
    fence: collectionFence,
    playback: playback,
    networkPolicy: networkPolicy,
  );

  test('cold restored locally validated session loads likes with reachable transport', () async {
    authority.restoreLocally();
    final transport = CollectionTransport(
      (r, f) => likedResponse([likedDto(1)]),
    );
    final page = await likes(transport).page(null);
    expect(page.tracks.single.ref, const LibraryTrackRef('local-1'));
    expect(transport.fences, [collectionFence]);
  });

  test('cold restored locally validated session reads and mutates saved collection', () async {
    authority.restoreLocally();
    final transport = CollectionTransport((r, f) {
      if (r.method == ApiMethod.put) {
        return const ApiResponse(200, {'saved': true});
      }
      if (r.path == '/api/playlists') return const ApiResponse(200, []);
      return const ApiResponse(200, {'items': [], 'total': 0});
    });
    final repo = library(transport);
    expect(repo.canMutate, true);
    expect((await repo.load()).degraded, false);
    expect(
      await repo.save(
        const SavedEntityRef(
          kind: SavedEntityKind.album,
          source: 'library',
          entityId: 'album',
          title: 'Альбом',
        ),
        true,
      ),
      true,
    );
    expect(transport.requests.length, 3);
    expect(transport.fences, everyElement(collectionFence));
  });

  test('cold restored locally validated session reads and mutates shared preferences', () async {
    authority.restoreLocally();
    final transport = CollectionTransport(
      (r, f) => preferenceResponse(
        'db',
        r.method == ApiMethod.get ? 'clear' : 'thumbs_up',
      ),
    );
    final controller = preferences(transport);
    addTearDown(controller.dispose);
    const ref = LibraryTrackRef('db');
    expect(controller.canMutate, true);
    await controller.load(ref);
    await controller.set(ref, PreferenceSignal.like);
    expect(controller.current(ref).signal, PreferenceSignal.like);
    expect(transport.requests.length, 2);
    expect(transport.fences, everyElement(collectionFence));
  });

  test('explicit offline policy blocks every collection network boundary with zero HTTP', () async {
    final transport = CollectionTransport(
      (r, f) => throw StateError('offline policy admitted network'),
    );
    const policy = NetworkPolicy.offline();
    final liked = LikesRepository(
      transport: transport,
      authority: authority,
      fence: collectionFence,
      networkPolicy: policy,
    );
    final saved = LibraryRepository(
      transport: transport,
      authority: authority,
      fence: collectionFence,
      networkPolicy: policy,
    );
    final pref = preferences(transport, networkPolicy: policy);
    addTearDown(pref.dispose);
    final failure = isA<AppFailure>().having(
      (e) => e.code,
      'offline code',
      'offline_mode',
    );
    const entity = SavedEntityRef(
      kind: SavedEntityKind.album,
      source: 'library',
      entityId: 'album',
      title: 'Альбом',
    );
    await expectLater(liked.page(null), throwsA(failure));
    final collection = await saved.load();
    expect(collection.savedFailure, failure);
    expect(collection.playlistsFailure, failure);
    await expectLater(saved.status(entity), throwsA(failure));
    await expectLater(saved.save(entity, true), throwsA(failure));
    await expectLater(pref.load(const LibraryTrackRef('db')), throwsA(failure));
    await expectLater(
      pref.set(const LibraryTrackRef('db'), PreferenceSignal.like),
      throwsA(failure),
    );
    expect(saved.canMutate, false);
    expect(pref.canMutate, false);
    expect(transport.requests, isEmpty);
  });

  test(
    '501 likes preserve opaque two-field cursors, complete ordered list',
    () async {
      final transport = CollectionTransport((request, fence) {
        final offset = request.query.containsKey('cursorTrackId')
            ? int.parse(request.query['cursorTrackId']!.split('/').last)
            : 0;
        if (offset > 0) {
          expect(request.query['cursorLikedAt'], '2026-10-15T00:00:00.001Z');
        }
        final end = (offset + 100).clamp(0, 501);
        return likedResponse(
          [for (var i = offset; i < end; i++) likedDto(i)],
          total: 501,
          cursor: end < 501
              ? {
                  'likedAt': '2026-10-15T00:00:00.001Z',
                  'trackId': 'remote:opaque:%2F/+/=$end/$end',
                }
              : null,
        );
      });
      final controller = LikesController(repository: likes(transport));
      addTearDown(controller.dispose);
      await controller.refresh();
      while (controller.state.hasMore) {
        await controller.loadMore();
      }
      expect(controller.state.tracks.length, 501);
      expect(
        controller.state.tracks.last.ref,
        const LibraryTrackRef('local-500'),
      );
      expect(transport.requests.length, 6);
      expect(transport.fences, everyElement(collectionFence));
      expect(
        transport.requests[1].query['cursorTrackId'],
        'remote:opaque:%2F/+/=100/100',
      );
    },
  );

  test(
    'native, YouTube and library use exact existing preference payloads',
    () async {
      final recording = MusicRecording(
        provider: NativeMusicProvider.vk,
        id: '-123_456',
        title: 'Запись',
        artists: ['Артист'],
        durationSeconds: 180,
        contentVersion: MusicContentVersion.explicit,
      );
      final transport = CollectionTransport(
        (request, fence) => preferenceResponse(
          Uri.decodeComponent(request.path.split('/')[4]),
          request.body!['signal'] as String,
        ),
      );
      final controller = preferences(transport);
      addTearDown(controller.dispose);
      for (final ref in [
        NativeTrackRef(recording),
        const YoutubeTrackRef('aB_123-x'),
        const LibraryTrackRef('db-id'),
      ]) {
        await controller.set(ref, PreferenceSignal.like);
      }
      expect(transport.requests.map((r) => r.path), [
        '/api/library/remote-tracks/vk%3A-123_456/preference',
        '/api/library/remote-tracks/yt%3AaB_123-x/preference',
        '/api/library/tracks/db-id/preference',
      ]);
      expect(
        transport.requests.map((r) => r.body),
        everyElement({'signal': 'thumbs_up'}),
      );
      expect(transport.fences, everyElement(collectionFence));
    },
  );

  test(
    'rapid signals serialize server writes and keep latest displayed intent',
    () async {
      final gates = <Completer<ApiResponse>>[];
      final transport = CollectionTransport((r, f) {
        final gate = Completer<ApiResponse>();
        gates.add(gate);
        return gate.future;
      });
      final controller = preferences(transport);
      addTearDown(controller.dispose);
      const ref = LibraryTrackRef('db');
      controller.seed(ref, PreferenceSignal.clear);
      final a = controller.set(ref, PreferenceSignal.like);
      final b = controller.set(ref, PreferenceSignal.dislike);
      final c = controller.set(ref, PreferenceSignal.clear);
      await Future<void>.delayed(Duration.zero);
      expect(gates.length, 1);
      expect(controller.current(ref).signal, PreferenceSignal.clear);
      gates[0].complete(preferenceResponse('db', 'thumbs_up'));
      await a;
      await Future<void>.delayed(Duration.zero);
      expect(gates.length, 2);
      expect(controller.current(ref).signal, PreferenceSignal.clear);
      gates[1].complete(preferenceResponse('db', 'thumbs_down'));
      await b;
      await Future<void>.delayed(Duration.zero);
      gates[2].complete(preferenceResponse('db', 'clear'));
      await c;
      expect(transport.requests.map((r) => r.body!['signal']), [
        'thumbs_up',
        'thumbs_down',
        'clear',
      ]);
      expect(controller.current(ref).signal, PreferenceSignal.clear);
      expect(controller.current(ref).pending, false);
    },
  );

  test('failed mutation rolls back to confirmed state with visible error, no retry', () async {
    final transport = CollectionTransport((r, f) => const ApiResponse(503, {}));
    final controller = preferences(transport);
    addTearDown(controller.dispose);
    const ref = LibraryTrackRef('db');
    controller.seed(ref, PreferenceSignal.like);
    await expectLater(
      controller.set(ref, PreferenceSignal.clear),
      throwsA(isA<AppFailure>()),
    );
    expect(controller.current(ref).signal, PreferenceSignal.like);
    expect(controller.current(ref).failure, isNotNull);
    expect(transport.requests.length, 1);
  });

  test('account switch rejects pending page and mutation, clears old owner instantly', () async {
    final pageGate = Completer<ApiResponse>();
    final mutationGate = Completer<ApiResponse>();
    final transport = CollectionTransport(
      (r, f) =>
          r.method == ApiMethod.get ? pageGate.future : mutationGate.future,
    );
    final controller = LikesController(repository: likes(transport));
    addTearDown(controller.dispose);
    final pref = preferences(transport);
    addTearDown(pref.dispose);
    const ref = LibraryTrackRef('db');
    pref.seed(ref, PreferenceSignal.like);
    final page = controller.refresh();
    final mutation = pref.set(ref, PreferenceSignal.clear);
    final rejected = expectLater(mutation, throwsA(isA<AppFailure>()));
    authority.switchOwner();
    expect(controller.state.tracks, isEmpty);
    expect(pref.current(ref).signal, isNull);
    pageGate.complete(likedResponse([likedDto(1)]));
    mutationGate.complete(preferenceResponse('db', 'clear'));
    await page;
    await rejected;
    expect(controller.state.tracks, isEmpty);
    expect(pref.current(ref).signal, isNull);
  });

  test('current dislike explicitly advances once even repeat-one', () async {
    final track = collectionTrack(1);
    final playback = CollectionPlayback(
      QueueSnapshot(
        entries: [
          QueueEntry(
            entryId: 'current',
            track: track,
            context: const PlayContext(surface: PlaySurface.library),
          ),
        ],
        currentEntryId: 'current',
        fence: collectionFence,
        repeat: QueueRepeat.one,
      ),
    );
    final gate = Completer<ApiResponse>();
    final controller = preferences(
      CollectionTransport((r, f) => gate.future),
      playback: playback,
    );
    addTearDown(controller.dispose);
    final result = controller.set(track.ref, PreferenceSignal.dislike);
    await Future<void>.delayed(Duration.zero);
    expect(playback.commands.whereType<Next>().length, 1);
    gate.complete(preferenceResponse('local-1', 'thumbs_down'));
    await result;
    expect(playback.commands.whereType<Next>().length, 1);
  });

  test('late dislike response never skips newly selected entry', () async {
    final gate = Completer<ApiResponse>();
    final playback = CollectionPlayback(QueueSnapshot(fence: collectionFence));
    final controller = preferences(
      CollectionTransport((r, f) => gate.future),
      playback: playback,
    );
    addTearDown(controller.dispose);
    final result = controller.set(
      const LibraryTrackRef('old'),
      PreferenceSignal.dislike,
    );
    playback.value = QueueSnapshot(
      entries: [
        QueueEntry(
          entryId: 'new',
          track: collectionTrack(2),
          context: const PlayContext(surface: PlaySurface.library),
        ),
      ],
      currentEntryId: 'new',
      fence: collectionFence,
    );
    gate.complete(preferenceResponse('old', 'thumbs_down'));
    await result;
    expect(playback.commands, isEmpty);
  });

  test('saved album is independent from liked or downloaded and uses exact identity', () async {
    const ref = SavedEntityRef(
      kind: SavedEntityKind.album,
      source: 'yandex',
      entityId: '123:opaque',
      title: 'Альбом',
    );
    final transport = CollectionTransport(
      (r, f) => ApiResponse(200, {'saved': r.method == ApiMethod.put}),
    );
    final repo = library(transport);
    expect(await repo.save(ref, true), true);
    expect(await repo.status(ref), false);
    expect(await repo.save(ref, false), false);
    expect(
      transport.requests.map((r) => r.path),
      everyElement(startsWith('/api/library/saved')),
    );
    expect(transport.requests.first.body, {
      'type': 'album',
      'source': 'yandex',
      'entityId': '123:opaque',
      'title': 'Альбом',
    });
    expect(transport.requests.last.body, {
      'type': 'album',
      'source': 'yandex',
      'entityId': '123:opaque',
    });
  });

  test('duplicate dislike while engine admits a command advances captured entry once', () async {
    final track = collectionTrack(1);
    final playback = CollectionPlayback(
      QueueSnapshot(
        entries: [
          QueueEntry(
            entryId: 'current',
            track: track,
            context: const PlayContext(surface: PlaySurface.library),
          ),
        ],
        currentEntryId: 'current',
        fence: collectionFence,
        repeat: QueueRepeat.one,
      ),
    )..moveOnNext = false;
    final controller = preferences(
      CollectionTransport(
        (r, f) => preferenceResponse('local-1', 'thumbs_down'),
      ),
      playback: playback,
    );
    addTearDown(controller.dispose);
    await Future.wait([
      controller.set(track.ref, PreferenceSignal.dislike),
      controller.set(track.ref, PreferenceSignal.dislike),
    ]);
    expect(playback.commands.whereType<Next>().length, 1);
    final command = playback.commands.single as Next;
    expect(command.expectedEntryId, 'current');
    expect(command.fence, collectionFence);
  });

  test(
    'historical retired like supports clear only without inventing playback',
    () async {
      final transport = CollectionTransport(
        (r, f) => preferenceResponse('tidal:42', 'clear'),
      );
      final controller = preferences(transport);
      addTearDown(controller.dispose);
      const ref = UnavailableTrackRef('tidal:42', reason: 'retired_provider');
      controller.seed(ref, PreferenceSignal.like);
      await controller.set(ref, PreferenceSignal.clear);
      expect(
        transport.requests.single.path,
        '/api/library/remote-tracks/tidal%3A42/preference',
      );
      await expectLater(
        controller.set(ref, PreferenceSignal.like),
        throwsA(isA<AppFailure>()),
      );
      expect(transport.requests.length, 1);
      expect(ref.playable, false);
    },
  );

  test('partial library retry only requests the failed section', () async {
    var savedFails = true;
    final transport = CollectionTransport(
      (r, f) => r.path == '/api/playlists'
          ? const ApiResponse(200, [
              {'id': 'p', 'name': 'Мой плейлист', 'trackCount': 1},
            ])
          : savedFails
          ? const ApiResponse(503, {})
          : const ApiResponse(200, {'items': [], 'total': 0}),
    );
    final controller = LibraryController(repository: library(transport));
    addTearDown(controller.dispose);
    await controller.refresh();
    expect(controller.state.collection.degraded, true);
    expect(controller.state.collection.playlists.single.id, 'p');
    savedFails = false;
    transport.requests.clear();
    await controller.retrySaved();
    expect(transport.requests.map((r) => r.path), ['/api/library/saved']);
    expect(controller.state.collection.degraded, false);
    expect(controller.state.collection.playlists.single.id, 'p');
  });

  test('offline preference rejects without network and preserves shared watch state', () async {
    final transport = CollectionTransport(
      (r, f) => throw StateError('network must not run'),
    );
    final controller = preferences(
      transport,
      networkPolicy: const NetworkPolicy.offline(),
    );
    addTearDown(controller.dispose);
    const ref = LibraryTrackRef('db');
    controller.seed(ref, PreferenceSignal.like);
    final watched = controller.watch(ref);
    var changes = 0;
    watched.addListener(() => changes++);
    await expectLater(
      controller.set(ref, PreferenceSignal.clear),
      throwsA(isA<AppFailure>()),
    );
    expect(controller.current(ref).signal, PreferenceSignal.like);
    expect(transport.requests, isEmpty);
    authority.switchOwner();
    expect(watched.value.signal, isNull);
    expect(changes, 1);
  });

  test('late preference GET cannot overwrite a newer local mutation', () async {
    final gate = Completer<ApiResponse>();
    final controller = preferences(
      CollectionTransport(
        (r, f) => r.method == ApiMethod.get
            ? gate.future
            : preferenceResponse('db', 'thumbs_up'),
      ),
    );
    addTearDown(controller.dispose);
    const ref = LibraryTrackRef('db');
    final read = controller.load(ref);
    await controller.set(ref, PreferenceSignal.like);
    gate.complete(preferenceResponse('db', 'clear'));
    await read;
    expect(controller.current(ref).signal, PreferenceSignal.like);
  });

  for (final width in [320.0, 390.0, 430.0]) {
    for (final scale in [1.0, 2.0]) {
      testWidgets(
        'likes single track ordered play and first overflow $width scale $scale',
        (tester) async {
          tester.view.physicalSize = Size(width, 900);
          tester.view.devicePixelRatio = 1;
          addTearDown(tester.view.resetPhysicalSize);
          addTearDown(tester.view.resetDevicePixelRatio);
          final transport = CollectionTransport(
            (r, f) => likedResponse([
              likedDto(1),
              {
                ...likedDto(2),
                'id': 'tidal:2',
                'filePath': null,
                'source': 'tidal',
              },
              likedDto(3),
            ]),
          );
          final controller = LikesController(repository: likes(transport));
          addTearDown(controller.dispose);
          await controller.refresh();
          final pref = preferences(
            CollectionTransport(
              (r, f) => preferenceResponse('local-1', 'clear'),
            ),
          );
          addTearDown(pref.dispose);
          CollectionPlaybackRequest? played;
          await tester.pumpWidget(
            MaterialApp(
              theme: SoundspanTheme.dark(),
              home: MediaQuery(
                data: MediaQueryData(
                  size: Size(width, 900),
                  textScaler: TextScaler.linear(scale),
                ),
                child: LikesScreen(
                  controller: controller,
                  preferences: pref,
                  onPlay: (request) async {
                    played = request;
                  },
                ),
              ),
            ),
          );
          await tester.pump();
          expect(tester.takeException(), isNull);
          await tester.tap(
            find.byKey(const ValueKey('track-play-library:local-1')),
          );
          await tester.pump();
          expect(played!.tracks.map((t) => t.ref), [
            const LibraryTrackRef('local-1'),
            const LibraryTrackRef('local-3'),
          ]);
          expect(played!.startIndex, 0);
          expect(played!.fence, collectionFence);
          await tester.tap(find.byTooltip('Действия с треком «Песня 1»'));
          await tester.pumpAndSettle();
          expect(find.text('Убрать из любимого'), findsOneWidget);
          expect(tester.takeException(), isNull);
          await tester.tap(find.text('Убрать из любимого'));
          await tester.pumpAndSettle();
          expect(find.text('Песня 1'), findsNothing);
        },
      );
    }
  }

  testWidgets(
    'empty library exposes only injected working collection actions',
    (tester) async {
      final transport = CollectionTransport(
        (r, f) => r.path == '/api/playlists'
            ? const ApiResponse(200, [])
            : const ApiResponse(200, {'items': [], 'total': 0}),
      );
      final controller = LibraryController(repository: library(transport));
      addTearDown(controller.dispose);
      await controller.refresh();
      var likesOpened = 0;
      var created = 0;
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: LibraryScreen(
            controller: controller,
            onOpenLiked: () {
              likesOpened++;
            },
            onCreatePlaylist: () {
              created++;
            },
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await tester.tap(find.text('Любимое'));
      await tester.pump();
      expect(likesOpened, 1);
      await tester.tap(find.byTooltip('Действия с коллекцией'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Создать плейлист').last);
      await tester.pumpAndSettle();
      expect(created, 1);
      expect(find.text('Импортировать плейлист'), findsNothing);
    },
  );

  for (final width in [320.0, 390.0, 430.0]) {
    testWidgets('rich library long Russian rows and filters scale2 at $width', (
      tester,
    ) async {
      tester.view.physicalSize = Size(width, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final title =
          'Очень длинное русское название сохранённого альбома для проверки переноса текста и доступности всех действий на узком телефоне';
      final transport = CollectionTransport(
        (r, f) => r.path == '/api/playlists'
            ? const ApiResponse(200, [
                {
                  'id': 'playlist-exact',
                  'name': 'Длинное русское название моего личного плейлиста',
                  'trackCount': 101,
                },
              ])
            : ApiResponse(200, {
                'items': [
                  {
                    'entityType': 'album',
                    'source': 'yandex',
                    'entityId': '123:opaque',
                    'title': title,
                    'subtitle':
                        'Необыкновенно длинное имя музыкального исполнителя',
                  },
                  {
                    'entityType': 'artist',
                    'source': 'library',
                    'entityId': 'artist-exact',
                    'title': 'Другой исполнитель',
                  },
                ],
                'total': 2,
              }),
      );
      final controller = LibraryController(repository: library(transport));
      addTearDown(controller.dispose);
      await controller.refresh();
      SavedEntityRef? opened;
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: MediaQuery(
            data: MediaQueryData(
              size: Size(width, 900),
              textScaler: TextScaler.linear(2),
            ),
            child: LibraryScreen(
              controller: controller,
              onOpenLiked: () {},
              onOpenEntity: (entity) {
                opened = entity;
              },
              onOpenPlaylist: (id) {},
              autoLoad: false,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await tester.ensureVisible(find.widgetWithText(ChoiceChip, 'Альбомы'));
      await tester.tap(find.widgetWithText(ChoiceChip, 'Альбомы'));
      await tester.pumpAndSettle();
      expect(find.text('Другой исполнитель'), findsNothing);
      expect(
        find.text('Длинное русское название моего личного плейлиста'),
        findsNothing,
      );
      await tester.ensureVisible(find.text(title));
      await tester.tap(find.text(title));
      await tester.pump();
      expect(opened!.entityId, '123:opaque');
      expect(opened!.source, 'yandex');
      await tester.ensureVisible(find.byTooltip('Действия: $title'));
      await tester.tap(find.byTooltip('Действия: $title'));
      await tester.pumpAndSettle();
      expect(find.text('Убрать из моей музыки'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(
        transport.requests.where((r) => r.method == ApiMethod.delete),
        isEmpty,
      );
    });
  }

  testWidgets(
    'only liked track first-item menu and removal reach real empty state',
    (tester) async {
      final controller = LikesController(
        repository: likes(
          CollectionTransport((r, f) => likedResponse([likedDto(1)])),
        ),
      );
      addTearDown(controller.dispose);
      await controller.refresh();
      final pref = preferences(
        CollectionTransport((r, f) => preferenceResponse('local-1', 'clear')),
      );
      addTearDown(pref.dispose);
      CollectionPlaybackRequest? played;
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: LikesScreen(
            controller: controller,
            preferences: pref,
            onPlay: (request) async {
              played = request;
            },
            autoLoad: false,
          ),
        ),
      );
      await tester.tap(
        find.byKey(const ValueKey('track-play-library:local-1')),
      );
      await tester.pump();
      expect(played!.tracks.single.ref, const LibraryTrackRef('local-1'));
      await tester.tap(find.byTooltip('Действия с треком «Песня 1»'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Убрать из любимого'));
      await tester.pumpAndSettle();
      expect(find.text('Здесь будет ваша музыка'), findsOneWidget);
    },
  );

  testWidgets('old library and liked rows disappear on account switch', (
    tester,
  ) async {
    final controller = LikesController(
      repository: likes(
        CollectionTransport((r, f) => likedResponse([likedDto(1)])),
      ),
    );
    addTearDown(controller.dispose);
    await controller.refresh();
    final pref = preferences(
      CollectionTransport((r, f) => preferenceResponse('local-1', 'clear')),
    );
    addTearDown(pref.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: SoundspanTheme.dark(),
        home: LikesScreen(
          controller: controller,
          preferences: pref,
          onPlay: (request) async {},
          autoLoad: false,
        ),
      ),
    );
    expect(find.text('Песня 1'), findsOneWidget);
    authority.switchOwner();
    await tester.pump();
    expect(find.text('Песня 1'), findsNothing);
    expect(
      find.text('Аккаунт изменился. Откройте раздел снова.'),
      findsOneWidget,
    );
  });

  testWidgets(
    'old liked sheet cannot invoke new owner callbacks with old tracks',
    (tester) async {
      final controllerA = LikesController(
        repository: likes(
          CollectionTransport((r, f) => likedResponse([likedDto(1)])),
        ),
      );
      addTearDown(controllerA.dispose);
      await controllerA.refresh();
      final prefA = preferences(
        CollectionTransport((r, f) => preferenceResponse('local-1', 'clear')),
      );
      addTearDown(prefA.dispose);
      var leaked = 0;
      Widget app(LikesController controller, PreferenceController pref) =>
          MaterialApp(
            theme: SoundspanTheme.dark(),
            home: LikesScreen(
              controller: controller,
              preferences: pref,
              onPlay: (r) async {},
              onDownload: (tracks) {
                leaked++;
              },
              autoLoad: false,
            ),
          );
      await tester.pumpWidget(app(controllerA, prefA));
      await tester.tap(find.byTooltip('Действия с треком «Песня 1»'));
      await tester.pumpAndSettle();
      authority.switchOwner();
      final fenceB = authority.requireFence();
      final controllerB = LikesController(
        repository: LikesRepository(
          transport: CollectionTransport((r, f) => likedResponse([])),
          authority: authority,
          fence: fenceB,
        ),
      );
      addTearDown(controllerB.dispose);
      final prefB = PreferenceController(
        transport: CollectionTransport(
          (r, f) => preferenceResponse('local-1', 'clear'),
        ),
        authority: authority,
        fence: fenceB,
      );
      addTearDown(prefB.dispose);
      await tester.pumpWidget(app(controllerB, prefB));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Скачать на устройство'));
      await tester.pumpAndSettle();
      expect(leaked, 0);
    },
  );

  test(
    'late library refresh cannot resurrect successfully removed saved album',
    () async {
      const entity = SavedEntityRef(
        kind: SavedEntityKind.album,
        source: 'library',
        entityId: 'album',
        title: 'Альбом',
      );
      const saved = ApiResponse(200, {
        'items': [
          {
            'entityType': 'album',
            'source': 'library',
            'entityId': 'album',
            'title': 'Альбом',
          },
        ],
        'total': 1,
      });
      final late = Completer<ApiResponse>();
      var initial = true;
      final transport = CollectionTransport((r, f) {
        if (r.method == ApiMethod.delete) {
          return const ApiResponse(200, {'saved': false});
        }
        if (r.path == '/api/playlists') return const ApiResponse(200, []);
        return initial ? saved : late.future;
      });
      final controller = LibraryController(repository: library(transport));
      addTearDown(controller.dispose);
      await controller.refresh();
      initial = false;
      final refresh = controller.refresh();
      await controller.save(entity, false);
      expect(controller.state.collection.saved, isEmpty);
      late.complete(saved);
      await refresh;
      expect(controller.state.collection.saved, isEmpty);
    },
  );
}
