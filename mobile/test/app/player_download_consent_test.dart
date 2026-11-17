import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/app/app_destinations.dart';
import 'package:soundspan/app/app_visibility_controller.dart';
import 'package:soundspan/app/owner_services.dart';
import 'package:soundspan/app/owner_shell.dart';
import 'package:soundspan/app/owner_ui_session.dart';
import 'package:soundspan/design_system/design_system.dart';
import 'package:soundspan/features/player/full_player_screen.dart';
import 'package:soundspan/playback/playback_controller.dart';

import '../support/collection_fixtures.dart';
import '../support/wave_reporting_fixtures.dart';

Future<({OwnerUiSession session, CollectionAuthority authority})> playerOwner(
  WidgetTester tester,
) async {
  late Directory directory;
  late NativeOwnerServices owner;
  late OwnerUiSession session;
  final authority = CollectionAuthority();
  final visibility = AppVisibilityController();
  await tester.runAsync(() async {
    final base = await Directory(
      'D:/CodexData/temp/soundspan-development-34-20261115/player-consent-fixtures',
    ).create(recursive: true);
    directory = Directory(
      await (await base.createTemp()).resolveSymbolicLinks(),
    );
    final store = ReportingStore();
    await store.transaction(
      collectionFence,
      (tx) => tx.write('settings', 'network', {'version': 1, 'offline': true}),
    );
    final playback = CollectionPlayback(QueueSnapshot(fence: collectionFence));
    final entries = playback.createEntries([
      collectionTrack(1),
    ], const PlayContext(surface: PlaySurface.library));
    playback.value = QueueSnapshot(
      fence: collectionFence,
      entries: entries,
      effectiveOrder: entries.map((entry) => entry.entryId),
      currentEntryId: entries.single.entryId,
      generation: 1,
      lineage: 1,
    );
    owner = await NativeOwnerServices.create(
      authority: authority,
      store: store,
      fence: collectionFence,
      playback: playback,
      supportDirectory: directory,
      cancelDownloads: (_) async {},
    );
    session = await OwnerUiSession.create(
      owner: owner,
      logout: authority.invalidate,
    );
  });
  addTearDown(() async {
    await tester.pumpWidget(const SizedBox.shrink());
    await drainOwner(tester, session.close());
    await drainOwner(tester, owner.close());
    final closingAuthority = authority.updates.close();
    await tester.pump();
    await closingAuthority;
    await tester.runAsync(() => directory.delete(recursive: true));
    visibility.dispose();
  });
  await tester.pumpWidget(
    MaterialApp(
      theme: SoundspanTheme.dark(),
      navigatorObservers: [visibility],
      home: OwnerShell(session: session, rootExposure: visibility),
    ),
  );
  await tester.pumpAndSettle();
  session.router.openOverlay<void>(const AppDestination(AppRouteKind.player));
  await tester.pumpAndSettle();
  expect(find.byType(FullPlayerScreen), findsOneWidget);
  expect(
    visibility.value,
    isFalse,
    reason: 'The owned player covers the root while keeping its owner alive.',
  );
  return (session: session, authority: authority);
}

void main() {
  testWidgets('owned full player can accept download traffic consent', (
    tester,
  ) async {
    final h = await playerOwner(tester);
    final answer = h.session.downloads.confirmNetworkUse!(1);
    await tester.pumpAndSettle();
    expect(find.text('Разрешить расход трафика?'), findsOneWidget);
    await tester.tap(find.text('Скачать выбранное'));
    await tester.pumpAndSettle();
    expect(await answer, isTrue);
    expect(find.byType(FullPlayerScreen), findsOneWidget);
  });

  testWidgets(
    'owned full player can present and cancel download traffic consent',
    (tester) async {
      final h = await playerOwner(tester);
      final answer = h.session.downloads.confirmNetworkUse!(1);
      await tester.pumpAndSettle();
      expect(find.text('Разрешить расход трафика?'), findsOneWidget);
      await tester.tap(find.text('Отмена'));
      await tester.pumpAndSettle();
      expect(await answer, isFalse);
      expect(find.byType(FullPlayerScreen), findsOneWidget);
      expect(h.session.downloads.jobs, isEmpty);
    },
  );

  for (final retireOwner in [false, true]) {
    testWidgets(
      'player consent rejects a late answer after ${retireOwner ? 'owner retirement' : 'presentation retirement'}',
      (tester) async {
        final h = await playerOwner(tester);
        final answer = h.session.downloads.confirmNetworkUse!(1);
        await tester.pumpAndSettle();
        expect(find.text('Разрешить расход трафика?'), findsOneWidget);
        if (retireOwner) {
          await h.authority.invalidate();
        } else {
          h.session.presentation = null;
        }
        await tester.tap(find.text('Скачать выбранное'));
        await tester.pumpAndSettle();
        expect(await answer, isFalse);
        expect(h.session.downloads.jobs, isEmpty);
      },
    );
  }
}

Future<void> drainOwner(WidgetTester tester, Future<void> closing) async {
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
  expect(
    done,
    isTrue,
    reason: 'Owner teardown must finish on both event loops.',
  );
  if (error != null) throw error!;
}
