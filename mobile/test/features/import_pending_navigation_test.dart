import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/design_system/theme.dart';
import 'package:soundspan/features/imports/import_controller.dart';
import 'package:soundspan/features/imports/import_repository.dart';
import 'package:soundspan/features/imports/import_screen.dart';

import '../support/collection_fixtures.dart';

Map<String, Object?> _job(String id) => {
  'id': id,
  'userId': 'a',
  'sourceType': 'yandex',
  'sourceId': 'owner:42',
  'normalizedSource': 'yandex:owner:42',
  'playlistName': 'Задание $id',
  'status': 'completed',
  'progress': 100,
  'createdPlaylistId': 'playlist-$id',
  'summary': {
    'total': 1,
    'local': 1,
    'youtube': 0,
    'tidal': 0,
    'unresolved': 0,
  },
  'resolutionProcessed': 1,
  'resolutionAttempt': 0,
};

void main() {
  testWidgets(
    'pending detail read visibly disables job rows until safe navigation',
    (tester) async {
      final authority = CollectionAuthority();
      final pending = Completer<ApiResponse>();
      final transport = CollectionTransport((r, f) {
        if (r.path.endsWith('/j1')) return pending.future;
        if (r.path.endsWith('/j2')) {
          return ApiResponse(200, {'job': _job('j2')});
        }
        return ApiResponse(200, {
          'jobs': [_job('j1'), _job('j2')],
        });
      });
      final controller = ImportController(
        repository: ImportRepository(
          transport: transport,
          authority: authority,
          fence: collectionFence,
          networkPolicy: const NetworkPolicy.online(),
        ),
      );
      await controller.refresh();
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: ImportScreen(
            controller: controller,
            autoLoad: false,
            pickDocument: () async => null,
            onOpenPlaylist: (_) {},
          ),
        ),
      );
      final reading = controller.openJob('j1');
      await tester.pump();
      final tile = find.widgetWithText(ListTile, 'Задание j2');
      await tester.scrollUntilVisible(
        tile,
        300,
        scrollable: find.byType(Scrollable).first,
      );
      expect(tester.widget<ListTile>(tile).enabled, isFalse);
      expect(tester.widget<ListTile>(tile).onTap, isNull);
      pending.complete(ApiResponse(200, {'job': _job('j1')}));
      await reading;
      await tester.pumpAndSettle();
      expect(tester.widget<ListTile>(tile).enabled, isTrue);
      expect(tester.widget<ListTile>(tile).onTap, isNotNull);
      await tester.tap(tile);
      await tester.pumpAndSettle();
      expect(controller.state.selected!.id, 'j2');
      await tester.pumpWidget(const SizedBox.shrink());
      await controller.close();
      await authority.updates.close();
    },
  );
}
