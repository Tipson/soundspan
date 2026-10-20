import 'package:flutter/material.dart' hide SearchController;
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/design_system/theme.dart';
import 'package:soundspan/features/artist/artist_repository.dart';
import 'package:soundspan/features/search/catalog_models.dart';
import 'package:soundspan/features/search/search_repository.dart';
import 'package:soundspan/features/search/search_controller.dart';
import 'package:soundspan/features/search/search_screen.dart';

import '../support/collection_fixtures.dart';

void main() {
  test(
    'online artist precedes same-name library metadata without merging IDs',
    () async {
      final authority = CollectionAuthority();
      final transport = CollectionTransport(
        (r, _) => ApiResponse(200, switch (r.path) {
          '/api/search' => {
            'artists': [
              {
                'id': 'local',
                'name': 'Olivia Rodrigo',
                'mbid': 'temp-remote-1',
              },
            ],
          },
          '/api/search/discover' => {
            'results': [
              {
                'type': 'music',
                'provider': 'ytmusic',
                'youtubeChannelId': 'UCexact',
                'name': 'Olivia Rodrigo',
              },
              {
                'type': 'music',
                'provider': 'ytmusic',
                'youtubeChannelId': 'UCother',
                'name': 'Another artist',
              },
            ],
          },
          _ => {},
        }),
      );
      final repository = SearchRepository(
        transport: transport,
        authority: authority,
        fence: collectionFence,
        networkPolicy: const NetworkPolicy.online(),
      );
      final page = await repository.search(
        'Olivia Rodrigo',
        SearchKind.artists,
      );
      expect(page.artists.map((e) => e.ref.id), [
        'UCexact',
        'UCother',
        'local',
      ]);
      expect(
        page.artists.where((e) => e.ref.name == 'Olivia Rodrigo'),
        hasLength(2),
      );
      final continued = await repository.search(
        'Olivia Rodrigo',
        SearchKind.artists,
        previous: page,
      );
      expect(continued.artists.map((e) => e.ref.id), [
        'UCexact',
        'UCother',
        'local',
      ]);
      repository.dispose();
      await authority.updates.close();
    },
  );

  testWidgets(
    'same-name results explain destination and preserve exact navigation',
    (tester) async {
      String? opened;
      final authority = CollectionAuthority();
      final transport = CollectionTransport(
        (r, _) => ApiResponse(
          200,
          r.path == '/api/search'
              ? {
                  'artists': [
                    {'id': 'local', 'name': 'Olivia Rodrigo'},
                  ],
                }
              : {
                  'results': [
                    {
                      'type': 'music',
                      'provider': 'ytmusic',
                      'youtubeChannelId': 'UCexact',
                      'name': 'Olivia Rodrigo',
                    },
                    {
                      'type': 'music',
                      'mbid': 'd7e8cf4e-fbe1-40c9-8f40-16ae540bbd8c',
                      'name': 'Olivia Rodrigo',
                    },
                  ],
                },
        ),
      );
      final controller = SearchController(
        repository: SearchRepository(
          transport: transport,
          authority: authority,
          fence: collectionFence,
          networkPolicy: const NetworkPolicy.online(),
        ),
      );
      await controller.submit('Olivia Rodrigo');
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: SearchScreen(
            controller: controller,
            onOpenArtist: (ref) {
              opened = ref.id;
            },
          ),
        ),
      );
      expect(find.text('Онлайн-каталог'), findsOneWidget);
      expect(find.text('Медиатека'), findsOneWidget);
      expect(find.text('Справочная карточка'), findsOneWidget);
      await tester.tap(find.text('Онлайн-каталог'));
      expect(opened, 'UCexact');
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      await authority.updates.close();
    },
  );

  for (final mbid in <String?>['temp-remote-1', 'remote:123', null]) {
    test(
      'unavailable artist does not send synthetic identity $mbid to discovery',
      () async {
        final authority = CollectionAuthority();
        final transport = CollectionTransport(
          (r, _) => const ApiResponse(404, {}),
        );
        final repo = ArtistRepository(
          transport: transport,
          authority: authority,
          fence: collectionFence,
          networkPolicy: const NetworkPolicy.online(),
        );
        await expectLater(
          repo.load(
            CatalogEntityRef(
              kind: CatalogEntityKind.artist,
              source: CatalogSource.library,
              id: 'local',
              name: 'Artist',
              mbid: mbid,
            ),
          ),
          throwsA(
            isA<AppFailure>().having(
              (e) => e.code,
              'code',
              'artist_unavailable',
            ),
          ),
        );
        expect(transport.requests.map((r) => r.path), [
          '/api/library/artists/local',
        ]);
        repo.dispose();
        await authority.updates.close();
      },
    );
  }
}
