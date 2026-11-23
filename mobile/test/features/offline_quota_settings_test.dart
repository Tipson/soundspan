import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/core/network/stored_network_policy.dart';
import 'package:soundspan/design_system/design_system.dart';
import 'package:soundspan/downloads/offline_mix_quota.dart';
import 'package:soundspan/features/downloads/downloads_controller.dart';
import 'package:soundspan/features/settings/offline_settings_screen.dart';

import '../downloads/download_fixture.dart';

void main() {
  late DownloadHarness h;
  late OfflineMixQuota quota;
  late DownloadsController downloads;
  late StoredNetworkPolicy policy;
  var cleaned = false;
  setUp(() async {
    cleaned = false;
    h = await DownloadHarness.create();
    quota = OfflineMixQuota(repository: h.repo, fence: h.fence);
    downloads = DownloadsController(
      repository: h.repo,
      fence: h.fence,
      networkPolicy: const NetworkPolicy.online(),
      storageReady: () => true,
      schedule: (_, _, _) async => 'work',
      cancelJob: (_, _, _) async {},
      offlineQuota: quota,
    );
    policy = await StoredNetworkPolicy.restore(
      store: h.store,
      authority: h.authority,
      fence: h.fence,
      onOffline: (_) async {},
    );
    // Complete the fixture's real-zone transaction tail before testWidgets
    // enters its fake clock; otherwise a new UI transaction waits outside it.
    await h.store.tail;
  });
  tearDown(() async {
    if (cleaned) return;
    await downloads.close();
    downloads.dispose();
    await policy.close();
    await h.close();
  });
  test(
    'quota setting persists, reloads and does not enqueue downloads',
    () async {
      await downloads.loadQuota();
      expect(downloads.quotaUsage?.limitBytes, OfflineMixQuota.defaultLimit);
      await downloads.setQuotaLimit(512 * 1024 * 1024);
      expect(downloads.quotaUsage?.limitBytes, 512 * 1024 * 1024);
      expect(
        (await OfflineMixQuota(
          repository: h.repo,
          fence: h.fence,
        ).usage()).limitBytes,
        512 * 1024 * 1024,
      );
      expect(await h.repo.list(h.fence), isEmpty);
    },
  );
  test(
    'unknown policy remains intact and is shown as a recoverable failure',
    () async {
      final row = {'version': 7, 'maxBytes': 42};
      await h.store.transaction(
        h.fence,
        (tx) => tx.write(OfflineMixQuota.policyNamespace, 'control', row),
      );
      await downloads.loadQuota();
      expect(downloads.quotaUsage, isNull);
      expect(downloads.quotaFailure, isNotNull);
      await downloads.setQuotaLimit(512 * 1024 * 1024);
      expect(
        await h.store.transaction(
          h.fence,
          (tx) => tx.read(OfflineMixQuota.policyNamespace, 'control'),
        ),
        row,
      );
    },
  );
  testWidgets(
    'narrow large-text quota selector updates actual policy without overflow',
    (tester) async {
      addTearDown(() async {
        await tester.pumpWidget(const SizedBox.shrink());
        await _drain(tester, downloads.close());
        downloads.dispose();
        await tester.runAsync(policy.close);
        await tester.runAsync(h.close);
        cleaned = true;
      });
      tester.view.physicalSize = const Size(320, 740);
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
          home: OfflineSettingsScreen(
            policy: policy,
            downloads: downloads,
            onDownloads: () {},
          ),
        ),
      );
      await _quotaIdle(tester, downloads);
      final selector = find.byKey(const ValueKey('offline-mix-quota-limit'));
      for (var i = 0; i < 12 && selector.evaluate().isEmpty; i++) {
        await tester.drag(find.byType(ListView), const Offset(0, -400));
        await tester.pump(const Duration(milliseconds: 300));
      }
      expect(selector, findsOneWidget);
      await tester.ensureVisible(selector);
      await tester.tap(selector);
      await tester.pumpAndSettle();
      await tester.tap(find.text('512 МБ').last);
      await _quotaIdle(tester, downloads);
      expect(
        (await tester.runAsync(quota.usage))!.limitBytes,
        512 * 1024 * 1024,
      );
      expect(tester.takeException(), isNull);
    },
  );
}

Future<void> _quotaIdle(
  WidgetTester tester,
  DownloadsController controller,
) async {
  for (var i = 0; i < 200 && controller.quotaLoading; i++) {
    await tester.pump(const Duration(milliseconds: 20));
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 10)),
    );
  }
  expect(
    controller.quotaLoading,
    isFalse,
    reason: 'Quota IO must finish before waiting for animations',
  );
  await tester.pumpAndSettle();
}

Future<void> _drain(WidgetTester tester, Future<void> pending) async {
  var done = false;
  Object? failure;
  pending.then(
    (_) => done = true,
    onError: (Object error) {
      failure = error;
      done = true;
    },
  );
  for (var i = 0; i < 200 && !done; i++) {
    await tester.pump(const Duration(milliseconds: 20));
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 10)),
    );
  }
  expect(done, isTrue, reason: 'Owned fixture must drain');
  if (failure != null) throw failure!;
}
