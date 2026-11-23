import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/design_system/theme.dart';
import 'package:soundspan/features/library/library_models.dart';
import 'package:soundspan/features/likes/preference_controller.dart';
import 'package:soundspan/features/playlists/playlist_controller.dart';
import 'package:soundspan/features/playlists/playlist_detail_screen.dart';

import '../support/collection_fixtures.dart';
import 'playlist_journey_test.dart' show detail, item, repository;

void main() {
  for (final scale in [1.0, 2.0]) {
    testWidgets(
      'large playlist mounts bounded rows and plays exact scrolled occurrence at scale$scale',
      (tester) async {
        tester.view.physicalSize = const Size(320, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final a = CollectionAuthority();
        final t = CollectionTransport(
          (_, _) => ApiResponse(200, detail(List.generate(100, item))),
        );
        final c = PlaylistController(repository: repository(a, t));
        final p = PreferenceController(
          transport: t,
          authority: a,
          fence: collectionFence,
        );
        CollectionPlaybackRequest? played;
        await c.open('p');
        await tester.pumpWidget(
          MaterialApp(
            theme: SoundspanTheme.dark(),
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context)
                  .copyWith(textScaler: TextScaler.linear(scale)),
              child: child!,
            ),
            home: PlaylistDetailScreen(
              controller: c,
              preferences: p,
              autoLoad: false,
              onPlay: (request) async => played = request,
            ),
          ),
        );
        await tester.pumpAndSettle();
        final rows = find.byWidgetPredicate(
          (w) =>
              w.key is ValueKey<String> &&
              (w.key! as ValueKey<String>).value.startsWith('playlist-row-'),
        );
        expect(rows.evaluate().length, inExclusiveRange(0, 30));
        await tester.scrollUntilVisible(
          find.text('Песня 99'),
          500,
          maxScrolls: 50,
        );
        await tester.pumpAndSettle();
        await tester.tap(find.text('Песня 99'));
        await tester.pumpAndSettle();
        expect(played!.startIndex, 99);
        expect(played!.tracks, hasLength(100));
        expect(played!.fence, collectionFence);
        expect(rows.evaluate().length, lessThan(30));
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        c.dispose();
        p.dispose();
        await a.updates.close();
      },
    );
  }
}
