import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:crypto/crypto.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/core/network/stored_network_policy.dart';
import 'package:soundspan/design_system/design_system.dart';
import 'package:soundspan/downloads/download_models.dart';
import 'package:soundspan/downloads/download_checkpoint.dart';
import 'package:soundspan/downloads/offline_mix_daily_refresh.dart';
import 'package:soundspan/downloads/offline_mix_refresh_policy.dart';
import 'package:soundspan/downloads/offline_mix_repository.dart';
import 'package:soundspan/features/downloads/downloads_controller.dart';
import 'package:soundspan/features/downloads/offline_mix_controller.dart';
import 'package:soundspan/features/home/home_models.dart';
import 'package:soundspan/features/settings/offline_settings_screen.dart';

import '../downloads/download_fixture.dart';

void main() {
  late DownloadHarness h;
  late DownloadsController downloads;
  late OfflineMixController controller;
  late StoredNetworkPolicy network;
  final scheduled = <int>[], cancelled = <int>[];
  var failSchedule = false, closed = false, initialized = false;
  setUp(() async {
    closed = false;
    initialized = false;
    failSchedule = false;
    scheduled.clear();
    cancelled.clear();
    h = await DownloadHarness.create();
    downloads = DownloadsController(
      repository: h.repo,
      fence: h.fence,
      networkPolicy: const NetworkPolicy.online(),
      storageReady: () => true,
      schedule: (_, _, _) async => 'work',
      cancelJob: (_, _, _) async {},
    );
    final mixes = OfflineMixRepository(downloads: h.repo, fence: h.fence);
    final job = await h.repo.enqueue(
      DownloadHarness.track,
      'original',
      h.fence,
    );
    // Widget binding rejects HTTP; prepare a real verified private file locally.
    final claim = (await h.repo.claim(job.id, h.fence, job.generation))!;
    final bytes = wavBytes();
    final file = await h.paths.file(
      h.fence.owner,
      job.id,
      claim.generation,
      claim.writer!,
      ready: true,
    );
    await file.writeAsBytes(bytes);
    await h.repo.updateClaim(
      claim,
      state: DownloadState.ready,
      release: true,
      checkpoint: DownloadCheckpoint(
        generation: claim.generation,
        claim: claim.writer!,
        bytes: bytes.length,
        sha256: sha256.convert(bytes).toString(),
      ),
    );
    final source = MusicMix(
      id: 'saved',
      title: 'Моя сохранённая подборка',
      description: '',
      kind: MusicMixKind.daily,
      tracks: [job.track],
      loaded: true,
    );
    final staged = await mixes.stage(source);
    expect(
      await mixes.bind(staged.generation, [
        (await h.repo.status(job.id, h.fence))!,
      ]),
      isTrue,
    );
    expect(await mixes.commit(staged.generation), isTrue);
    final daily = OfflineMixDailyRefresh(
      mixes: mixes,
      policy: OfflineMixRefreshPolicy(store: h.store, fence: h.fence),
      conditions: () async =>
          const OfflineMixRefreshConditions(charging: false, unmetered: false),
      requireNetwork: () async {},
      loadSource: (_, _) async => throw StateError('UI never fetches'),
      scheduleFile: (_, _) async => throw StateError('UI never downloads'),
      schedulePeriodic: (revision) async {
        if (failSchedule) throw StateError('native unavailable');
        scheduled.add(revision);
      },
      retryPeriodic: (revision) async => scheduled.add(revision),
      cancelPeriodic: (revision) async => cancelled.add(revision),
      cancelFile: (_) async {},
    );
    controller = OfflineMixController(
      repository: mixes,
      downloads: downloads,
      dailyRefresh: daily,
    );
    network = await StoredNetworkPolicy.restore(
      store: h.store,
      authority: h.authority,
      fence: h.fence,
      onOffline: (_) async {},
    );
    await controller.loadDailySettings();
    await h.store.tail;
    initialized = true;
  });
  Future<void> close() async {
    await controller.close();
    controller.dispose();
    await downloads.close();
    downloads.dispose();
    await network.close();
    await h.close();
    closed = true;
  }

  tearDown(() async {
    if (!closed) {
      if (initialized) {
        await close();
      } else {
        await h.close();
      }
    }
  });

  test('native scheduling error retains truthful durable enabled state and can disable', () async {
    failSchedule = true;
    await controller.setDailyEnabled(true);
    expect(controller.dailyFailure, isNotNull);
    expect(controller.dailyState.enabled, isTrue);
    await controller.setDailyEnabled(false);
    expect(controller.dailyState.enabled, isFalse);
    expect(cancelled, hasLength(1));
    expect(h.requests, isEmpty);
  });

  testWidgets(
    'daily opt-in and Back fit320 large text without starting downloads',
    (tester) async {
      tester.view.physicalSize = const Size(320, 740);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(() async {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.runAsync(close);
      });
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: const TextScaler.linear(2)),
            child: child!,
          ),
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => OfflineSettingsScreen(
                      policy: network,
                      downloads: downloads,
                      offlineMix: controller,
                      onDownloads: () {},
                    ),
                  ),
                ),
                child: const Text('Settings'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Settings'));
      await tester.pumpAndSettle();
      await idle(tester, controller);
      final toggle = find.byKey(const ValueKey('offline-mix-daily-refresh'));
      for (var i = 0; i < 10 && toggle.evaluate().isEmpty; i++) {
        await tester.drag(find.byType(ListView), const Offset(0, -400));
        await tester.pump(const Duration(milliseconds: 50));
      }
      final control = find.descendant(
        of: toggle,
        matching: find.byType(Switch),
      );
      await tester.ensureVisible(control);
      await tester.pumpAndSettle();
      await tester.tap(control);
      await idle(tester, controller);
      expect(controller.dailyState.enabled, isTrue);
      expect(scheduled, hasLength(1));
      expect(h.requests, isEmpty);
      expect(tester.takeException(), isNull);
      await tester.pageBack();
      await tester.pumpAndSettle();
      expect(find.text('Settings'), findsOneWidget);
    },
  );
}

Future<void> idle(WidgetTester tester, OfflineMixController controller) async {
  for (var n = 0; n < 200 && controller.dailyBusy; n++) {
    await tester.pump(const Duration(milliseconds: 20));
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 5)),
    );
  }
  expect(controller.dailyBusy, isFalse);
  await tester.pumpAndSettle();
}
