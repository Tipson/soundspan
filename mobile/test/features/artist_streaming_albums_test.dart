import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/design_system/theme.dart';
import 'package:soundspan/features/artist/artist_controller.dart';
import 'package:soundspan/features/artist/artist_repository.dart';
import 'package:soundspan/features/artist/artist_screen.dart';
import 'package:soundspan/features/album/album_repository.dart';
import 'package:soundspan/features/search/catalog_models.dart';

import '../support/collection_fixtures.dart';

const artistRef = CatalogEntityRef(
  kind: CatalogEntityKind.artist,
  source: CatalogSource.library,
  id: 'artist-owner',
  name: 'Исполнитель',
);
const albumTitle = 'Любимый альбом с длинным названием';

Map<String, Object?> artistDto() => {
  'id': artistRef.id,
  'name': artistRef.name,
  'albums': <Object?>[],
  'topTracks': <Object?>[],
  'streamingAlbums': [
    {
      'id': 'remote-original',
      'rgMbid': 'remote:original',
      'matchedRgMbid': '11111111-1111-4111-8111-111111111111',
      'title': albumTitle,
      'owned': false,
      'source': 'youtube',
      'streamSource': 'youtube',
      'year': 2026,
      'trackCount': 1,
      'tracks': <Object?>[],
    },
  ],
};

void main() {
  test('a remote release with an existing canonical RG keeps its original endpoint', () async {
    final authority = CollectionAuthority();
    final dto = artistDto();
    final row = (dto['streamingAlbums'] as List).single as Map<String, Object?>;
    row['rgMbid'] = '22222222-2222-4222-8222-222222222222';
    final transport = CollectionTransport(
      (request, _) => request.path.startsWith('/api/library/artists/')
          ? ApiResponse(200, dto)
          : const ApiResponse(404, {}),
    );
    final artist = ArtistRepository(
      transport: transport,
      authority: authority,
      fence: collectionFence,
      networkPolicy: const NetworkPolicy.online(),
    );
    final album = AlbumRepository(
      transport: transport,
      authority: authority,
      fence: collectionFence,
      networkPolicy: const NetworkPolicy.online(),
    );
    try {
      final detail = await artist.load(artistRef);
      expect(detail.streamingAlbums, hasLength(1));
      final ref = detail.streamingAlbums.single.ref;
      expect(ref.id, 'remote-original');
      await expectLater(
        album.load(ref),
        throwsA(
          isA<AppFailure>().having((e) => e.code, 'code', 'album_unavailable'),
        ),
      );
      expect(transport.requests.map((r) => r.path), [
        '/api/library/artists/artist-owner',
        '/api/library/albums/remote-original',
      ]);
    } finally {
      artist.dispose();
      album.dispose();
      await authority.updates.close();
    }
  });

  test('reads the current backend artist serializer fixture', () async {
    final dto = (jsonDecode(
      File('test/fixtures/artist_streaming_albums.json').readAsStringSync(),
    ) as Map).cast<String, Object?>();
    final authority = CollectionAuthority();
    final repository = ArtistRepository(
      transport: CollectionTransport((_, _) => ApiResponse(200, dto)),
      authority: authority,
      fence: collectionFence,
      networkPolicy: const NetworkPolicy.online(),
    );
    try {
      final detail = await repository.load(artistRef);
      expect(detail.streamingAlbums.single.ref.id, 'fixture-remote-album');
      expect(
        detail.streamingAlbums.single.ref.mbid,
        'remote:fixture-streaming-album',
      );
      expect(detail.streamingAlbums.single.ref.source, CatalogSource.library);
      expect(detail.streamingAlbums.single.year, '2024');
      expect(detail.albums, isEmpty);
    } finally {
      repository.dispose();
      await authority.updates.close();
    }
  });

  testWidgets(
    'owner streaming albums appear separately with exact navigation',
    (tester) async {
      tester.view.physicalSize = const Size(320, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final authority = CollectionAuthority();
      final transport = CollectionTransport(
        (request, _) => ApiResponse(200, artistDto()),
      );
      final repository = ArtistRepository(
        transport: transport,
        authority: authority,
        fence: collectionFence,
        networkPolicy: const NetworkPolicy.online(),
      );
      final controller = ArtistController(repository: repository);
      CatalogEntityRef? opened;
      try {
        await tester.pumpWidget(
          MaterialApp(
            theme: SoundspanTheme.dark(),
            home: ArtistScreen(
              controller: controller,
              entity: artistRef,
              onOpenAlbum: (ref) => opened = ref,
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('Альбомы из любимых'), findsOneWidget);
        await tester.drag(find.byType(CustomScrollView), const Offset(0, -300));
        await tester.pumpAndSettle();
        expect(find.text(albumTitle).hitTestable(), findsOneWidget);
        expect(tester.takeException(), isNull);
        await tester.tap(find.text(albumTitle));
        await tester.pumpAndSettle();
        expect(opened?.id, 'remote-original');
        expect(opened?.source, CatalogSource.library);
        expect(opened?.mbid, 'remote:original');
        expect(transport.requests, hasLength(1));

        authority.switchOwner();
        await tester.pumpAndSettle();
        expect(find.text(albumTitle), findsNothing);
        expect(
          find.text('Аккаунт изменился. Откройте музыку снова.'),
          findsOneWidget,
        );
      } finally {
        await tester.pumpWidget(const SizedBox());
        controller.dispose();
        await authority.updates.close();
      }
    },
  );

  test('artist continuation retains personal streaming releases', () async {
    final authority = CollectionAuthority();
    final transport = CollectionTransport(
      (request, _) => ApiResponse(
        200,
        request.path.endsWith('/tracks')
            ? {'tracks': <Object?>[], 'offset': 0, 'total': 0}
            : artistDto(),
      ),
    );
    final repository = ArtistRepository(
      transport: transport,
      authority: authority,
      fence: collectionFence,
      networkPolicy: const NetworkPolicy.online(),
    );
    try {
      final detail = await repository.load(artistRef);
      final next = await repository.more(detail);
      expect(next.streamingAlbums.single.ref.id, 'remote-original');
      expect(next.streamingAlbums.single.ref.mbid, 'remote:original');
      expect(next.albums, isEmpty);
      expect(next.continuationLoaded, isTrue);
    } finally {
      repository.dispose();
      await authority.updates.close();
    }
  });

  test(
    'an older artist response retains its existing album navigation',
    () async {
      final authority = CollectionAuthority();
      final dto = artistDto()..remove('streamingAlbums');
      dto['albums'] = [
        {'id': 'local-album', 'owned': true, 'title': 'Локальный альбом'},
        {
          'id': 'catalog-row',
          'owned': false,
          'title': 'Релиз каталога',
          'rgMbid': '11111111-1111-4111-8111-111111111111',
        },
      ];
      final repository = ArtistRepository(
        transport: CollectionTransport((_, _) => ApiResponse(200, dto)),
        authority: authority,
        fence: collectionFence,
        networkPolicy: const NetworkPolicy.online(),
      );
      try {
        final detail = await repository.load(artistRef);
        expect(detail.streamingAlbums, isEmpty);
        expect(detail.albums.map((a) => a.ref.source), [
          CatalogSource.library,
          CatalogSource.discovery,
        ]);
        expect(detail.albums.map((a) => a.ref.id), [
          'local-album',
          '11111111-1111-4111-8111-111111111111',
        ]);
      } finally {
        repository.dispose();
        await authority.updates.close();
      }
    },
  );

  test('remote album plays exact saved recording and never falls back to its canonical match', () async {
    final authority = CollectionAuthority();
    var available = true;
    final transport = CollectionTransport((request, _) {
      if (request.path == '/api/library/artists/artist-owner') {
        return ApiResponse(200, artistDto());
      }
      if (request.path == '/api/library/albums/remote-original') {
        return available
            ? ApiResponse(200, {
                'id': 'remote-original',
                'rgMbid': 'remote:original',
                'title': albumTitle,
                'artist': {'id': 'artist-owner', 'name': 'Исполнитель'},
                'tracks': [
                  {
                    'id': 'yt:CevxZvSJLk8',
                    'youtubeVideoId': 'CevxZvSJLk8',
                    'title': 'Любимый трек',
                    'duration': 180,
                    'source': 'youtube',
                    'streamSource': 'youtube',
                  },
                ],
              })
            : const ApiResponse(404, {});
      }
      throw StateError('Unexpected request: ${request.path}');
    });
    final artist = ArtistRepository(
      transport: transport,
      authority: authority,
      fence: collectionFence,
      networkPolicy: const NetworkPolicy.online(),
    );
    final album = AlbumRepository(
      transport: transport,
      authority: authority,
      fence: collectionFence,
      networkPolicy: const NetworkPolicy.online(),
    );
    try {
      final ref = (await artist.load(artistRef)).streamingAlbums.single.ref;
      final detail = await album.load(ref);
      expect(detail.tracks.single.ref, isA<YoutubeTrackRef>());
      expect(
        (detail.tracks.single.ref as YoutubeTrackRef).videoId,
        'CevxZvSJLk8',
      );
      available = false;
      await expectLater(
        album.load(ref),
        throwsA(
          isA<AppFailure>().having((e) => e.code, 'code', 'album_unavailable'),
        ),
      );
      expect(transport.requests.map((r) => r.path), [
        '/api/library/artists/artist-owner',
        '/api/library/albums/remote-original',
        '/api/library/albums/remote-original',
      ]);
    } finally {
      artist.dispose();
      album.dispose();
      await authority.updates.close();
    }
  });
}
