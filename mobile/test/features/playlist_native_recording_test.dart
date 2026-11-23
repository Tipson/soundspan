import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/app/add_to_playlist_sheet.dart';
import 'package:soundspan/app/collection_track_picker.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/design_system/theme.dart';
import 'package:soundspan/features/playlists/playlist_controller.dart';
import 'package:soundspan/features/search/catalog_actions.dart';

import '../support/collection_fixtures.dart';
import 'playlist_journey_test.dart' show detail, item, repository;

MusicRecording recording(NativeMusicProvider provider, {String? id}) =>
    MusicRecording(
      provider: provider,
      id:
          id ??
          (provider == NativeMusicProvider.vk ? '-123456789_00042' : '000456'),
      title: 'Точная версия',
      artists: ['Первый артист', 'Второй артист'],
      durationSeconds: 180.125,
      contentVersion: provider == NativeMusicProvider.vk
          ? MusicContentVersion.explicit
          : MusicContentVersion.clean,
      isrc: 'USABC1234567',
    );

Track nativeTrack(NativeMusicProvider provider) => Track(
  ref: NativeTrackRef(recording(provider)),
  title: 'Display title is not identity',
  artist: 'Display artist',
  album: 'Display album',
  artwork: Uri.parse('https://images.example/art.jpg'),
);

Map<String, Object?> nativeItem(
  MusicRecording recording,
  String itemId,
  int sort,
) => {
  'id': itemId,
  'type': 'track',
  'sort': sort,
  'provider': {
    'source': recording.provider.name,
    'providerTrackId': recording.id,
  },
  'playback': {'isPlayable': true},
  'track': {
    'id': recording.identityKey,
    'title': recording.title,
    'duration': recording.durationSeconds,
    'source': recording.provider.name,
    'mediaSource': recording.provider.name,
    'streamSource': recording.provider.name,
    'provider': {
      'source': recording.provider.name,
      'providerTrackId': recording.id,
      'youtubeVideoId': null,
      'tidalTrackId': null,
    },
    'musicSourceRecording': recording.toJson(),
    'album': {
      'id': null,
      'title': '',
      'coverArt': null,
      'artist': {'id': null, 'name': recording.artists.join(', ')},
    },
  },
};

void main() {
  for (final provider in NativeMusicProvider.values) {
    test(
      '$provider POST uses the exact bounded portable recording without local or Youtube claims',
      () async {
        final authority = CollectionAuthority();
        addTearDown(authority.updates.close);
        final transport = CollectionTransport(
          (_, _) => const ApiResponse(200, {}),
        );
        final track = nativeTrack(provider);
        await repository(authority, transport).add('p', [track]);
        expect(transport.requests.single.method, ApiMethod.post);
        expect(transport.requests.single.path, '/api/playlists/p/items');
        expect(transport.requests.single.body, {
          'musicSourceRecording': recording(provider).toJson(),
        });
        expect(transport.fences, [collectionFence]);
        expect(transport.requests.single.query, isEmpty);
      },
    );

    test(
      '$provider GET preserves playlist item id and sort independently of exact recording',
      () async {
        final authority = CollectionAuthority();
        addTearDown(authority.updates.close);
        final exact = recording(provider);
        final transport = CollectionTransport(
          (request, _) => request.path == '/api/playlists/p'
              ? ApiResponse(
                  200,
                  detail([
                    item(0),
                    nativeItem(exact, 'stored-native-item', 37),
                    item(2, pending: true),
                  ]),
                )
              : request.method == ApiMethod.delete &&
                    request.path.startsWith('/api/playlists/p/items/')
              ? const ApiResponse(200, {})
              : const ApiResponse(503, {}),
        );
        final repo = repository(authority, transport);
        final page = await repo.page('p', null);
        expect(page.items.map((e) => e.id), [
          'item-0',
          'stored-native-item',
          'pending-2',
        ]);
        expect(page.items[1].sort, 37);
        expect(page.items[1].track.ref, NativeTrackRef(exact));
        expect(page.items[1].track.playable, true);
        expect(page.items[1].pending, false);
        expect(
          (page.items[1].track.ref as NativeTrackRef).recording.toJson(),
          exact.toJson(),
        );
        expect(transport.requests.map((r) => r.path), ['/api/playlists/p']);
        await repo.remove('p', page.items[1].id);
        expect(
          transport.requests.last.path,
          '/api/playlists/p/items/stored-native-item',
        );
        expect(transport.requests.last.method, ApiMethod.delete);
      },
    );

    test(
      '$provider native/local mixed wire claim is rejected by unchanged mapper',
      () async {
        final authority = CollectionAuthority();
        addTearDown(authority.updates.close);
        final row = nativeItem(recording(provider), 'bad', 0);
        final raw = (row['track'] as Map).cast<String, Object?>();
        row['track'] = {
          ...raw,
          'source': 'local',
          'filePath': '/untrusted/local.flac',
        };
        final transport = CollectionTransport(
          (_, _) => ApiResponse(200, detail([row])),
        );
        await expectLater(
          repository(authority, transport).page('p', null),
          throwsA(isA<AppFailure>()),
        );
      },
    );
  }

  test('mixed local Youtube VK Yandex batch retains exact order and per-source input shape', () async {
    final authority = CollectionAuthority();
    addTearDown(authority.updates.close);
    final transport = CollectionTransport((_, _) => const ApiResponse(200, {}));
    await repository(authority, transport).add('p', [
      collectionTrack(0),
      const Track(
        ref: YoutubeTrackRef('exact-video'),
        title: 'Видео',
        artist: 'Артист',
        duration: Duration(seconds: 180),
      ),
      nativeTrack(NativeMusicProvider.vk),
      nativeTrack(NativeMusicProvider.yandex),
    ]);
    expect(transport.requests.map((r) => r.body), [
      {'trackId': 'local-0'},
      {
        'youtubeVideoId': 'exact-video',
        'title': 'Видео',
        'artist': 'Артист',
        'album': 'Single',
        'duration': 180,
      },
      {'musicSourceRecording': recording(NativeMusicProvider.vk).toJson()},
      {'musicSourceRecording': recording(NativeMusicProvider.yandex).toJson()},
    ]);
  });

  for (final unsupported in ['audius', 'tidal']) {
    test(
      '$unsupported remains blocked before every batch HTTP mutation',
      () async {
        final authority = CollectionAuthority();
        addTearDown(authority.updates.close);
        final transport = CollectionTransport(
          (_, _) => const ApiResponse(200, {}),
        );
        await expectLater(
          repository(authority, transport).add('p', [
            nativeTrack(NativeMusicProvider.vk),
            Track(
              ref: UnavailableTrackRef(
                '$unsupported:id',
                reason: unsupported == 'tidal'
                    ? 'retired_provider'
                    : 'unsupported_source',
              ),
              title: 'Unsupported',
              artist: 'Artist',
            ),
          ]),
          throwsA(isA<AppFailure>()),
        );
        expect(transport.requests, isEmpty);
      },
    );
  }

  test(
    'owner switch after native POST prevents the next recording mutation',
    () async {
      final authority = CollectionAuthority(),
          admitted = Completer<void>(),
          response = Completer<ApiResponse>();
      addTearDown(authority.updates.close);
      final transport = CollectionTransport((_, _) {
        admitted.complete();
        return response.future;
      });
      final result = repository(authority, transport).add('p', [
        nativeTrack(NativeMusicProvider.vk),
        nativeTrack(NativeMusicProvider.yandex),
      ]);
      final assertion = expectLater(result, throwsA(isA<AppFailure>()));
      await admitted.future;
      authority.switchOwner();
      response.complete(const ApiResponse(200, {}));
      await assertion;
      expect(transport.requests, hasLength(1));
    },
  );

  test(
    'native playlist capability does not manufacture a download action',
    () async {
      List<Track>? sent;
      final track = nativeTrack(NativeMusicProvider.yandex);
      final actions = catalogTrackActions(
        actions: CatalogActions(
          addToPlaylist: (rows, _) {
            sent = rows;
          },
        ),
        track: track,
        fence: collectionFence,
        run: (action) async => await action(),
      );
      expect(actions.map((e) => e.id), ['playlist']);
      await actions.single.onSelected!();
      expect(sent, [track]);
    },
  );

  testWidgets('existing picker permits exact native selection', (tester) async {
    final track = nativeTrack(NativeMusicProvider.vk);
    await tester.pumpWidget(
      MaterialApp(
        theme: SoundspanTheme.dark(),
        home: Scaffold(
          body: CollectionTrackPicker(
            initial: [track],
            search: (_) async => [],
            isCurrent: () => true,
          ),
        ),
      ),
    );
    final row = find.byKey(ValueKey('pick-${track.ref.identityKey}'));
    expect(tester.widget<CheckboxListTile>(row).onChanged, isNotNull);
    await tester.tap(row);
    await tester.pump();
    expect(find.text('Добавить 1'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'visible add-to-playlist flow submits both native recordings without lossy review',
    (tester) async {
      final authority = CollectionAuthority();
      final summary = {
        'id': 'p',
        'name': 'Мой плейлист',
        'isOwner': true,
        'isPublic': false,
        'isHidden': false,
        'trackCount': 0,
      };
      final transport = CollectionTransport(
        (r, _) => ApiResponse(
          200,
          r.path == '/api/playlists'
              ? [summary]
              : r.method == ApiMethod.get
              ? detail([])
              : {},
        ),
      );
      final controller = PlaylistController(
        repository: repository(authority, transport),
      );
      addTearDown(() async {
        controller.dispose();
        await authority.updates.close();
      });
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () => showModalBottomSheet(
                  context: context,
                  isScrollControlled: true,
                  builder: (_) => AddToPlaylistSheet(
                    controller: controller,
                    tracks: [
                      nativeTrack(NativeMusicProvider.vk),
                      nativeTrack(NativeMusicProvider.yandex),
                    ],
                    assertCurrent: () =>
                        authority.assertCurrent(collectionFence),
                  ),
                ),
                child: const Text('Открыть'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Открыть'));
      await tester.pumpAndSettle();
      expect(find.byType(CheckboxListTile), findsNothing);
      await tester.tap(find.text('Мой плейлист'));
      await tester.pump();
      await tester.tap(find.text('Добавить 2'));
      await tester.pumpAndSettle();
      expect(
        transport.requests
            .where((r) => r.method == ApiMethod.post)
            .map((r) => r.body),
        [
          {'musicSourceRecording': recording(NativeMusicProvider.vk).toJson()},
          {
            'musicSourceRecording': recording(NativeMusicProvider.yandex)
                .toJson(),
          },
        ],
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
