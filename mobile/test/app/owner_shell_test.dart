import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/app/collection_track_picker.dart';
import 'package:soundspan/app/add_to_playlist_sheet.dart';
import 'package:soundspan/app/app_destinations.dart';
import 'package:soundspan/app/app_router.dart';
import 'package:soundspan/app/app_shell.dart';
import 'package:soundspan/app/owner_visibility.dart';
import 'package:soundspan/app/owner_services.dart';
import 'package:soundspan/app/owner_ui_session.dart';
import 'package:soundspan/app/owner_shell.dart';
import 'package:soundspan/app/app_visibility_controller.dart';
import 'package:soundspan/design_system/design_system.dart';
import 'package:soundspan/features/home/home_screen.dart';
import 'package:soundspan/features/wave/wave_screen.dart';
import 'package:soundspan/features/search/search_screen.dart';
import 'package:soundspan/features/library/library_screen.dart';
import 'package:soundspan/features/library/library_models.dart';
import 'package:soundspan/features/downloads/downloads_screen.dart';
import 'package:soundspan/features/settings/settings_screen.dart';
import 'package:soundspan/features/shares/share_sheet.dart';
import 'package:soundspan/features/inbox/inbox_screen.dart';
import 'package:soundspan/features/settings/profile_screen.dart';
import 'package:soundspan/features/settings/playback_settings_screen.dart';
import 'package:soundspan/features/settings/offline_settings_screen.dart';
import 'package:soundspan/features/history/history_screen.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/features/playlists/playlist_controller.dart';
import 'package:soundspan/features/playlists/playlist_repository.dart';
import 'package:soundspan/features/playlists/playlist_editor_sheet.dart';
import 'package:soundspan/features/player/player_controller.dart';
import 'package:soundspan/features/likes/preference_controller.dart';

import '../support/collection_fixtures.dart';
import '../support/wave_reporting_fixtures.dart';

void main() {
  testWidgets(
    'existing-playlist add requires explicit lossy subset review before POST',
    (tester) async {
      final authority = CollectionAuthority();
      final summary = {
        'id': 'p',
        'name': 'Мой плейлист',
        'isOwner': true,
        'isPublic': false,
        'isHidden': false,
        'trackCount': 0,
      };
      final transport = CollectionTransport(
        (request, _) => ApiResponse(
          200,
          request.path == '/api/playlists'
              ? [summary]
              : request.method == ApiMethod.get
              ? {
                  ...summary,
                  'mergedItems': [],
                  'totalItemCount': 0,
                  'pagination': {'hasMore': false, 'nextCursor': null},
                }
              : {},
        ),
      );
      final controller = PlaylistController(
        repository: PlaylistRepository(
          transport: transport,
          authority: authority,
          fence: collectionFence,
        ),
      );
      final track = collectionTrack(1);
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () => showModalBottomSheet(
                  context: context,
                  isScrollControlled: true,
                  builder: (_) => AddToPlaylistSheet(
                    controller: controller,
                    tracks: [track, track, collectionTrack(2, playable: false)],
                    assertCurrent: () =>
                        authority.assertCurrent(collectionFence),
                  ),
                ),
                child: const Text('Открыть'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Открыть'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Мой плейлист'));
      await tester.pump();
      expect(
        transport.requests.where((r) => r.method == ApiMethod.post),
        isEmpty,
      );
      expect(
        tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
        isNull,
      );
      await tester.tap(find.byType(CheckboxListTile));
      await tester.pump();
      await tester.tap(find.text('Добавить 1'));
      await tester.pumpAndSettle();
      final writes = transport.requests
          .where((r) => r.method == ApiMethod.post)
          .toList();
      expect(writes, hasLength(1));
      expect(writes.single.path, '/api/playlists/p/items');
      expect(writes.single.body, {'trackId': 'local-1'});
      await tester.pumpWidget(const SizedBox.shrink());
      controller.dispose();
      await authority.updates.close();
    },
  );
  testWidgets(
    'captured player queue cannot save after another queue replaced it',
    (tester) async {
      final authority = CollectionAuthority();
      final transport = CollectionTransport(
        (_, _) => preferenceResponse('local-1', 'clear'),
      );
      final playback = CollectionPlayback(
        QueueSnapshot(fence: collectionFence),
      );
      final entries = playback.createEntries([
        collectionTrack(1),
      ], const PlayContext(surface: PlaySurface.library));
      playback.value = QueueSnapshot(
        fence: collectionFence,
        entries: entries,
        effectiveOrder: entries.map((e) => e.entryId),
        currentEntryId: entries.first.entryId,
      );
      final preferences = PreferenceController(
        transport: transport,
        authority: authority,
        fence: collectionFence,
      );
      final player = PlayerController(
        playback: playback,
        authority: authority,
        fence: collectionFence,
        preferences: preferences,
      );
      final target = player.captureQueue()!;
      final controller = PlaylistController(
        repository: PlaylistRepository(
          transport: transport,
          authority: authority,
          fence: collectionFence,
        ),
      );
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () => PlaylistEditorSheet.show(
                  context,
                  controller: controller,
                  queue: target.tracks,
                  beforeSave: target.assertCurrent,
                ),
                child: const Text('Открыть'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Открыть'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('playlist-name')),
        'Очередь',
      );
      playback.value = QueueSnapshot(fence: collectionFence, lineage: 1);
      await tester.tap(find.text('Создать плейлист'));
      await tester.pumpAndSettle();
      expect(
        transport.requests.where((r) => r.method == ApiMethod.post),
        isEmpty,
      );
      expect(
        find.text('Музыка изменилась. Выберите действие снова.'),
        findsOneWidget,
      );
      await tester.pumpWidget(const SizedBox.shrink());
      controller.dispose();
      player.dispose();
      preferences.dispose();
      await authority.updates.close();
    },
  );
  testWidgets(
    'actual owner shell has five tabs and settings opens visible profile above root overlay',
    (tester) async {
      late Directory directory;
      late NativeOwnerServices native;
      late OwnerUiSession session;
      final authority = CollectionAuthority();
      final visibility = AppVisibilityController();
      await tester.runAsync(() async {
        final base = await Directory('D:/CodexData/temp/soundspan-owner-shell')
            .create(recursive: true);
        directory = Directory(
          await (await base.createTemp()).resolveSymbolicLinks(),
        );
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
          playback: CollectionPlayback(QueueSnapshot(fence: collectionFence)),
          supportDirectory: directory,
          cancelDownloads: (_) async {},
        );
        session = await OwnerUiSession.create(
          owner: native,
          logout: authority.invalidate,
        );
      });
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          navigatorObservers: [visibility],
          home: OwnerShell(session: session, rootExposure: visibility),
        ),
      );
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 20)),
      );
      await tester.pumpAndSettle();
      expect(find.byType(HomeScreen), findsOneWidget);
      final startWave = tester
          .widget<HomeScreen>(find.byType(HomeScreen))
          .onStartWave!;
      await expectLater(
        Future<void>.sync(startWave),
        throwsA(
          isA<AppFailure>().having(
            (failure) => failure.code,
            'code',
            'offline_mode',
          ),
        ),
        reason: 'Production Home callback must expose the actual Wave failure',
      );
      for (final entry in {
        AppTab.wave: WaveScreen,
        AppTab.search: SearchScreen,
        AppTab.library: LibraryScreen,
        AppTab.downloads: DownloadsScreen,
      }.entries) {
        session.router.selectTab(entry.key);
        await tester.pump();
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 30)),
        );
        await tester.pumpAndSettle();
        expect(find.byType(entry.value), findsOneWidget);
      }
      session.router.selectTab(AppTab.library);
      await tester.pumpAndSettle();
      await tester
          .widget<LibraryScreen>(find.byType(LibraryScreen))
          .onOpenEntity!(
        const SavedEntityRef(
          kind: SavedEntityKind.artist,
          source: 'unknown-provider',
          entityId: 'unproven-id',
          title: 'Искомый исполнитель',
        ),
      );
      await tester.pumpAndSettle();
      expect(session.router.currentTab, AppTab.search);
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        'Искомый исполнитель',
      );
      final downloadSelection = tester
          .widget<SearchScreen>(find.byType(SearchScreen))
          .actions
          .download!([collectionTrack(1)], collectionFence);
      await tester.pumpAndSettle();
      expect(find.text('Скачать выбранную музыку'), findsOneWidget);
      await tester.tap(find.text('Отмена'));
      await tester.pumpAndSettle();
      await downloadSelection;
      expect(session.downloads.jobs, isEmpty);
      final retiredDownload = tester
          .widget<SearchScreen>(find.byType(SearchScreen))
          .actions
          .download!;
      session.router.selectTab(AppTab.library);
      await tester.pumpAndSettle();
      final retiredSelection = retiredDownload([
        collectionTrack(1),
      ], collectionFence);
      await tester.pumpAndSettle();
      expect(find.text('Скачать выбранную музыку'), findsNothing);
      await retiredSelection;
      final settingsRoute = session.router.openOverlay<void>(
        const AppDestination(AppRouteKind.settings),
      );
      await tester.pumpAndSettle();
      expect(find.byType(SettingsScreen), findsOneWidget);
      tester.widget<SettingsScreen>(find.byType(SettingsScreen)).onShares!();
      await tester.pumpAndSettle();
      expect(find.byType(ShareSheet), findsOneWidget);
      session.router.back();
      await tester.pumpAndSettle();
      tester.widget<SettingsScreen>(find.byType(SettingsScreen)).onInbox!();
      await tester.pumpAndSettle();
      expect(find.byType(InboxScreen), findsOneWidget);
      session.router.back();
      await tester.pumpAndSettle();
      await tester.tap(find.text('Профиль'));
      await tester.pumpAndSettle();
      expect(find.byType(ProfileScreen), findsOneWidget);
      session.router.back();
      await tester.pumpAndSettle();
      expect(find.byType(SettingsScreen), findsOneWidget);
      await tester.tap(find.text('Воспроизведение'));
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<PlaybackSettingsScreen>(find.byType(PlaybackSettingsScreen))
            .gainAvailable,
        isFalse,
      );
      native.gainAvailable.value = true;
      native.loudnessFailure.value = const AppFailure(
        code: 'fixture',
        message: 'Проверка предупреждения громкости',
      );
      await tester.pump();
      expect(
        tester
            .widget<PlaybackSettingsScreen>(find.byType(PlaybackSettingsScreen))
            .gainAvailable,
        isTrue,
      );
      expect(find.text('Проверка предупреждения громкости'), findsOneWidget);
      session.router.back();
      await tester.pumpAndSettle();
      session.router.back();
      await tester.pumpAndSettle();
      await settingsRoute;

      session.router.selectTab(AppTab.search);
      await tester.pumpAndSettle();
      final retainedSearchRoute = session.router.push<void>(
        const AppDestination(AppRouteKind.history),
      );
      await tester.pumpAndSettle();
      expect(find.byType(HistoryScreen), findsOneWidget);
      final searchDepth = session.router.stackDepth(AppTab.search);
      expect(searchDepth, 2);
      session.router.selectTab(AppTab.home);
      await tester.pumpAndSettle();
      final playback = native.playback as CollectionPlayback;
      final entries = playback.createEntries([
        collectionTrack(1),
        collectionTrack(2),
      ], const PlayContext(surface: PlaySurface.library));
      playback.value = QueueSnapshot(
        fence: collectionFence,
        entries: entries,
        effectiveOrder: entries.map((entry) => entry.entryId),
        currentEntryId: entries.first.entryId,
        position: const Duration(seconds: 17),
        duration: const Duration(seconds: 180),
        playingIntent: true,
        generation: 3,
        lineage: 4,
      );
      final queueBeforeNavigation = playback.snapshot;
      final commandsBeforeNavigation = playback.commands.length;
      await tester.tap(find.byTooltip('Настройки'));
      await tester.pumpAndSettle();
      expect(find.byType(SettingsScreen), findsOneWidget);
      await tester.ensureVisible(find.text('Офлайн и загрузки'));
      await tester.tap(find.text('Офлайн и загрузки'));
      await tester.pumpAndSettle();
      expect(find.byType(OfflineSettingsScreen), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.scrollUntilVisible(
        find.text('Управлять загрузками').hitTestable(),
        200,
        scrollable: find
            .descendant(
              of: find.byType(OfflineSettingsScreen),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      await tester.tap(find.text('Управлять загрузками').hitTestable());
      await tester.pumpAndSettle();
      expect(session.router.currentTab, AppTab.downloads);
      expect(find.byType(DownloadsScreen), findsOneWidget);
      expect(find.byType(SettingsScreen), findsNothing);
      expect(find.byType(OfflineSettingsScreen), findsNothing);
      expect(visibility.value, isTrue);
      expect(session.router.stackDepth(AppTab.search), searchDepth);
      expect(identical(playback.snapshot, queueBeforeNavigation), isTrue);
      expect(playback.commands.length, commandsBeforeNavigation);
      session.router.selectTab(AppTab.search);
      await tester.pumpAndSettle();
      expect(find.byType(HistoryScreen), findsOneWidget);
      session.router.back();
      await tester.pumpAndSettle();
      await retainedSearchRoute;
      await tester.pumpWidget(const SizedBox.shrink());
      final sessionClosing = session.close();
      await _drain(tester, sessionClosing);
      final nativeClosing = native.close();
      await _drain(tester, nativeClosing);
      final authorityClosing = authority.updates.close();
      await tester.pump();
      await authorityClosing;
      await tester.runAsync(() => directory.delete(recursive: true));
      visibility.dispose();
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'closing queue editor during target admission sends no mutation',
    (tester) async {
      final authority = CollectionAuthority();
      final transport = CollectionTransport((_, _) => ApiResponse(500, {}));
      final controller = PlaylistController(
        repository: PlaylistRepository(
          transport: transport,
          authority: authority,
          fence: collectionFence,
        ),
      );
      final gate = Completer<void>();
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () => PlaylistEditorSheet.show(
                  context,
                  controller: controller,
                  queue: [collectionTrack(1)],
                  beforeSave: () => gate.future,
                ),
                child: const Text('Открыть'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Открыть'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('playlist-name')),
        'Очередь',
      );
      await tester.tap(find.text('Создать плейлист'));
      await tester.pump();
      await tester.tap(find.byTooltip('Закрыть'));
      await tester.pumpAndSettle();
      gate.complete();
      await tester.pumpAndSettle();
      expect(transport.requests, isEmpty);
      await tester.pumpWidget(const SizedBox.shrink());
      controller.dispose();
      await authority.updates.close();
    },
  );
  testWidgets(
    'picker retains chosen rows across search and returns one batch',
    (tester) async {
      final first = collectionTrack(1), second = collectionTrack(2);
      List<dynamic>? result;
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () async {
                  result = await showModalBottomSheet(
                    context: context,
                    isScrollControlled: true,
                    builder: (_) => CollectionTrackPicker(
                      initial: [first, second],
                      search: (_) async => [second],
                      isCurrent: () => true,
                    ),
                  );
                },
                child: const Text('Открыть'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Открыть'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(ValueKey('pick-${first.ref.identityKey}')));
      await tester.enterText(find.byType(TextField), 'поиск');
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(ValueKey('pick-${second.ref.identityKey}')));
      await tester.pump();
      await tester.tap(find.text('Добавить 2'));
      await tester.pumpAndSettle();
      expect(result, [first, second]);
    },
  );
  testWidgets(
    'picker remains usable with large text and keyboard on a narrow phone',
    (tester) async {
      tester.view.physicalSize = const Size(320, 640);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context).copyWith(
              textScaler: const TextScaler.linear(2),
              viewInsets: const EdgeInsets.only(bottom: 260),
            ),
            child: child!,
          ),
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () => showModalBottomSheet(
                  context: context,
                  isScrollControlled: true,
                  builder: (_) => CollectionTrackPicker(
                    initial: [collectionTrack(1)],
                    search: (_) async => [],
                    isCurrent: () => true,
                  ),
                ),
                child: const Text('Открыть'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Открыть'));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(find.byTooltip('Закрыть').hitTestable(), findsOneWidget);
      await tester.tap(find.byTooltip('Закрыть'));
      await tester.pumpAndSettle();
    },
  );
  testWidgets('lossy playlist review scrolls at large text on a narrow phone', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 640);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final authority = CollectionAuthority();
    final controller = PlaylistController(
      repository: PlaylistRepository(
        transport: CollectionTransport((_, _) => const ApiResponse(200, [])),
        authority: authority,
        fence: collectionFence,
      ),
    );
    final track = collectionTrack(1);
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: const TextScaler.linear(2)),
          child: child!,
        ),
        home: Scaffold(
          body: AddToPlaylistSheet(
            controller: controller,
            tracks: [track, track],
            assertCurrent: () async {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await tester.ensureVisible(find.byType(Checkbox));
    await tester.pumpAndSettle();
    await tester.tap(find.byType(Checkbox));
    await tester.pump();
    expect(
      tester.widget<CheckboxListTile>(find.byType(CheckboxListTile)).value,
      isTrue,
    );
    await tester.pumpWidget(const SizedBox.shrink());
    controller.dispose();
    await authority.updates.close();
  });
  testWidgets('radio route opens and exposure follows root/tab/stack', (
    tester,
  ) async {
    final router = AppRouter();
    final root = ValueNotifier(true);
    final visibility = OwnerVisibility(router: router, root: root);
    await tester.pumpWidget(
      MaterialApp(
        home: AppShell(
          router: router,
          destinations: {
            for (final tab in AppTab.values) tab: (_) => Text(tab.label),
          },
          routeBuilder: (_, destination) =>
              Scaffold(body: Text(destination.kind.name)),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(visibility.home.value, isTrue);
    final route = router.push<void>(const AppDestination(AppRouteKind.radio));
    await tester.pumpAndSettle();
    expect(find.text('radio'), findsOneWidget);
    expect(visibility.home.value, isFalse);
    router.back();
    await tester.pumpAndSettle();
    await route;
    router.selectTab(AppTab.downloads);
    await tester.pumpAndSettle();
    expect(visibility.downloads.value, isTrue);
    root.value = false;
    expect(visibility.downloads.value, isFalse);
    await tester.pumpWidget(const SizedBox.shrink());
    visibility.dispose();
    router.dispose();
    root.dispose();
  });
}

// These fixtures combine fake scheduler callbacks with real private-file IO.
// Keep both event loops moving while verifying that each close really drains.
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
  expect(
    done,
    isTrue,
    reason: 'Owner close must finish with both event loops serviced',
  );
  if (error != null) throw error!;
}
