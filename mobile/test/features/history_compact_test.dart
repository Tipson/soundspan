import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/design_system/theme.dart';
import 'package:soundspan/features/history/history_controller.dart';
import 'package:soundspan/features/history/history_repository.dart';
import 'package:soundspan/features/history/history_screen.dart';
import 'package:soundspan/features/lyrics/lyrics_sheet.dart';
import 'package:soundspan/playback/playback_controller.dart';

import '../support/collection_fixtures.dart';

void main() {
  testWidgets(
    'history groups local dates and loads older rows after the list',
    (tester) async {
      tester.view.physicalSize = const Size(360, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final authority = CollectionAuthority();
      final repo = HistoryRepository(
        transport: CollectionTransport(
          (r, _) => ApiResponse(
            200,
            r.path.endsWith('summary')
                ? {
                    'allTime': 2,
                    'last7Days': 2,
                    'last30Days': 2,
                    'last365Days': 2,
                  }
                : [
                    {
                      'id': '1',
                      'playedAt': '2026-10-19T12:00:00Z',
                      'track': null,
                    },
                    {
                      'id': '2',
                      'playedAt': '2026-10-18T12:00:00Z',
                      'track': null,
                    },
                  ],
          ),
        ),
        authority: authority,
        fence: collectionFence,
        networkPolicy: const NetworkPolicy.online(),
      );
      final c = HistoryController(
        repository: repo,
        playback: CollectionPlayback(QueueSnapshot(fence: collectionFence)),
      );
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: HistoryScreen(controller: c),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('19.10.2026'), findsOneWidget);
      expect(find.text('18.10.2026'), findsOneWidget);
      await tester.ensureVisible(find.text('Показать более ранние'));
      await tester.pumpAndSettle();
      expect(
        tester.getTopLeft(find.text('Показать более ранние')).dy,
        greaterThan(tester.getBottomLeft(find.byType(ExtrasTrackTile).last).dy),
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      c.dispose();
      repo.dispose();
      await authority.updates.close();
    },
  );

  testWidgets(
    'music row keeps track actions beside metadata rather than below it',
    (tester) async {
      final authority = CollectionAuthority();
      final repo = HistoryRepository(
        transport: CollectionTransport((r, _) => const ApiResponse(200, [])),
        authority: authority,
        fence: collectionFence,
        networkPolicy: const NetworkPolicy.online(),
      );
      final c = HistoryController(
        repository: repo,
        playback: CollectionPlayback(QueueSnapshot(fence: collectionFence)),
      );
      tester.view.physicalSize = const Size(360, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      var enqueued = 0;
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: Scaffold(
            body: Padding(
              padding: const EdgeInsets.all(20),
              child: ExtrasTrackTile(
                track: collectionTrack(1),
                controller: c,
                onPlay: () {},
                onEnqueue: () => enqueued++,
                onActions: (_, _) {},
                subtitle: '12:30',
              ),
            ),
          ),
        ),
      );
      final tile = find.byType(ExtrasTrackTile);
      expect(tester.getSize(tile).height, lessThanOrEqualTo(120));
      await tester.tap(find.byTooltip('В очередь'));
      await tester.pump();
      expect(enqueued, 1);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      c.dispose();
      repo.dispose();
      await authority.updates.close();
    },
  );
}
