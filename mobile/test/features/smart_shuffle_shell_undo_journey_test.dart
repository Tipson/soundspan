import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/app/app_destinations.dart';
import 'package:soundspan/app/app_router.dart';
import 'package:soundspan/app/app_shell.dart';
import 'package:soundspan/design_system/theme.dart';
import 'package:soundspan/features/likes/preference_controller.dart';
import 'package:soundspan/features/playlists/playlist_detail_screen.dart';
import 'package:soundspan/playback/playback_command.dart';
import 'package:soundspan/playback/queue_snapshot.dart';

import '../support/collection_fixtures.dart';
import 'playlist_smart_shuffle_test.dart' as fixture;

Future<({fixture.Harness h, AppRouter router})> shell(
  WidgetTester tester, {
  int count = 7,
  double textScale = 1,
}) async {
  tester.view.physicalSize = const Size(360, 800);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final h = fixture.Harness(count: count);
  await h.open();
  final preferences = PreferenceController(
    transport: h.transport,
    authority: h.authority,
    fence: collectionFence,
  );
  final router = AppRouter(initialTab: AppTab.library);
  addTearDown(() async {
    await tester.pumpWidget(const SizedBox.shrink());
    router.dispose();
    preferences.dispose();
    await h.close();
  });
  await tester.pumpWidget(
    MaterialApp(
      theme: SoundspanTheme.dark(),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(
          padding: const EdgeInsets.only(top: 24, bottom: 24),
          viewPadding: const EdgeInsets.only(top: 24, bottom: 24),
          textScaler: TextScaler.linear(textScale),
        ),
        child: child!,
      ),
      home: AppShell(
        router: router,
        miniPlayer: const SizedBox(height: 72),
        destinations: {
          for (final tab in AppTab.values)
            tab: (_) => Scaffold(body: Text('${tab.name} root')),
        },
        routeBuilder: (_, destination) => PlaylistDetailScreen(
          playlistId: destination.id,
          controller: h.playlists,
          preferences: preferences,
          smartShuffle: h.smart,
          onPlay: (_) async {},
          autoLoad: false,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  unawaited(
    router.push<void>(const AppDestination(AppRouteKind.playlist, id: 'p')),
  );
  await tester.pumpAndSettle();
  expect(router.stackDepth(AppTab.library), 2);
  return (h: h, router: router);
}

Future<void> select(WidgetTester tester, String label) async {
  await tester.tap(find.byTooltip('Действия с плейлистом'));
  await tester.pumpAndSettle();
  await tester.ensureVisible(find.text(label));
  await tester.tap(find.text(label));
  await tester.pumpAndSettle();
}

Future<void> disable(WidgetTester tester, fixture.Harness h) async {
  await select(tester, 'С находками');
  h.engine.emit(position: const Duration(seconds: 3));
  await tester.pump();
  await h.queue.dispatch(const Pause());
  await select(tester, 'Выключить находки');
  expect(h.smart.active, false);
  expect(h.smart.canUndo, true);
}

void main() {
  testWidgets('AppShell bottom Downloads tap cannot trigger playlist Undo', (
    tester,
  ) async {
    final app = await shell(tester);
    await disable(tester, app.h);
    final before = app.h.queue.snapshot;
    expect(before.entries, hasLength(7));
    await tester.tap(find.text('Загрузки'));
    await tester.pumpAndSettle();
    expect(app.router.currentTab, AppTab.downloads);
    expect(app.h.queue.snapshot.effectiveOrder, before.effectiveOrder);
    expect(app.h.queue.snapshot.playingIntent, false);
    expect(app.h.queue.snapshot.position, before.position);
    expect(tester.takeException(), isNull);
  });

  testWidgets('new smart session removes stale Undo on the retained detail', (
    tester,
  ) async {
    final app = await shell(tester);
    await disable(tester, app.h);
    expect(find.text('Отменить').hitTestable(), findsOneWidget);
    await select(tester, 'С находками');
    app.h.engine.emit(position: const Duration(seconds: 1));
    await tester.pump();
    expect(app.h.smart.active, true);
    expect(app.h.smart.canUndo, false);
    expect(find.text('Отменить'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'new queue generation removes stale Undo without restoring rows',
    (tester) async {
      final app = await shell(tester);
      await disable(tester, app.h);
      await app.h.queue.dispatch(const Next());
      await tester.pumpAndSettle();
      expect(app.h.smart.canUndo, false);
      expect(find.text('Отменить'), findsNothing);
      expect(app.h.queue.snapshot.entries, hasLength(7));
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'large-text inline Undo survives lifecycle and restores only once',
    (tester) async {
      final app = await shell(tester, textScale: 1.8);
      await disable(tester, app.h);
      final current = app.h.queue.snapshot.currentEntryId;
      final loads = app.h.engine.loaded.length;
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await tester.pump(const Duration(minutes: 2));
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(app.h.smart.canUndo, true);
      await tester.ensureVisible(find.text('Отменить'));
      await tester.tap(find.text('Отменить'));
      await tester.pumpAndSettle();
      expect(app.h.smart.active, true);
      expect(app.h.smart.canUndo, false);
      expect(app.h.queue.snapshot.entries, hasLength(9));
      expect(app.h.queue.snapshot.currentEntryId, current);
      expect(app.h.queue.snapshot.playingIntent, false);
      expect(app.h.engine.loaded.length, loads);
      expect(find.text('Отменить'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'completed last finding shows Undo only while its fence is valid',
    (tester) async {
      final app = await shell(tester, count: 1);
      await select(tester, 'С находками');
      final last = app.h.queue.snapshot.entries.last;
      expect(last.smartShuffle?.injected, true);
      await app.h.queue.dispatch(PlayEntry(last.entryId));
      app.h.engine.emit(
        processing: PlaybackProcessing.completed,
        playing: false,
        position: const Duration(seconds: 180),
        duration: const Duration(seconds: 180),
      );
      await tester.pumpAndSettle();
      final before = app.h.queue.snapshot;
      await select(tester, 'Выключить находки');
      final after = app.h.queue.snapshot;
      expect(app.h.smart.active, false);
      expect(after.currentEntryId, before.currentEntryId);
      expect(after.entries, hasLength(2));
      expect(find.text('Отменить').evaluate().isNotEmpty, app.h.smart.canUndo);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('Back during held inline Undo cannot publish a restored tail', (
    tester,
  ) async {
    final app = await shell(tester);
    await disable(tester, app.h);
    app.h.admissionGate = Completer<void>();
    await tester.tap(find.text('Отменить'));
    await tester.pumpAndSettle();
    expect(app.router.back(), true);
    await tester.pumpAndSettle();
    app.h.admissionGate!.complete();
    await tester.pumpAndSettle();
    expect(app.router.stackDepth(AppTab.library), 1);
    expect(app.h.queue.snapshot.entries, hasLength(7));
    expect(find.text('Отменить'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('owner change removes inline Undo from the retained route', (
    tester,
  ) async {
    final app = await shell(tester);
    await disable(tester, app.h);
    app.h.authority.switchOwner();
    await tester.pumpAndSettle();
    expect(app.h.smart.canUndo, false);
    expect(find.text('Отменить'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('two inline Undo taps cannot restore or load the tail twice', (
    tester,
  ) async {
    final app = await shell(tester);
    await disable(tester, app.h);
    final before = app.h.queue.snapshot;
    final loads = app.h.engine.loaded.length;
    app.h.admissionGate = Completer<void>();
    await tester.tap(find.text('Отменить'));
    await tester.pump();
    await tester.tap(find.text('Отменить'));
    await tester.pumpAndSettle();
    app.h.admissionGate!.complete();
    await tester.pumpAndSettle();
    expect(app.h.queue.snapshot.entries, hasLength(9));
    expect(app.h.queue.snapshot.lineage, before.lineage + 1);
    expect(app.h.queue.snapshot.currentEntryId, before.currentEntryId);
    expect(app.h.engine.loaded.length, loads);
    expect(app.h.queue.snapshot.playingIntent, false);
    expect(find.text('Отменить'), findsNothing);
    expect(tester.takeException(), isNull);
  });
}
