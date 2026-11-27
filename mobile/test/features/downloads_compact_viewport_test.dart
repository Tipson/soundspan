import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/app/app_destinations.dart';
import 'package:soundspan/app/app_router.dart';
import 'package:soundspan/app/app_shell.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/design_system/design_system.dart';
import 'package:soundspan/downloads/download_checkpoint.dart';
import 'package:soundspan/downloads/download_models.dart';
import 'package:soundspan/downloads/liked_download_automation.dart';
import 'package:soundspan/features/downloads/downloads_controller.dart';
import 'package:soundspan/features/downloads/downloads_screen.dart';
import 'package:soundspan/features/downloads/storage_status_card.dart';
import 'package:soundspan/features/likes/likes_repository.dart';

import '../downloads/download_fixture.dart';
import '../support/collection_fixtures.dart';

DeviceDownload _job(DownloadState state) => DeviceDownload(
  id: 'a' * 64,
  track: DownloadHarness.track,
  quality: 'original',
  originalFence: collectionFence,
  generation: 1,
  state: state,
  manual: true,
  checkpoint: DownloadCheckpoint(
    generation: 1,
    claim: 'a' * 48,
    bytes: 3 * 1024 * 1024,
  ),
);

void main() {
  for (final ready in [true, false]) {
    testWidgets(
      'storage summary expands details and keeps warning ready=$ready',
      (tester) async {
        const details = 'Объём по данным загрузок приложения.';
        const warning =
            'Проверьте доступ к памяти. Готовые записи остаются в списке; доступность файла проверяется при воспроизведении.';
        await tester.pumpWidget(
          MaterialApp(
            theme: SoundspanTheme.dark(),
            home: RepaintBoundary(
              key: const ValueKey('storage-surface'),
              child: Scaffold(
                body: StorageStatusCard(
                  jobs: [_job(DownloadState.ready), _job(DownloadState.failed)],
                  ready: ready,
                ),
              ),
            ),
          ),
        );
        expect(find.text('1 готовая загрузка · 3.0 МБ'), findsOneWidget);
        expect(find.textContaining(details), findsNothing);
        expect(find.text(warning), ready ? findsNothing : findsOneWidget);
        final tile = find.byType(ExpansionTile);
        expect(tile, findsOneWidget);
        final boundary = tester.renderObject<RenderRepaintBoundary>(
          find.byKey(const ValueKey('storage-surface')),
        );
        final image = boundary.toImageSync();
        try {
          final bytes = (await tester.runAsync(
            () => image.toByteData(format: ui.ImageByteFormat.rawRgba),
          ))!;
          const x = 24, y = 4;
          final offset = (y * image.width + x) * 4;
          expect(
            Color.fromARGB(
              bytes.getUint8(offset + 3),
              bytes.getUint8(offset),
              bytes.getUint8(offset + 1),
              bytes.getUint8(offset + 2),
            ),
            MusicColors.canvas,
          );
        } finally {
          image.dispose();
        }
        await tester.tap(
          find.text(
            ready ? '1 готовая загрузка · 3.0 МБ' : 'Хранилище недоступно',
          ),
        );
        await tester.pumpAndSettle();
        expect(find.textContaining(details), findsOneWidget);
        expect(find.text('1 готовая загрузка · 3.0 МБ'), findsOneWidget);
        expect(find.text(warning), ready ? findsNothing : findsOneWidget);
        await tester.tap(
          find.text(
            ready ? '1 готовая загрузка · 3.0 МБ' : 'Хранилище недоступно',
          ),
        );
        await tester.pumpAndSettle();
        expect(find.textContaining(details), findsNothing);
        expect(find.text(warning), ready ? findsNothing : findsOneWidget);
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets('downloads restore the header after scrolling away and back', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(360, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final harness = (await tester.runAsync(DownloadHarness.create))!;
    final controller = DownloadsController(
      repository: harness.repo,
      fence: harness.fence,
      networkPolicy: const NetworkPolicy.online(),
      storageReady: () => true,
      schedule: (_, _, _) async => 'fixture',
      cancelJob: (_, _, _) async {},
    );
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.runAsync(() async {
        await controller.close();
        controller.dispose();
        await harness.close();
      });
    });
    await tester.runAsync(() async {
      for (var i = 0; i < 24; i++) {
        await harness.repo.enqueue(
          Track(
            ref: LibraryTrackRef('track-$i'),
            title: 'Трек $i',
            artist: 'Автор',
          ),
          'original',
          harness.fence,
        );
      }
      await controller.refresh();
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: SoundspanTheme.dark(),
        home: DownloadsScreen(
          controller: controller,
          autoLoad: false,
          onPlay: (_) async {},
        ),
      ),
    );
    final summary = find.text('0 готовых загрузок · 0 КБ');
    final details = find.textContaining('Объём по данным загрузок приложения.');
    final filters = find.byType(SingleChildScrollView);
    final list = tester
        .state<ScrollableState>(
          find
              .descendant(
                of: find.byType(ListView),
                matching: find.byType(Scrollable),
              )
              .first,
        )
        .position;
    Future<void> scrollAwayAndBack() async {
      list.jumpTo(list.maxScrollExtent);
      await tester.pumpAndSettle();
      expect(find.byType(ExpansionTile), findsNothing);
      list.jumpTo(0);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(find.byType(ErrorWidget), findsNothing);
      expect(summary.hitTestable(), findsOneWidget);
      expect(find.byType(TextField).hitTestable(), findsOneWidget);
      expect(find.text('Поиск в загрузках'), findsOneWidget);
      expect(find.text('Ошибки').hitTestable(), findsOneWidget);
    }

    expect(details, findsNothing);
    await tester.drag(filters, const Offset(-260, 0));
    await tester.pumpAndSettle();
    await scrollAwayAndBack();
    expect(details, findsNothing);
    await tester.tap(summary);
    await tester.pumpAndSettle();
    expect(details, findsOneWidget);
    await scrollAwayAndBack();
    expect(details, findsOneWidget);
  });

  testWidgets(
    '360dp downloads show the first ready track above shell mini footer',
    (tester) async {
      tester.view.physicalSize = const Size(360, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final harness = (await tester.runAsync(DownloadHarness.create))!;
      addTearDown(() => tester.runAsync(harness.close));
      await tester.runAsync(() async {
        final job = await harness.repo.enqueue(
          DownloadHarness.track,
          'original',
          harness.fence,
        );
        final claim = (await harness.repo.claim(
          job.id,
          harness.fence,
          job.generation,
        ))!;
        await harness.repo.updateClaim(
          claim,
          state: DownloadState.ready,
          release: true,
        );
      });
      final automation = LikedDownloadAutomation(
        downloads: harness.repo,
        likes: LikesRepository(
          transport: CollectionTransport((_, _) => likedResponse([])),
          authority: harness.authority,
          fence: harness.fence,
        ),
        fence: harness.fence,
        networkPolicy: const NetworkPolicy.online(),
        storageReady: () => true,
        schedule: (_, _, _) async => 'fixture',
        cancelJob: (_, _, _) async {},
      );
      addTearDown(() => tester.runAsync(automation.close));
      final controller = DownloadsController(
        repository: harness.repo,
        fence: harness.fence,
        networkPolicy: const NetworkPolicy.online(),
        storageReady: () => true,
        schedule: (_, _, _) async => 'fixture',
        cancelJob: (_, _, _) async {},
        automation: automation,
      );
      addTearDown(() async {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.runAsync(controller.close);
        controller.dispose();
      });
      await tester.runAsync(controller.refresh);
      expect(controller.visible, hasLength(1));
      controller.notice = 'Выбрано 1; в загрузках 1.';
      var plays = 0;
      final router = AppRouter(initialTab: AppTab.downloads);
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          builder: (_, child) => MediaQuery(
            data: const MediaQueryData(
              size: Size(360, 800),
              padding: EdgeInsets.only(top: 24, bottom: 24),
              viewPadding: EdgeInsets.only(top: 24, bottom: 24),
            ),
            child: child!,
          ),
          home: AppShell(
            router: router,
            miniPlayer: const SizedBox(height: 72),
            destinations: {
              for (final tab in AppTab.values)
                tab: (_) => tab == AppTab.downloads
                    ? DownloadsScreen(
                        controller: controller,
                        autoLoad: false,
                        onPlay: (_) async {
                          plays++;
                        },
                      )
                    : const SizedBox.shrink(),
            },
            routeBuilder: (_, _) => const SizedBox.shrink(),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final row = find.byType(TrackRow);
      final viewport = tester.getRect(find.byType(ListView));
      expect(row, findsOneWidget);
      expect(tester.getRect(row).bottom, lessThanOrEqualTo(viewport.bottom));
      expect(find.text('Выбрано 1; в загрузках 1.'), findsOneWidget);
      expect(find.text('Автозагрузка Любимого'), findsNothing);
      await tester.tap(find.text('1 готовая загрузка · 0 КБ'));
      await tester.pumpAndSettle();
      expect(find.text('Автозагрузка Любимого'), findsOneWidget);
      expect(find.text('Включена'), findsOneWidget);
      await tester.tap(find.text('1 готовая загрузка · 0 КБ'));
      await tester.pumpAndSettle();
      expect(find.text('Тест').hitTestable(), findsOneWidget);
      await tester.tap(find.text('Тест'));
      await tester.pump();
      expect(plays, 1);
      final horizontal = find.byWidgetPredicate(
        (widget) =>
            widget is SingleChildScrollView &&
            widget.scrollDirection == Axis.horizontal,
      );
      expect(horizontal, findsOneWidget);
      expect(tester.getRect(horizontal).height, greaterThanOrEqualTo(48));
      await tester.drag(horizontal, const Offset(-260, 0));
      await tester.pumpAndSettle();
      expect(find.text('Ошибки').hitTestable(), findsOneWidget);
      await tester.tap(find.text('Ошибки'));
      await tester.pumpAndSettle();
      expect(controller.filter, DownloadsFilter.failed);
      expect(find.text('По выбранным условиям загрузок нет.'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      router.dispose();
    },
  );
}
