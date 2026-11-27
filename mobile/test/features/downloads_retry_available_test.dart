import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/design_system/design_system.dart';
import 'package:soundspan/downloads/download_models.dart';
import 'package:soundspan/downloads/download_network_access.dart';
import 'package:soundspan/downloads/download_network_rules.dart';
import 'package:soundspan/features/downloads/downloads_controller.dart';
import 'package:soundspan/features/downloads/downloads_screen.dart';

import '../downloads/download_fixture.dart';
import '../support/collection_fixtures.dart';

void main() {
  late DownloadHarness h;
  const wifi = DeviceNetworkState(
    connected: true,
    wifi: true,
    metered: false,
    roaming: false,
  );
  final scheduled = <String>[];
  var prompts = 0;

  setUp(() async {
    h = await DownloadHarness.create();
    scheduled.clear();
    prompts = 0;
  });
  tearDown(() => h.close());

  DownloadsController controller({
    Future<DeviceNetworkState> Function()? readNetwork,
    Future<String> Function(String, SessionFence, int)? schedule,
  }) {
    final value = DownloadsController(
      repository: h.repo,
      fence: h.fence,
      networkPolicy: const NetworkPolicy.online(),
      storageReady: () => true,
      schedule:
          schedule ??
          (id, _, _) async {
            scheduled.add(id);
            return 'work';
          },
      cancelJob: (_, _, _) async {},
      confirmNetworkUse: (_) async {
        prompts++;
        return true;
      },
      networkAccess: DownloadNetworkAccess(
        repository: h.repo,
        fence: h.fence,
        policy: const NetworkPolicy.online(),
        readNetwork: readNetwork ?? () async => wifi,
      ),
    );
    addTearDown(value.dispose);
    return value;
  }

  Future<DeviceDownload> failed(
    int index,
    String code, {
    int? retryNotBefore,
  }) async {
    final job = await h.repo.enqueue(
      collectionTrack(index),
      'original',
      h.fence,
    );
    final claim = (await h.repo.claim(job.id, h.fence, job.generation))!;
    await h.repo.updateClaim(
      claim,
      state: DownloadState.failed,
      errorCode: code,
      retryNotBefore: retryNotBefore,
      release: true,
    );
    return (await h.repo.status(job.id, h.fence))!;
  }

  testWidgets(
    'errors show stored reasons and schedule only an eligible retry',
    (tester) async {
      tester.view.physicalSize = const Size(700, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final c = controller();
      late DeviceDownload eligible, held, storage, source;
      await tester.runAsync(() async {
        eligible = await failed(1, 'download_network_restricted');
        held = await failed(
          2,
          'http_error',
          retryNotBefore: h.repo.now + 10000,
        );
        storage = await failed(3, 'download_storage_full');
        source = await failed(4, 'recording_unavailable');
        await c.refresh();
      });
      c.setFilter(DownloadsFilter.failed);
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: DownloadsScreen(
            controller: c,
            autoLoad: false,
            onPlay: (_) async {},
          ),
        ),
      );
      expect(find.textContaining('ждёт сеть, разрешённую'), findsOneWidget);
      expect(find.textContaining('Сервер попросил подождать'), findsOneWidget);
      expect(
        find.textContaining('Недостаточно свободного места'),
        findsOneWidget,
      );
      expect(find.textContaining('Аудиозапись недоступна'), findsOneWidget);
      final retry = find.text('Повторить доступные');
      expect(retry.hitTestable(), findsOneWidget);
      await tester.runAsync(() async {
        final refreshed = Completer<void>();
        void listen() {
          if (!c.hasRetryableFailures && !refreshed.isCompleted) {
            refreshed.complete();
          }
        }

        c.addListener(listen);
        try {
          await tester.tap(retry);
          await refreshed.future.timeout(const Duration(seconds: 2));
        } finally {
          c.removeListener(listen);
        }
      });
      await tester.pumpAndSettle();
      expect(scheduled, [eligible.id]);
      expect(prompts, 0);
      for (final job in [held, storage, source]) {
        final current = await tester.runAsync(
          () => h.repo.status(job.id, h.fence),
        );
        expect(current!.toJson(), job.toJson());
      }
      expect(find.text('Повторить доступные'), findsNothing);
    },
  );

  test(
    'bulk retry respects the current network without one-off consent',
    () async {
      final job = await failed(1, 'media_idle_timeout');
      final c = controller(
        readNetwork: () async => const DeviceNetworkState(
          connected: true,
          wifi: false,
          metered: true,
          roaming: false,
        ),
      );
      await c.refresh();
      await c.retryAvailable();
      expect(c.failure?.code, DownloadNetworkAccess.restricted.code);
      expect(scheduled, isEmpty);
      expect(prompts, 0);
      expect((await h.repo.status(job.id, h.fence))!.toJson(), job.toJson());
    },
  );

  test(
    'bulk retry leaves the worker’s new same-generation claim intact',
    () async {
      final job = await failed(1, 'media_idle_timeout');
      DeviceDownload? worker;
      final c = controller(
        readNetwork: () async {
          worker ??= await h.repo.claim(job.id, h.fence, job.generation);
          return wifi;
        },
      );
      await c.refresh();
      await c.retryAvailable();
      final current = (await h.repo.status(job.id, h.fence))!;
      expect(worker?.writer, isNotNull);
      expect(current.state, DownloadState.downloading);
      expect(current.generation, job.generation);
      expect(current.writer, worker!.writer);
      expect(scheduled, isEmpty);
    },
  );

  test(
    'a persisted server deadline allows retry only after it expires',
    () async {
      final job = await failed(
        1,
        'media_network_error',
        retryNotBefore: h.repo.now + 10000,
      );
      final c = controller();
      await c.refresh();
      await c.retryAvailable();
      expect(scheduled, isEmpty);
      h.currentTime = h.currentTime.add(const Duration(seconds: 10));
      await c.retryAvailable();
      expect(scheduled, [job.id]);
    },
  );

  test('an old server deadline cannot classify a generic HTTP error', () async {
    final job = await failed(1, 'http_error', retryNotBefore: h.repo.now - 1);
    final c = controller();
    await c.refresh();
    await c.retryAvailable();
    expect(scheduled, isEmpty);
    expect((await h.repo.status(job.id, h.fence))!.toJson(), job.toJson());
  });

  test(
    'sign-out during the network check prevents scheduling the batch',
    () async {
      await failed(1, 'media_idle_timeout');
      final c = controller(
        readNetwork: () async {
          await h.authority.invalidate();
          return wifi;
        },
      );
      await c.refresh();
      await c.retryAvailable();
      expect(c.isCurrent, isFalse);
      expect(scheduled, isEmpty);
      expect(prompts, 0);
    },
  );

  test(
    'bulk retry skips offline mix jobs, including those with other origins',
    () async {
      final independent = await failed(1, 'media_idle_timeout');
      final mixed = <DeviceDownload>[];
      for (final origin in [
        DownloadOrigin.offlineMix,
        DownloadOrigin.offlineMixDaily,
      ]) {
        final job = await failed(mixed.length + 2, 'media_idle_timeout');
        mixed.add(
          await h.repo.enqueue(job.track, job.quality, h.fence, origin: origin),
        );
      }
      final c = controller();
      await c.refresh();
      c.setFilter(DownloadsFilter.failed);
      await c.retryAvailable();
      expect(scheduled, [independent.id]);
      for (final job in mixed) {
        expect((await h.repo.status(job.id, h.fence))!.toJson(), job.toJson());
      }
    },
  );

  test(
    'an offline mix added to the same failed generation blocks bulk retry',
    () async {
      final job = await failed(1, 'media_idle_timeout');
      final c = controller(
        readNetwork: () async {
          await h.repo.enqueue(
            job.track,
            job.quality,
            h.fence,
            origin: DownloadOrigin.offlineMix,
          );
          return wifi;
        },
      );
      await c.refresh();
      await c.retryAvailable();
      expect(scheduled, isEmpty);
      final retained = (await h.repo.status(job.id, h.fence))!;
      expect(retained.state, DownloadState.failed);
      expect(retained.generation, job.generation);
      expect(retained.origins, contains(DownloadOrigin.offlineMix.name));
    },
  );

  test(
    'schedule failure allows another try and does not stop unrelated jobs',
    () async {
      final jobs = [
        await failed(1, 'media_idle_timeout'),
        await failed(2, 'media_idle_timeout'),
      ];
      final c = controller(
        schedule: (id, _, _) async {
          scheduled.add(id);
          if (scheduled.length == 1) {
            throw StateError('schedule ACK unavailable');
          }
          return 'work';
        },
      );
      await c.refresh();
      await c.retryAvailable();
      expect(scheduled, unorderedEquals(jobs.map((job) => job.id)));
      final rejected = (await h.repo.status(scheduled.first, h.fence))!;
      final accepted = (await h.repo.status(scheduled.last, h.fence))!;
      expect(rejected.state, DownloadState.failed);
      expect(rejected.errorCode, 'download_schedule_unconfirmed');
      expect(rejected.generation, 2);
      expect(accepted.state, DownloadState.queued);
      expect(c.hasRetryableFailures, isTrue);
      await c.retryAvailable();
      expect(scheduled, hasLength(3));
      expect(scheduled.last, rejected.id);
      expect(
        (await h.repo.status(rejected.id, h.fence))!.state,
        DownloadState.queued,
      );
    },
  );

  test('lost schedule ACK cannot replace a running worker', () async {
    final job = await failed(1, 'media_idle_timeout');
    DeviceDownload? running;
    final c = controller(
      schedule: (id, fence, generation) async {
        running = await h.repo.claim(id, fence, generation);
        throw StateError('schedule ACK unavailable');
      },
    );
    await c.refresh();
    await c.retryAvailable();
    final current = (await h.repo.status(job.id, h.fence))!;
    expect(running?.writer, isNotNull);
    expect(current.toJson(), running!.toJson());
    expect(c.hasRetryableFailures, isFalse);
  });

  test('a policy rejection during scheduling recovers that row and stops the batch', () async {
    final jobs = [
      await failed(1, 'media_idle_timeout'),
      await failed(2, 'media_idle_timeout'),
    ];
    final c = controller(
      schedule: (id, _, _) async {
        scheduled.add(id);
        throw DownloadNetworkAccess.restricted;
      },
    );
    await c.refresh();
    await c.retryAvailable();
    expect(scheduled, hasLength(1));
    expect(c.failure?.code, DownloadNetworkAccess.restricted.code);
    final recovered = (await h.repo.status(scheduled.single, h.fence))!;
    expect(recovered.state, DownloadState.failed);
    expect(recovered.errorCode, 'download_schedule_unconfirmed');
    final unstarted = jobs.singleWhere((job) => job.id != recovered.id);
    expect(
      (await h.repo.status(unstarted.id, h.fence))!.toJson(),
      unstarted.toJson(),
    );
  });
}
