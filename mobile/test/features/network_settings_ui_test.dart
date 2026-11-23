import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/core/network/stored_network_policy.dart';
import 'package:soundspan/design_system/design_system.dart';
import 'package:soundspan/downloads/download_models.dart';
import 'package:soundspan/downloads/download_network_access.dart';
import 'package:soundspan/downloads/download_network_rules.dart';
import 'package:soundspan/features/downloads/download_actions_sheet.dart';
import 'package:soundspan/features/downloads/downloads_controller.dart';
import 'package:soundspan/features/settings/offline_settings_screen.dart';

import '../downloads/download_fixture.dart';
import '../support/collection_fixtures.dart';

void main() {
  late DownloadHarness h;
  late DownloadNetworkAccess access;
  var network = const DeviceNetworkState(
    connected: true,
    wifi: false,
    metered: true,
    roaming: false,
  );
  setUp(() async {
    h = await DownloadHarness.create();
    network = const DeviceNetworkState(
      connected: true,
      wifi: false,
      metered: true,
      roaming: false,
    );
    access = DownloadNetworkAccess(
      repository: h.repo,
      fence: h.fence,
      policy: const NetworkPolicy.online(),
      readNetwork: () async => network,
    );
  });
  tearDown(() async => h.close());
  DownloadsController controller({
    Future<bool> Function(int)? confirm,
    Future<void> Function()? changed,
    Future<String> Function(String, dynamic, int)? schedule,
  }) {
    final c = DownloadsController(
      repository: h.repo,
      fence: h.fence,
      networkPolicy: const NetworkPolicy.online(),
      storageReady: () => true,
      networkAccess: access,
      confirmNetworkUse: confirm,
      onNetworkRulesChanged: changed,
      schedule: schedule ?? (_, _, _) async => 'work',
      cancelJob: (_, _, _) async {},
    );
    addTearDown(c.dispose);
    return c;
  }

  Future<Object?> preference() => h.store.transaction(
    h.fence,
    (tx) => tx.read(DownloadNetworkRules.namespace, DownloadNetworkRules.key),
  );
  Future<List<Object?>> permits() => h.store.transaction(
    h.fence,
    (tx) async => await tx.list(DownloadNetworkAccess.consentNamespace),
  );

  test('durable settings load defaults and explicit save invokes root without touching READY', () async {
    var changed = 0;
    final job = await h.repo.enqueue(
      DownloadHarness.track,
      'original',
      h.fence,
    );
    final claim = (await h.repo.claim(job.id, h.fence, job.generation))!;
    await h.repo.updateClaim(claim, state: DownloadState.ready, release: true);
    final before = (await h.repo.status(job.id, h.fence))!.toJson();
    final c = controller(
      changed: () async {
        changed++;
      },
    );
    await c.loadNetworkRules();
    expect(c.networkRules?.mode, DownloadNetworkMode.unmetered);
    expect(c.networkRules?.allowRoaming, isFalse);
    await c.setNetworkRules(
      const DownloadNetworkRules(
        mode: DownloadNetworkMode.wifi,
        allowRoaming: true,
      ),
    );
    expect(c.networkRules?.mode, DownloadNetworkMode.wifi);
    expect(c.networkRules?.allowRoaming, isTrue);
    expect(changed, 1);
    expect(await preference(), {
      'version': 1,
      'mode': 'wifi',
      'allowRoaming': true,
    });
    expect((await h.repo.status(job.id, h.fence))!.toJson(), before);
  });

  test('unknown future preference is visible as an error and is not default-overwritten', () async {
    const future = {'version': 9, 'mode': 'any', 'allowRoaming': true};
    await h.store.transaction(
      h.fence,
      (tx) => tx.write(
        DownloadNetworkRules.namespace,
        DownloadNetworkRules.key,
        future,
      ),
    );
    final c = controller();
    await c.loadNetworkRules();
    expect(c.networkRules, isNull);
    expect(c.networkRulesFailure?.code, 'invalid_download_network_preference');
    expect(await preference(), future);
  });

  test('declining selected manual subset happens before enqueue and changes no preferences', () async {
    final counts = <int>[];
    final c = controller(
      confirm: (n) async {
        counts.add(n);
        return false;
      },
    );
    await c.downloadTracks([
      collectionTrack(1),
      collectionTrack(2),
      collectionTrack(2),
    ]);
    expect(counts, [2]);
    expect(await h.repo.list(h.fence), isEmpty);
    expect(await permits(), isEmpty);
    expect((await access.rules()).mode, DownloadNetworkMode.unmetered);
  });

  test('one consent covers only selected manual jobs and exact returned generations', () async {
    final automatic = await h.repo.enqueue(
      collectionTrack(99),
      'original',
      h.fence,
      manual: false,
    );
    final seen = <String>[];
    final c = controller(
      confirm: (n) async {
        expect(n, 2);
        return true;
      },
      schedule: (id, _, generation) async {
        final job = (await h.repo.status(id, h.fence))!;
        expect(job.generation, generation);
        expect(job.manual, isTrue);
        await access.requireNetwork(job: job);
        seen.add(id);
        return 'work';
      },
    );
    await c.downloadTracks([collectionTrack(1), collectionTrack(2)]);
    expect(seen, hasLength(2));
    expect(await permits(), hasLength(2));
    await expectLater(
      access.requireNetwork(job: automatic),
      throwsA(isA<AppFailure>()),
    );
    expect((await access.rules()).mode, DownloadNetworkMode.unmetered);
  });

  test('regular route never asks for consent or writes a permit', () async {
    network = const DeviceNetworkState(
      connected: true,
      wifi: false,
      metered: false,
      roaming: false,
    );
    final c = controller(
      confirm: (_) async => fail('A normal route must not prompt'),
    );
    await c.downloadTracks([DownloadHarness.track]);
    expect(await h.repo.list(h.fence), hasLength(1));
    expect(await permits(), isEmpty);
  });

  for (final route in [
    const DeviceNetworkState.unknown(),
    const DeviceNetworkState(connected: true, metered: true, roaming: true),
    const DeviceNetworkState(connected: true, metered: true),
  ]) {
    test(
      'blocked route connected=${route.connected} roaming=${route.roaming} queues waiting without consent bypass',
      () async {
        network = route;
        final c = controller(
          confirm: (_) async => fail('Unknown/offline/roaming must not prompt'),
        );
        await c.downloadTracks([DownloadHarness.track]);
        expect((await h.repo.list(h.fence)).single.state, DownloadState.queued);
        expect(await permits(), isEmpty);
        expect(c.notice, contains('ждёт сеть'));
      },
    );
  }

  for (final retry in [false, true]) {
    test(
      'manual ${retry ? 'retry' : 'resume'} prompts before restart and binds only new generation',
      () async {
        var job = await h.repo.enqueue(
          DownloadHarness.track,
          'original',
          h.fence,
          manual: false,
        );
        job = await h.repo.pause(
          job.id,
          h.fence,
          expectedGeneration: job.generation,
        );
        final old = job;
        final c = controller(
          confirm: (n) async {
            expect(n, 1);
            return true;
          },
        );
        await (retry ? c.retry(job) : c.resume(job));
        final current = (await h.repo.status(job.id, h.fence))!;
        expect(current.generation, old.generation + 1);
        expect(current.manual, isTrue);
        await access.requireNetwork(job: current);
        await expectLater(
          access.requireNetwork(job: old),
          throwsA(isA<AppFailure>()),
        );
      },
    );
  }

  test(
    'declined resume leaves paused generation and no permit unchanged',
    () async {
      final job = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
      );
      final paused = await h.repo.pause(
        job.id,
        h.fence,
        expectedGeneration: job.generation,
      );
      final c = controller(confirm: (_) async => false);
      await c.resume(paused);
      expect((await h.repo.status(job.id, h.fence))!.toJson(), paused.toJson());
      expect(await permits(), isEmpty);
    },
  );

  test(
    'a stale consent callback cannot authorize a replacement job generation',
    () async {
      final job = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
      );
      final paused = await h.repo.pause(
        job.id,
        h.fence,
        expectedGeneration: job.generation,
      );
      final entered = Completer<void>(), answer = Completer<bool>();
      var scheduled = 0;
      final c = controller(
        confirm: (_) {
          entered.complete();
          return answer.future;
        },
        schedule: (_, _, _) async {
          scheduled++;
          return 'work';
        },
      );
      final pending = c.resume(paused);
      await entered.future;
      final replacement = await h.repo.resume(
        job.id,
        h.fence,
        expectedGeneration: paused.generation,
      );
      answer.complete(true);
      await pending;
      expect(
        (await h.repo.status(job.id, h.fence))!.generation,
        replacement.generation,
      );
      expect(await permits(), isEmpty);
      expect(scheduled, 0);
    },
  );

  test('logout while consent waits cannot enqueue or save a permit', () async {
    final entered = Completer<void>(), answer = Completer<bool>();
    final c = controller(
      confirm: (_) {
        entered.complete();
        return answer.future;
      },
    );
    final pending = c.downloadTracks([DownloadHarness.track]);
    await entered.future;
    await h.authority.invalidate();
    answer.complete(true);
    await pending;
    expect(c.jobs, isEmpty);
    expect(
      h.store.rows.keys.any((k) => k.contains('downloadNetworkConsent.v1')),
      isFalse,
    );
    expect(h.store.rows.values.any((v) => v.containsKey('track')), isFalse);
  });

  testWidgets(
    'network settings fit320 text2, save independent mode/roaming and keep Back',
    (tester) async {
      final c = controller();
      final policy = (await tester.runAsync(
        () => StoredNetworkPolicy.restore(
          store: h.store,
          authority: h.authority,
          fence: h.fence,
          onOffline: (_) async {},
        ),
      ))!;
      addTearDown(policy.dispose);
      tester.view.physicalSize = const Size(320, 800);
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
            downloads: c,
            onDownloads: () {},
          ),
        ),
      );
      await tester.runAsync(c.loadNetworkRules);
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.text('Сеть загрузок').hitTestable(),
        250,
        scrollable: find.byType(Scrollable).first,
      );
      expect(find.text('Сеть загрузок'), findsOneWidget);
      await tester.scrollUntilVisible(
        find.text('Любая сеть').hitTestable(),
        250,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.text('Любая сеть').hitTestable());
      await tester.runAsync(
        () async => Future<void>.delayed(const Duration(milliseconds: 10)),
      );
      await tester.pumpAndSettle();
      expect(c.networkRules?.mode, DownloadNetworkMode.any);
      expect(c.networkRules?.allowRoaming, isFalse);
      await tester.scrollUntilVisible(
        find.text('Разрешить роуминг').hitTestable(),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.text('Разрешить роуминг').hitTestable());
      await tester.runAsync(
        () async => Future<void>.delayed(const Duration(milliseconds: 10)),
      );
      await tester.pumpAndSettle();
      expect(c.networkRules?.mode, DownloadNetworkMode.any);
      expect(c.networkRules?.allowRoaming, isTrue);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('manual consent dialog is bounded320 text2 and Back is refusal', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 700);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    bool? result;
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
              onPressed: () async {
                result = await DownloadActionsSheet.confirmNetworkUse(
                  context,
                  1001,
                );
              },
              child: const Text('Скачать'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Скачать'));
    await tester.pumpAndSettle();
    expect(find.text('Разрешить расход трафика?'), findsOneWidget);
    expect(find.textContaining('1001'), findsOneWidget);
    expect(tester.takeException(), isNull);
    for (final button
        in find
            .byType(TextButton)
            .evaluate()
            .where(
              (e) => e.findAncestorWidgetOfExactType<AlertDialog>() != null,
            )) {
      expect(
        tester.getSize(find.byWidget(button.widget)).height,
        greaterThanOrEqualTo(44),
      );
    }
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(result, isFalse);
  });
}
