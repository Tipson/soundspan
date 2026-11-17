import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/downloads/download_network_access.dart';
import 'package:soundspan/downloads/download_network_rules.dart';
import 'package:soundspan/downloads/stored_download_network_rules.dart';

import 'download_fixture.dart';

void main() {
  late DownloadHarness h;
  late DownloadNetworkAccess access;
  var network = const DeviceNetworkState(
    connected: true,
    wifi: true,
    metered: false,
    roaming: false,
  );
  setUp(() async {
    h = await DownloadHarness.create();
    network = const DeviceNetworkState(
      connected: true,
      wifi: true,
      metered: false,
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
  Matcher denied(String code) =>
      throwsA(isA<AppFailure>().having((e) => e.code, 'code', code));

  test(
    'durable defaults distinguish metered Wi-Fi from unmetered cellular',
    () async {
      await access.requireNetwork();
      network = const DeviceNetworkState(
        connected: true,
        wifi: true,
        metered: true,
        roaming: false,
      );
      await expectLater(
        access.requireNetwork(),
        denied('download_network_restricted'),
      );
      network = const DeviceNetworkState(
        connected: true,
        wifi: false,
        metered: false,
        roaming: false,
      );
      await access.requireNetwork();
      await saveDownloadNetworkRules(
        h.store,
        h.fence,
        const DownloadNetworkRules(mode: DownloadNetworkMode.wifi),
      );
      await expectLater(
        access.requireNetwork(),
        denied('download_network_restricted'),
      );
    },
  );

  test(
    'one-job consent survives a new reader but never grants automation',
    () async {
      final manual = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
      );
      final automatic = await h.repo.enqueue(
        DownloadHarness.track,
        'high',
        h.fence,
        manual: false,
      );
      network = const DeviceNetworkState(
        connected: true,
        wifi: false,
        metered: true,
        roaming: false,
      );
      await expectLater(
        access.requireNetwork(job: manual),
        denied('download_network_restricted'),
      );
      await access.allowOnce(manual);
      final restored = DownloadNetworkAccess(
        repository: h.repo,
        fence: h.fence,
        policy: const NetworkPolicy.online(),
        readNetwork: () async => network,
      );
      await restored.requireNetwork(job: manual);
      expect(
        await restored.constraintFor(manual),
        DownloadNetworkConstraint.notRoaming,
      );
      expect(
        await restored.constraintFor(automatic),
        DownloadNetworkConstraint.unmetered,
      );
      await expectLater(
        restored.requireNetwork(job: automatic),
        denied('download_network_restricted'),
      );
      await expectLater(
        restored.requireNetwork(),
        denied('download_network_restricted'),
      );
      await expectLater(
        restored.allowOnce(automatic),
        denied('download_consent_stale'),
      );
    },
  );

  test(
    'consent cannot defeat offline, unknown route or roaming restriction',
    () async {
      final job = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
      );
      network = const DeviceNetworkState(
        connected: true,
        metered: true,
        roaming: false,
      );
      await access.allowOnce(job);
      network = const DeviceNetworkState(
        connected: true,
        metered: true,
        roaming: true,
      );
      await expectLater(
        access.requireNetwork(job: job),
        denied('download_network_restricted'),
      );
      network = const DeviceNetworkState.unknown();
      await expectLater(
        access.requireNetwork(job: job),
        denied('download_network_restricted'),
      );
      network = const DeviceNetworkState(
        connected: true,
        metered: true,
        roaming: false,
      );
      await h.store.transaction(
        h.fence,
        (tx) =>
            tx.write('settings', 'network', {'version': 1, 'offline': true}),
      );
      await expectLater(
        access.requireNetwork(job: job),
        denied('offline_mode'),
      );
    },
  );

  test('consent cannot cross generations and a late old revoke preserves the new permit', () async {
    final original = await h.repo.enqueue(
      DownloadHarness.track,
      'original',
      h.fence,
    );
    network = const DeviceNetworkState(
      connected: true,
      metered: true,
      roaming: false,
    );
    await access.allowOnce(original);
    final paused = await h.repo.pause(
      original.id,
      h.fence,
      expectedGeneration: original.generation,
    );
    final resumed = await h.repo.resume(
      paused.id,
      h.fence,
      expectedGeneration: paused.generation,
    );
    await expectLater(
      access.requireNetwork(job: original),
      denied('download_network_restricted'),
    );
    await expectLater(
      access.requireNetwork(job: resumed),
      denied('download_network_restricted'),
    );
    await expectLater(
      access.allowOnce(original),
      denied('download_consent_stale'),
    );
    await access.allowOnce(resumed);
    await access.revokeOnce(original);
    await access.requireNetwork(job: resumed);
  });

  test('unknown consent shape/version never widens permissions', () async {
    final job = await h.repo.enqueue(
      DownloadHarness.track,
      'original',
      h.fence,
    );
    network = const DeviceNetworkState(
      connected: true,
      metered: true,
      roaming: false,
    );
    await access.allowOnce(job);
    await h.store.transaction(h.fence, (tx) async {
      final row = await tx.read(DownloadNetworkAccess.consentNamespace, job.id);
      await tx.write(DownloadNetworkAccess.consentNamespace, job.id, {
        ...row!,
        'version': 2,
      });
    });
    await expectLater(
      access.requireNetwork(job: job),
      denied('download_network_restricted'),
    );
  });

  test('revoked owner cannot grant one-off access', () async {
    final job = await h.repo.enqueue(
      DownloadHarness.track,
      'original',
      h.fence,
    );
    await h.authority.invalidate();
    await expectLater(access.allowOnce(job), throwsA(isA<AppFailure>()));
  });

  test(
    'a rules change while the route read waits rejects the old allow',
    () async {
      await saveDownloadNetworkRules(
        h.store,
        h.fence,
        const DownloadNetworkRules(mode: DownloadNetworkMode.any),
      );
      final started = Completer<void>(),
          response = Completer<DeviceNetworkState>();
      final delayed = DownloadNetworkAccess(
        repository: h.repo,
        fence: h.fence,
        policy: const NetworkPolicy.online(),
        readNetwork: () {
          started.complete();
          return response.future;
        },
      );
      final pending = delayed.requireNetwork();
      await started.future;
      await saveDownloadNetworkRules(
        h.store,
        h.fence,
        const DownloadNetworkRules(),
      );
      final rejected = expectLater(
        pending,
        denied('download_network_restricted'),
      );
      response.complete(
        const DeviceNetworkState(
          connected: true,
          wifi: false,
          metered: true,
          roaming: false,
        ),
      );
      await rejected;
    },
  );
}
