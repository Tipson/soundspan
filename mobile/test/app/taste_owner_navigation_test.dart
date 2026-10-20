import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/app/app_destinations.dart';
import 'package:soundspan/app/app_visibility_controller.dart';
import 'package:soundspan/app/owner_services.dart';
import 'package:soundspan/app/owner_shell.dart';
import 'package:soundspan/app/owner_ui_session.dart';
import 'package:soundspan/features/tastes/taste_screen.dart';
import 'package:soundspan/playback/playback_controller.dart';

import '../support/collection_fixtures.dart';
import '../support/wave_reporting_fixtures.dart';

void main() {
  for (final scenario in [
    'root player',
    'other tab',
    'tab changed before mount',
    'normal nested',
    'normal root',
    'rapid reopen after failed load',
  ]) {
    testWidgets(
      'OwnerShell taste completion protects original stack: $scenario',
      (tester) async {
        final authority = CollectionAuthority(),
            exposure = AppVisibilityController();
        late Directory directory;
        late NativeOwnerServices native;
        late OwnerUiSession session;
        await tester.runAsync(() async {
          final base = await Directory(
            'D:/CodexData/temp/soundspan-taste-owner-tests',
          ).create(recursive: true);
          directory = Directory(
            await (await base.createTemp()).resolveSymbolicLinks(),
          );
          final store = ReportingStore();
          await store.transaction(
            collectionFence,
            (tx) => tx.write('settings', 'network', {
              'version': 1,
              'offline': true,
            }),
          );
          native = await NativeOwnerServices.create(
            authority: authority,
            store: store,
            fence: collectionFence,
            playback: CollectionPlayback(QueueSnapshot(fence: collectionFence)),
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
          if (scenario == 'rapid reopen after failed load') {
            await tester.tap(find.byTooltip('Настройки'));
            await tester.pumpAndSettle();
            final settingsTaste = find.widgetWithText(
              ListTile,
              'Музыкальные вкусы',
            );
            await tester.tap(settingsTaste.hitTestable());
            await tester.pumpAndSettle();
            expect(session.tastes.state, isNull);
            expect(session.tastes.loading, isFalse);
            expect(session.tastes.failure, isNotNull);
            await tester.pageBack();
            await tester.pump();
            expect(settingsTaste.hitTestable(), findsOneWidget);
            expect(
              find.byType(TasteScreen, skipOffstage: false),
              findsOneWidget,
              reason: 'The previous taste route is still retiring',
            );
            await tester.tap(settingsTaste.hitTestable());
            await tester.pumpAndSettle();
            expect(find.byType(TasteScreen), findsOneWidget);
            expect(tester.takeException(), isNull);
            return;
          }
          if (scenario == 'normal root') {
            unawaited(
              session.router.openOverlay<void>(
                const AppDestination(AppRouteKind.taste),
              ),
            );
          } else {
            unawaited(
              session.router.push<void>(
                const AppDestination(AppRouteKind.taste),
              ),
            );
          }
          if (scenario == 'tab changed before mount') {
            session.router.selectTab(AppTab.library);
          }
          await tester.pumpAndSettle();
          final taste = tester.widget<TasteScreen>(
            find.byType(TasteScreen, skipOffstage: false),
          );
          if (scenario == 'root player') {
            unawaited(
              session.router.openOverlay<void>(
                const AppDestination(AppRouteKind.player),
              ),
            );
          } else if (scenario == 'other tab' ||
              scenario == 'tab changed before mount') {
            session.router.selectTab(AppTab.library);
            unawaited(
              session.router.push<void>(
                const AppDestination(AppRouteKind.album),
              ),
            );
          }
          // Exercise the real production consumer callback before the next frame.
          // Separate widget tests own the pending server ACK / save admission seam.
          expect(
            taste.current?.call(),
            scenario == 'normal nested' || scenario == 'normal root',
          );
          taste.onComplete();
          await tester.pumpAndSettle();
          if (scenario == 'root player') {
            expect(session.router.playerVisible, true);
            expect(exposure.value, false);
            expect(session.router.stackDepth(AppTab.home), 2);
          } else if (scenario == 'other tab' ||
              scenario == 'tab changed before mount') {
            expect(session.router.currentTab, AppTab.library);
            expect(session.router.stackDepth(AppTab.library), 2);
            expect(session.router.stackDepth(AppTab.home), 2);
          } else {
            expect(find.byType(TasteScreen), findsNothing);
            expect(session.router.stackDepth(AppTab.home), 1);
            expect(exposure.value, true);
          }
        } finally {
          await tester.pumpWidget(const SizedBox.shrink());
          await _drain(tester, session.close());
          await _drain(tester, native.close());
          exposure.dispose();
          await authority.updates.close();
          await tester.runAsync(() => directory.delete(recursive: true));
        }
      },
    );
  }
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
  expect(done, isTrue, reason: 'Owner resources must drain');
  if (error != null) throw error!;
}
