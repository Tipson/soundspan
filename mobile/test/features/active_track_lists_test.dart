import 'dart:async';

import 'package:flutter/material.dart' hide SearchController;
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/design_system/theme.dart';
import 'package:soundspan/design_system/track_row.dart';
import 'package:soundspan/features/album/album_repository.dart';
import 'package:soundspan/features/album/album_screen.dart';
import 'package:soundspan/features/artist/artist_screen.dart';
import 'package:soundspan/features/home/home_controller.dart';
import 'package:soundspan/features/home/home_models.dart';
import 'package:soundspan/features/home/home_repository.dart';
import 'package:soundspan/features/home/mix_screen.dart';
import 'package:soundspan/features/library/library_models.dart';
import 'package:soundspan/features/search/catalog_detail_controller.dart';
import 'package:soundspan/features/search/catalog_models.dart';
import 'package:soundspan/features/search/search_controller.dart';
import 'package:soundspan/features/search/search_repository.dart';
import 'package:soundspan/features/search/search_screen.dart';
import 'package:soundspan/playback/playback_controller.dart';

import '../support/collection_fixtures.dart';

enum _Surface { search, mix, artist, album }

final _tracks = [
  for (final i in [1, 2])
    Track(ref: LibraryTrackRef('local-$i'), title: 'Трек $i', artist: 'Артист'),
];

class _Playback extends CollectionPlayback {
  _Playback() : super(QueueSnapshot());
  final updates = StreamController<QueueSnapshot>.broadcast(sync: true);
  @override
  Stream<QueueSnapshot> get snapshots => updates.stream;
  void publish(
    Track track, {
    PlaybackProcessing processing = PlaybackProcessing.ready,
    bool playing = true,
    SessionFence? fence,
  }) {
    final entry = QueueEntry(
      entryId: 'active',
      track: track,
      context: const PlayContext(surface: PlaySurface.library),
    );
    value = QueueSnapshot(
      entries: [entry],
      effectiveOrder: ['active'],
      currentEntryId: 'active',
      fence: fence ?? collectionFence,
      processing: processing,
      playingIntent: playing,
    );
    updates.add(value);
  }
}

class _Harness {
  _Harness(this.screen, this.dispose);
  final Widget Function(PlaybackController playback) screen;
  final VoidCallback dispose;
}

Future<_Harness> _harness(
  _Surface surface,
  CollectionAuthority authority,
  List<CollectionPlaybackRequest> played,
) async {
  final transport = CollectionTransport((request, _) {
    return ApiResponse(200, switch (request.path) {
      '/api/search' => {
        'tracks': [
          for (final i in [1, 2])
            {
              'id': 'local-$i',
              'title': 'Трек $i',
              'source': 'local',
              'album': {
                'title': 'Альбом',
                'artist': {'name': 'Артист'},
              },
            },
        ],
        'artists': [],
        'albums': [],
      },
      '/api/search/discover' => {'results': []},
      _ => {'tracks': [], 'unavailable': []},
    });
  });
  void play(CollectionPlaybackRequest request) => played.add(request);
  if (surface == _Surface.search) {
    final controller = SearchController(
      repository: SearchRepository(
        transport: transport,
        authority: authority,
        fence: collectionFence,
        networkPolicy: const NetworkPolicy.online(),
      ),
    );
    await controller.submit('Трек');
    return _Harness(
      (playback) => SearchScreen(
        controller: controller,
        playback: playback,
        onPlay: play,
      ),
      controller.dispose,
    );
  }
  if (surface == _Surface.mix) {
    final controller = HomeController(
      repository: HomeRepository(
        transport: transport,
        authority: authority,
        fence: collectionFence,
      ),
      request: HomeRequest(
        localHour: 12,
        timezoneOffsetMinutes: 180,
        autoPlaylists: true,
        discovery: true,
      ),
    );
    final mix = MusicMix(
      id: 'daily',
      title: 'Микс',
      description: 'Музыка для вас',
      kind: MusicMixKind.daily,
      tracks: _tracks,
    );
    return _Harness(
      (playback) => MixScreen(
        controller: controller,
        mix: mix,
        playback: playback,
        onPlay: play,
      ),
      controller.dispose,
    );
  }
  final entity = CatalogEntityRef(
    kind: surface == _Surface.artist
        ? CatalogEntityKind.artist
        : CatalogEntityKind.album,
    source: CatalogSource.library,
    id: 'entity',
    name: 'Музыка',
  );
  final controller = CatalogDetailController(
    repository: AlbumRepository(
      transport: transport,
      authority: authority,
      fence: collectionFence,
      networkPolicy: const NetworkPolicy.online(),
    ),
    loadDetail: (_) async => CatalogDetail(ref: entity, tracks: _tracks),
  );
  await controller.open(entity);
  return _Harness(
    (playback) => surface == _Surface.artist
        ? ArtistScreen(
            controller: controller,
            entity: entity,
            playback: playback,
            autoLoad: false,
            onPlay: play,
          )
        : AlbumScreen(
            controller: controller,
            entity: entity,
            playback: playback,
            autoLoad: false,
            onPlay: play,
          ),
    controller.dispose,
  );
}

Finder _row(int i) =>
    find.ancestor(of: find.text('Трек $i'), matching: find.byType(TrackRow));
Finder _status(int i, String status) =>
    find.descendant(of: _row(i), matching: find.text(status));

void main() {
  for (final surface in _Surface.values) {
    testWidgets(
      '${surface.name} shows service state only for its exact owner and track',
      (tester) async {
        tester.view.physicalSize = const Size(390, 1200);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final authority = CollectionAuthority();
        final playback = _Playback();
        final played = <CollectionPlaybackRequest>[];
        final harness = await _harness(surface, authority, played);
        playback.publish(_tracks[0], processing: PlaybackProcessing.loading);
        await tester.pumpWidget(
          MaterialApp(
            theme: SoundspanTheme.dark(),
            home: harness.screen(playback),
          ),
        );
        await tester.pumpAndSettle();
        expect(_status(1, 'Подготавливаем воспроизведение'), findsOneWidget);
        expect(_status(2, 'Подготавливаем воспроизведение'), findsNothing);
        playback.publish(_tracks[0]);
        await tester.pump();
        expect(_status(1, 'Воспроизводится'), findsOneWidget);
        playback.publish(_tracks[0], playing: false);
        await tester.pump();
        expect(_status(1, 'На паузе'), findsOneWidget);
        playback.publish(_tracks[0], processing: PlaybackProcessing.buffering);
        await tester.pump();
        expect(_status(1, 'Подготавливаем воспроизведение'), findsOneWidget);
        playback.publish(_tracks[1]);
        await tester.pump();
        expect(_status(1, 'Воспроизводится'), findsNothing);
        expect(_status(2, 'Воспроизводится'), findsOneWidget);
        playback.publish(
          Track(
            ref: const LibraryTrackRef('other'),
            title: 'Трек 2',
            artist: 'Артист',
          ),
        );
        await tester.pump();
        expect(find.text('Воспроизводится'), findsNothing);
        playback.publish(
          _tracks[1],
          fence: SessionFence(
            owner: OwnerKey(serverOrigin: collectionOrigin, userId: 'other'),
            epoch: 9,
          ),
        );
        await tester.pump();
        expect(find.text('Воспроизводится'), findsNothing);
        await tester.ensureVisible(_row(2));
        await tester.tap(find.text('Трек 2'));
        await tester.pump();
        expect(played.single.startIndex, 1);
        expect(played.single.fence, collectionFence);
        await tester.pumpWidget(const SizedBox());
        expect(playback.updates.hasListener, isFalse);
        harness.dispose();
        await playback.updates.close();
        await authority.updates.close();
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets(
      '${surface.name} rebinds and releases the old playback stream',
      (tester) async {
        tester.view.physicalSize = const Size(390, 1200);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final authority = CollectionAuthority();
        final old = _Playback(), next = _Playback();
        final harness = await _harness(surface, authority, []);
        old.publish(_tracks[0]);
        next.publish(_tracks[1], playing: false);
        Widget app(_Playback playback) => MaterialApp(
          theme: SoundspanTheme.dark(),
          home: harness.screen(playback),
        );
        await tester.pumpWidget(app(old));
        await tester.pumpAndSettle();
        expect(_status(1, 'Воспроизводится'), findsOneWidget);
        expect(old.updates.hasListener, isTrue);
        await tester.pumpWidget(app(next));
        await tester.pump();
        expect(old.updates.hasListener, isFalse);
        expect(next.updates.hasListener, isTrue);
        expect(_status(2, 'На паузе'), findsOneWidget);
        old.publish(_tracks[0]);
        await tester.pump();
        expect(_status(1, 'Воспроизводится'), findsNothing);
        await tester.pumpWidget(const SizedBox());
        expect(next.updates.hasListener, isFalse);
        harness.dispose();
        await old.updates.close();
        await next.updates.close();
        await authority.updates.close();
        expect(tester.takeException(), isNull);
      },
    );
  }
}
