import 'package:flutter/material.dart' hide SearchController;
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/design_system/theme.dart';
import 'package:soundspan/features/search/search_controller.dart';
import 'package:soundspan/features/search/search_repository.dart';
import 'package:soundspan/features/search/search_screen.dart';

import '../support/collection_fixtures.dart';

void main() {
  testWidgets(
    'metadata-only rows explain unavailability and retry fetches exact provider IDs',
    (tester) async {
      final authority = CollectionAuthority();
      var discovers = 0;
      final controller = SearchController(
        repository: SearchRepository(
          transport: CollectionTransport(
            (r, _) => ApiResponse(
              200,
              r.path == '/api/search/discover'
                  ? {
                      'results': [
                        {
                          'type': 'track',
                          'id': 'metadata',
                          'name': 'Heat Waves',
                          'artist': 'Glass Animals',
                          if (++discovers > 1) 'youtubeVideoId': 'mRD0-GxqHVo',
                        },
                      ],
                    }
                  : {},
            ),
          ),
          authority: authority,
          fence: collectionFence,
          networkPolicy: const NetworkPolicy.online(),
        ),
      );
      addTearDown(() async {
        controller.dispose();
        await authority.updates.close();
      });
      await controller.submit('Glass Animals');
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: SearchScreen(controller: controller),
        ),
      );
      expect(find.text('missing_provider_track'), findsNothing);
      expect(
        find.text('Источник воспроизведения пока не найден'),
        findsOneWidget,
      );
      expect(controller.state.page.tracks.single.playable, false);
      await tester.tap(find.text('Повторить поиск'));
      await tester.pumpAndSettle();
      expect(controller.state.query, 'Glass Animals');
      expect(
        controller.state.page.tracks.single.ref.identityKey,
        contains('mRD0-GxqHVo'),
      );
      expect(controller.state.page.tracks.single.playable, true);
      expect(
        find.text('Источник воспроизведения пока не найден'),
        findsNothing,
      );
      expect(discovers, 2);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
