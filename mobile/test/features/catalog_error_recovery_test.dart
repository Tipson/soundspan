import 'package:flutter/material.dart' hide SearchController;
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/design_system/theme.dart';
import 'package:soundspan/features/search/search_repository.dart';
import 'package:soundspan/features/search/search_controller.dart';
import 'package:soundspan/features/search/search_screen.dart';
import 'package:soundspan/features/search/catalog_detail_controller.dart';
import 'package:soundspan/features/search/catalog_detail_screen.dart';

import '../support/collection_fixtures.dart';

void main() {
  for (final transient in [false, true]) {
    testWidgets(
      'catalog ${transient ? 'temporary failure retries' : 'unavailable returns to preserved query'}',
      (tester) async {
        final authority = CollectionAuthority();
        final repo = SearchRepository(
          transport: CollectionTransport(
            (r, _) => ApiResponse(
              200,
              r.path == '/api/search'
                  ? {
                      'albums': [
                        {'id': 'album', 'title': 'GUTS'},
                      ],
                    }
                  : {'results': []},
            ),
          ),
          authority: authority,
          fence: collectionFence,
          networkPolicy: const NetworkPolicy.online(),
        );
        final search = SearchController(repository: repo);
        await search.submit('GUTS');
        var loads = 0;
        final detail = CatalogDetailController(
          repository: repo,
          loadDetail: (_) async {
            loads++;
            throw AppFailure(
              code: transient ? 'server' : 'album_unavailable',
              message: 'Альбом недоступен',
              statusCode: transient ? 503 : 404,
              retryable: transient,
            );
          },
        );
        final nav = GlobalKey<NavigatorState>();
        await tester.pumpWidget(
          MaterialApp(
            navigatorKey: nav,
            theme: SoundspanTheme.dark(),
            home: SearchScreen(
              controller: search,
              onOpenAlbum: (ref) {
                nav.currentState!.push(
                  MaterialPageRoute<void>(
                    builder: (_) =>
                        CatalogDetailScreen(controller: detail, entity: ref),
                  ),
                );
              },
            ),
          ),
        );
        await tester.tap(find.byType(CatalogEntityTile));
        await tester.pumpAndSettle();
        if (transient) {
          await tester.tap(find.text('Повторить'));
          await tester.pumpAndSettle();
          expect(loads, 2);
        } else {
          expect(find.text('Повторить'), findsNothing);
          await tester.tap(find.text('Вернуться назад'));
          await tester.pumpAndSettle();
          expect(find.byType(SearchScreen), findsOneWidget);
          expect(
            tester.widget<TextField>(find.byType(TextField)).controller!.text,
            'GUTS',
          );
          expect(search.state.query, 'GUTS');
          expect(loads, 1);
        }
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        detail.dispose();
        search.dispose();
        await authority.updates.close();
      },
    );
  }
}
