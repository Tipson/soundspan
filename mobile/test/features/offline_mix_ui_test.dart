import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/design_system/design_system.dart';
import 'package:soundspan/downloads/offline_mix_repository.dart';
import 'package:soundspan/features/downloads/downloads_controller.dart';
import 'package:soundspan/features/downloads/offline_mix_card.dart';
import 'package:soundspan/features/downloads/offline_mix_controller.dart';
import 'package:soundspan/features/downloads/offline_mix_screen.dart';
import 'package:soundspan/features/home/home_models.dart';
import 'package:soundspan/features/library/library_models.dart';

import '../downloads/download_fixture.dart';

// These widgets use only the generated loopback HTTPS/WAV fixture. Flutter's
// default status-400 HTTP substitute would prevent preparing their real files.
class _FixtureBinding extends AutomatedTestWidgetsFlutterBinding {
  @override
  bool get overrideHttpClient => false;
}

void main() {
  _FixtureBinding();
  late DownloadHarness h;
  late DownloadsController downloads;
  late OfflineMixController offline;
  var immediate = true;
  Future<void> prepare(WidgetTester tester) async {
    immediate = true;
    await tester.runAsync(() async {
      h = await DownloadHarness.create();
      downloads = DownloadsController(
        repository: h.repo,
        fence: h.fence,
        networkPolicy: const NetworkPolicy.online(),
        storageReady: () => true,
        schedule: (id, f, g) async {
          if (immediate) await h.runner.run(id, f, g);
          return 'work';
        },
        cancelJob: (_, _, _) async {},
      );
      offline = OfflineMixController(
        repository: OfflineMixRepository(downloads: h.repo, fence: h.fence),
        downloads: downloads,
      );
    });
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.runAsync(() async {
        await offline.close();
        offline.dispose();
        await downloads.close();
        downloads.dispose();
        await h.close();
      });
    });
  }

  MusicMix mix(List<Track> tracks) => MusicMix(
    id: 'daily-ui',
    title: 'Мой сохранённый микс с полным длинным названием',
    description: '',
    kind: MusicMixKind.daily,
    tracks: tracks,
  );
  MaterialApp app(Widget child, {double scale = 1}) => MaterialApp(
    theme: SoundspanTheme.dark(),
    builder: (context, child) => MediaQuery(
      data: MediaQuery.of(context)
          .copyWith(textScaler: TextScaler.linear(scale)),
      child: child!,
    ),
    home: child,
  );

  testWidgets(
    'empty offline card explains where to choose a mix and does not expose Play',
    (tester) async {
      await prepare(tester);
      var choices = 0;
      await tester.pumpWidget(
        app(
          Scaffold(
            body: OfflineMixCard(
              controller: offline,
              onOpen: () => fail('No saved mix to open'),
              onChoose: () => choices++,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Сохранённый микс'), findsOneWidget);
      await tester.tap(find.text('Выбрать подборку'));
      expect(choices, 1);
      expect(find.text('Слушать'), findsNothing);
    },
  );

  testWidgets(
    'pending card has finite progress and keeps the old mix reachable at320/text2',
    (tester) async {
      await prepare(tester);
      await tester.runAsync(() => offline.save(mix([DownloadHarness.track])));
      immediate = false;
      await tester.runAsync(
        () => offline.save(
          mix([
            DownloadHarness.track,
            const Track(
              ref: LibraryTrackRef('second'),
              title: 'Другой трек',
              artist: 'Автор',
            ),
          ]),
        ),
      );
      tester.view.physicalSize = const Size(320, 640);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      var opens = 0;
      await tester.pumpWidget(
        app(
          Scaffold(
            body: SingleChildScrollView(
              child: OfflineMixCard(controller: offline, onOpen: () => opens++),
            ),
          ),
          scale: 2,
        ),
      );
      await tester.pumpAndSettle();
      final progress = tester.widget<LinearProgressIndicator>(
        find.byType(LinearProgressIndicator),
      );
      expect(progress.value, 0.5);
      expect(find.textContaining('1 из 2'), findsOneWidget);
      await tester.ensureVisible(find.text('Открыть'));
      await tester.tap(find.text('Открыть'));
      expect(opens, 1);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'download list rebuilding every second cannot starve offline progress polling',
    (tester) async {
      await prepare(tester);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      expect(tester.binding.lifecycleState, AppLifecycleState.resumed);
      immediate = false;
      await tester.runAsync(
        () => offline.save(
          mix([
            DownloadHarness.track,
            const Track(
              ref: LibraryTrackRef('second'),
              title: 'Другой',
              artist: 'Автор',
            ),
          ]),
        ),
      );
      late String completedKey;
      late Map<String, Object?> readyRow;
      await tester.runAsync(() async {
        final first = (await h.repo.list(h.fence)).first;
        completedKey = h.store.rows.keys.singleWhere(
          (key) => key.endsWith('|${first.id}'),
        );
        final queuedRow = h.store.rows[completedKey]!;
        await h.runner.run(first.id, h.fence, first.generation);
        readyRow = h.store.rows[completedKey]!;
        expect(readyRow['state'], 'ready');
        h.store.rows[completedKey] = queuedRow;
      });
      final rebuild = ValueNotifier(0);
      final visible = ValueNotifier(false);
      addTearDown(rebuild.dispose);
      addTearDown(visible.dispose);
      await tester.pumpWidget(
        app(
          Scaffold(
            body: ValueListenableBuilder<int>(
              valueListenable: rebuild,
              builder: (_, value, child) => OfflineMixCard(
                controller: offline,
                onOpen: () {},
                visible: visible,
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Загружено 0 из 2'), findsOneWidget);
      visible.value = true;
      // External worker commit: publish the real prepared row in the fixture
      // without running socket/file IO across Flutter's fake-async boundary.
      h.store.rows[completedKey] = readyRow;
      expect(offline.busy, isFalse);
      for (var i = 0; i < 5; i++) {
        await tester.pump(const Duration(seconds: 1));
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 20)),
        );
        await tester.pump();
        rebuild.value++;
        await tester.pump();
      }
      expect(find.text('Загружено 1 из 2'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'offline detail plays the frozen generation, pins a row and returns with Back',
    (tester) async {
      await prepare(tester);
      immediate = true;
      await tester.runAsync(() => offline.save(mix([DownloadHarness.track])));
      final plays = <CollectionPlaybackRequest>[];
      await tester.pumpWidget(
        app(
          Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => OfflineMixScreen(
                      controller: offline,
                      onPlay: (r) async {
                        plays.add(r);
                      },
                    ),
                  ),
                ),
                child: const Text('Открыть экран'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Открыть экран'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Слушать'));
      await tester.pumpAndSettle();
      expect(plays, hasLength(1));
      expect(
        plays.single.context.offlineMixGeneration,
        offline.state.active!.generation,
      );
      expect(plays.single.fence, h.fence);
      await tester.tap(find.byTooltip('Действия с офлайн-треком «Тест»'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Оставить на устройстве'));
      await tester.pump();
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 30)),
      );
      await tester.pumpAndSettle();
      final pinned = await tester.runAsync(() => h.repo.list(h.fence));
      expect(pinned!.single.origins, contains('manual'));
      await tester.tap(find.byType(BackButton));
      await tester.pumpAndSettle();
      expect(find.text('Открыть экран'), findsOneWidget);
      expect(plays, hasLength(1));
      expect(tester.takeException(), isNull);
    },
  );
}
