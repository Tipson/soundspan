import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/app/app_visibility_controller.dart';
import 'package:soundspan/app/owner_services.dart';
import 'package:soundspan/app/owner_shell.dart';
import 'package:soundspan/app/owner_ui_session.dart';
import 'package:soundspan/features/wave/wave_direction_sheet.dart';
import 'package:soundspan/app/app_destinations.dart';
import 'package:soundspan/playback/playback_controller.dart';

import '../support/collection_fixtures.dart';
import '../support/wave_reporting_fixtures.dart';

void main() {
  testWidgets(
    'Home tune opens a root sheet directly and Cancel preserves tab and queue',
    (tester) async {
      final authority = CollectionAuthority(),
          exposure = AppVisibilityController();
      late Directory directory;
      late NativeOwnerServices native;
      late OwnerUiSession session;
      final playback = CollectionPlayback(
        QueueSnapshot(fence: collectionFence),
      );
      await tester.runAsync(() async {
        final created = await (await Directory(
          'D:/CodexData/temp/soundspan-home-wave-tests',
        ).create(recursive: true)).createTemp();
        directory = Directory(await created.resolveSymbolicLinks());
        final store = ReportingStore();
        await store.transaction(
          collectionFence,
          (tx) =>
              tx.write('settings', 'network', {'version': 1, 'offline': true}),
        );
        native = await NativeOwnerServices.create(
          authority: authority,
          store: store,
          fence: collectionFence,
          playback: playback,
          supportDirectory: directory,
          cancelDownloads: (_) async {},
        );
        session = await OwnerUiSession.create(
          owner: native,
          logout: authority.invalidate,
        );
      });
      try {
        await tester.pumpWidget(
          MaterialApp(
            navigatorObservers: [exposure],
            home: OwnerShell(session: session, rootExposure: exposure),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byTooltip('Настроить волну'));
        await tester.pumpAndSettle();
        expect(find.byType(WaveDirectionSheet), findsOneWidget);
        expect(session.router.currentTab, AppTab.home);
        final sheetContext = tester.element(find.byType(WaveDirectionSheet));
        expect(
          Navigator.of(sheetContext),
          same(Navigator.of(sheetContext, rootNavigator: true)),
        );
        await tester.tap(find.byTooltip('Закрыть без изменений'));
        await tester.pumpAndSettle();
        expect(find.byType(WaveDirectionSheet), findsNothing);
        expect(session.router.currentTab, AppTab.home);
        expect(playback.commands, isEmpty);
        expect(tester.takeException(), isNull);
        const offlineMessage =
            'Включён офлайн-режим. Откройте загруженную музыку.';
        final noticesBefore = find.text(offlineMessage).evaluate().length;
        await tester.tap(find.byTooltip('Настроить волну'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Применить'));
        await tester.pumpAndSettle();
        expect(find.text(offlineMessage), findsNWidgets(noticesBefore + 1));
        expect(playback.commands, isEmpty);
      } finally {
        await tester.pumpWidget(const SizedBox());
        await _drain(tester, session.close());
        await _drain(tester, native.close());
        exposure.dispose();
        await authority.updates.close();
        await tester.runAsync(() async {
          final path = await directory.resolveSymbolicLinks();
          if (!path
              .replaceAll('\\', '/')
              .startsWith('D:/CodexData/temp/soundspan-home-wave-tests/')) {
            throw StateError('Unexpected test path');
          }
          await directory.delete(recursive: true);
        });
      }
    },
  );
}

Future<void> _drain(WidgetTester tester, Future<void> closing) async {
  var done = false;
  Object? error;
  closing.then(
    (_) => done = true,
    onError: (Object e) {
      error = e;
      done = true;
    },
  );
  for (var i = 0; i < 100 && !done; i++) {
    await tester.pump();
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 10)),
    );
  }
  expect(done, isTrue);
  if (error != null) throw error!;
}
