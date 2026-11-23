import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/downloads/download_models.dart';
import 'package:soundspan/downloads/download_repository.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/storage/owner_store.dart';
import 'package:soundspan/features/downloads/downloads_controller.dart';
import 'package:soundspan/features/downloads/downloads_screen.dart';
import 'package:soundspan/features/downloads/download_actions_sheet.dart';
import 'package:soundspan/design_system/design_system.dart';

import '../downloads/download_fixture.dart';
import '../support/collection_fixtures.dart';

void main() {
  late DownloadHarness h;
  setUp(() async => h = await DownloadHarness.create());
  tearDown(() async => h.close());
  test('manual selected 1001 tracks are not truncated; permission denial is honest', () async {
    var prompts = 0;
    var scheduled = 0;
    final c = DownloadsController(
      repository: h.repo,
      fence: h.fence,
      networkPolicy: const NetworkPolicy.online(),
      storageReady: () => true,
      schedule: (_, _, _) async {
        scheduled++;
        return 'work';
      },
      cancelJob: (_, _, _) async {},
      requestNotificationPermission: () async {
        prompts++;
        return false;
      },
    );
    addTearDown(c.dispose);
    await c.refresh();
    expect(prompts, 0);
    await c.downloadTracks(List.generate(1001, collectionTrack));
    expect(scheduled, 1001);
    expect(prompts, 1);
    expect(c.notice, contains('уведомлен'));
  }, timeout: const Timeout(Duration(minutes: 3)));
  test('manual offline request does not prompt or enqueue', () async {
    var prompts = 0;
    final c = DownloadsController(
      repository: h.repo,
      fence: h.fence,
      networkPolicy: const NetworkPolicy.offline(),
      storageReady: () => true,
      schedule: (_, _, _) async => 'x',
      cancelJob: (_, _, _) async {},
      requestNotificationPermission: () async {
        prompts++;
        return false;
      },
    );
    addTearDown(c.dispose);
    await c.downloadTracks([DownloadHarness.track]);
    expect(prompts, 0);
    expect(await h.repo.list(h.fence), isEmpty);
    expect(c.failure?.code, 'offline_mode');
  });
  test('pause resume cancel retry carry exact generations and safe repository removal', () async {
    final scheduled = <int>[];
    final cancelled = <int>[];
    var releases = 0;
    h.beforeRemove = (_) async => releases++;
    final c = DownloadsController(
      repository: h.repo,
      fence: h.fence,
      networkPolicy: const NetworkPolicy.online(),
      storageReady: () => true,
      schedule: (_, _, g) async {
        scheduled.add(g);
        return 'x';
      },
      cancelJob: (_, _, g) async {
        cancelled.add(g);
      },
    );
    addTearDown(c.dispose);
    await c.downloadTracks([DownloadHarness.track]);
    await c.pause(c.visible.single);
    expect(c.visible.single.state, DownloadState.paused);
    await c.resume(c.visible.single);
    expect(c.visible.single.state, DownloadState.queued);
    await c.cancel(c.visible.single);
    expect(c.visible.single.errorCode, 'download_cancelled');
    await c.retry(c.visible.single);
    await c.remove(c.visible.single);
    expect(scheduled, [1, 3, 5]);
    expect(cancelled, [1, 3, 5]);
    expect(releases, 1);
    expect(c.visible, isEmpty);
  });
  test('ready playback preserves filtered displayed rows including duplicate track identities', () async {
    for (final q in ['original', 'high']) {
      final j = await h.repo.enqueue(DownloadHarness.track, q, h.fence);
      final claimed = (await h.repo.claim(j.id, h.fence, j.generation))!;
      await h.repo.updateClaim(
        claimed,
        state: DownloadState.ready,
        release: true,
      );
    }
    final c = DownloadsController(
      repository: h.repo,
      fence: h.fence,
      networkPolicy: const NetworkPolicy.offline(),
      storageReady: () => true,
      schedule: (_, _, _) async => 'x',
      cancelJob: (_, _, _) async {},
    );
    addTearDown(c.dispose);
    await c.refresh();
    c.setQuery('Тест');
    final request = c.play(c.visible.last);
    expect(request.tracks.length, 2);
    expect(request.startIndex, 1);
    expect(request.fence, h.fence);
  });
  testWidgets('narrow large text uses lazy rows and no prompt on mount', (
    tester,
  ) async {
    var prompts = 0;
    final c = DownloadsController(
      repository: h.repo,
      fence: h.fence,
      networkPolicy: const NetworkPolicy.online(),
      storageReady: () => true,
      schedule: (_, _, _) async => 'x',
      cancelJob: (_, _, _) async {},
      requestNotificationPermission: () async {
        prompts++;
        return true;
      },
    );
    addTearDown(c.dispose);
    await tester.runAsync(() async {
      await h.repo.enqueue(collectionTrack(1), 'original', h.fence);
      await c.refresh();
    });
    tester.view.physicalSize = const Size(320, 700);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        theme: SoundspanTheme.dark(),
        home: MediaQuery(
          data: const MediaQueryData(textScaler: TextScaler.linear(2)),
          child: DownloadsScreen(
            controller: c,
            autoLoad: false,
            onPlay: (_) async {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(prompts, 0);
    expect(find.byType(ListView), findsOneWidget);
  });
  testWidgets(
    'collection selection landscape text2 shows exact count and Back has no effects',
    (tester) async {
      var prompts = 0;
      final c = DownloadsController(
        repository: h.repo,
        fence: h.fence,
        networkPolicy: const NetworkPolicy.online(),
        storageReady: () => true,
        schedule: (_, _, _) async => 'x',
        cancelJob: (_, _, _) async {},
        requestNotificationPermission: () async {
          prompts++;
          return true;
        },
      );
      addTearDown(c.dispose);
      tester.view.physicalSize = const Size(700, 320);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: const TextScaler.linear(2)),
            child: child!,
          ),
          home: MediaQuery(
            data: const MediaQueryData(
              size: Size(700, 320),
              textScaler: TextScaler.linear(2),
            ),
            child: Builder(
              builder: (context) => Scaffold(
                body: TextButton(
                  onPressed: () => DownloadActionsSheet.confirmSelection(
                    context,
                    c,
                    List.generate(1001, collectionTrack),
                  ),
                  child: const Text('Выбрать'),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Выбрать'));
      await tester.pumpAndSettle();
      expect(find.text('Скачать 1001 треков'), findsOneWidget);
      expect(find.byType(CheckboxListTile).evaluate().length, lessThan(20));
      expect(tester.takeException(), isNull);
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(prompts, 0);
      expect(await tester.runAsync(() => h.repo.list(h.fence)), isEmpty);
    },
  );
  testWidgets(
    '1001 download rows stay lazy at 320 390 430 and landscape with text2',
    (tester) async {
      final c = DownloadsController(
        repository: h.repo,
        fence: h.fence,
        networkPolicy: const NetworkPolicy.offline(),
        storageReady: () => true,
        schedule: (_, _, _) async => 'x',
        cancelJob: (_, _, _) async {},
      );
      addTearDown(c.dispose);
      await tester.runAsync(() async {
        await h.store.transaction(h.fence, (tx) async {
          for (var i = 0; i < 1001; i++) {
            final track = collectionTrack(i);
            final id = h.repo.key(track.ref, 'original', h.fence.owner);
            await tx.write(
              DownloadRepository.namespace,
              id,
              DeviceDownload(
                id: id,
                track: track,
                quality: 'original',
                originalFence: h.fence,
                generation: 1,
                state: DownloadState.queued,
                manual: true,
              ).toJson(),
            );
          }
        });
        await c.refresh();
      });
      expect(c.jobs, hasLength(1001));
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      for (final size in [
        const Size(320, 700),
        const Size(390, 800),
        const Size(430, 850),
        const Size(700, 320),
      ]) {
        tester.view.physicalSize = size;
        await tester.pumpWidget(
          MaterialApp(
            key: ValueKey(size),
            theme: SoundspanTheme.dark(),
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context)
                  .copyWith(textScaler: const TextScaler.linear(2)),
              child: child!,
            ),
            home: DownloadsScreen(
              controller: c,
              autoLoad: false,
              onPlay: (_) async {},
            ),
          ),
        );
        await tester.pumpAndSettle();
        await tester.drag(find.byType(ListView), const Offset(0, -1500));
        await tester.pumpAndSettle();
        expect(
          find.byType(TrackRow).evaluate().length,
          inInclusiveRange(1, 19),
        );
        expect(tester.takeException(), isNull, reason: '$size');
      }
    },
  );
  testWidgets(
    'hidden or disabled TickerMode downloads never poll retained rows',
    (tester) async {
      final store = _CountingStore(h.store);
      final repo = DownloadRepository(
        store: store,
        authority: h.authority,
        paths: h.paths,
        verifier: h.repo.verifier,
        beforeRemove: (_) async {},
      );
      final c = DownloadsController(
        repository: repo,
        fence: h.fence,
        networkPolicy: const NetworkPolicy.online(),
        storageReady: () => true,
        schedule: (_, _, _) async => 'x',
        cancelJob: (_, _, _) async {},
      );
      addTearDown(c.dispose);
      final visibility = ValueNotifier(false);
      addTearDown(visibility.dispose);
      Widget view(bool ticker) => MaterialApp(
        theme: SoundspanTheme.dark(),
        home: TickerMode(
          enabled: ticker,
          child: DownloadsScreen(
            controller: c,
            visible: visibility,
            onPlay: (_) async {},
          ),
        ),
      );
      await tester.pumpWidget(view(false));
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 10)),
      );
      final initial = store.transactions;
      await tester.pump(const Duration(seconds: 3));
      expect(store.transactions, initial);
      visibility.value = true;
      await tester.pump(const Duration(seconds: 3));
      expect(store.transactions, initial);
      await tester.pumpWidget(view(true));
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 10)),
      );
      expect(store.transactions, greaterThan(initial));
      await tester.pumpWidget(view(false));
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 10)),
      );
      final stopped = store.transactions;
      await tester.pump(const Duration(seconds: 3));
      expect(store.transactions, stopped);
      await tester.pumpWidget(const SizedBox());
      await c.close();
    },
  );
  testWidgets(
    'screen mounted while already backgrounded does not start polling',
    (tester) async {
      final store = _CountingStore(h.store);
      final repo = DownloadRepository(
        store: store,
        authority: h.authority,
        paths: h.paths,
        verifier: h.repo.verifier,
        beforeRemove: (_) async {},
      );
      final c = DownloadsController(
        repository: repo,
        fence: h.fence,
        networkPolicy: const NetworkPolicy.online(),
        storageReady: () => true,
        schedule: (_, _, _) async => 'x',
        cancelJob: (_, _, _) async {},
      );
      addTearDown(c.dispose);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      addTearDown(
        () => tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        ),
      );
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: DownloadsScreen(controller: c, onPlay: (_) async {}),
        ),
      );
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 10)),
      );
      final initial = store.transactions;
      await tester.pump(const Duration(seconds: 3));
      expect(store.transactions, initial);
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 10)),
      );
      await tester.pumpWidget(const SizedBox());
      await c.close();
    },
  );
}

class _CountingStore implements OwnerStore {
  _CountingStore(this.delegate);
  final OwnerStore delegate;
  int transactions = 0;
  @override
  Future<T> transaction<T>(
    SessionFence fence,
    Future<T> Function(OwnerTransaction) body,
  ) {
    transactions++;
    return delegate.transaction(fence, body);
  }
}
