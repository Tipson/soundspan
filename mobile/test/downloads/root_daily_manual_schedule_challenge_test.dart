import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/dart_api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/downloads/device_network_monitor.dart';
import 'package:soundspan/downloads/download_models.dart';
import 'package:soundspan/downloads/download_network_access.dart';
import 'package:soundspan/downloads/download_worker_bridge.dart';
import 'package:soundspan/downloads/offline_mix_daily_factory.dart';
import 'package:soundspan/downloads/offline_mix_refresh_policy.dart';
import 'package:soundspan/downloads/offline_mix_repository.dart';

import 'download_fixture.dart';

class _NoJson implements JsonHttpClient {
  @override
  Future<ApiResponse> send(ApiRequest request, {String? accessToken}) =>
      throw StateError('Scheduling cannot perform source HTTP');
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  for (final promoteDuringDispatch in [false, true]) {
    test(
      'manual promotion survives a captured daily schedule (during dispatch: $promoteDuringDispatch)',
      () async {
        final h = await DownloadHarness.create();
        addTearDown(h.close);
        const channel = MethodChannel('soundspan/downloads');
        final messenger =
            TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
        final requests = <Map<String, Object?>>[];
        var dispatchCount = 0;
        Future<void> Function()? promote;
        messenger.setMockMethodCallHandler(channel, (call) async {
          expect(call.method, 'schedule');
          final request = Map<String, Object?>.from(call.arguments as Map);
          dispatchCount++;
          if (promoteDuringDispatch && dispatchCount == 1) {
            await promote!();
          }
          // Record the native application order, not MethodChannel entry order.
          requests.add(request);
          return 'native-work';
        });
        addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
        final policy = OfflineMixRefreshPolicy(store: h.store, fence: h.fence);
        final state = await policy.configure(
          enabled: true,
          sourceIdentity: 'daily:test',
          quality: 'original',
        );
        final ticket = (await policy.claim(
          charging: true,
          unmetered: true,
          expectedRevision: state.revision,
        ))!;
        final captured = await h.repo.enqueue(
          DownloadHarness.track,
          'original',
          h.fence,
          manual: false,
          origin: DownloadOrigin.offlineMixDaily,
          refreshTicket: ticket,
        );
        final access = DownloadNetworkAccess(
          repository: h.repo,
          fence: h.fence,
          policy: const NetworkPolicy.online(),
          readNetwork: () async => throw StateError('No network read needed'),
        );
        var promoted = false;
        promote = () async {
          if (promoted) return;
          promoted = true;
          final manual = await h.repo.enqueue(
            captured.track,
            captured.quality,
            h.fence,
          );
          expect(manual.manual, isTrue);
          await const DownloadWorkerBridge().schedule(
            manual.id,
            manual.originalFence,
            manual.generation,
          );
        };
        final daily = createOfflineMixDailyRefresh(
          downloads: h.repo,
          mixes: OfflineMixRepository(downloads: h.repo, fence: h.fence),
          transport: DartApiTransport(
            client: _NoJson(),
            authority: h.authority,
          ),
          authority: h.authority,
          networkPolicy: const NetworkPolicy.online(),
          monitor: DeviceNetworkMonitor(),
          access: access,
          guard: () async {
            if (!promoteDuringDispatch) await promote!();
          },
        );
        await daily.scheduleFile(captured, ticket.revision);
        final current = (await h.repo.status(captured.id, h.fence))!;
        expect(current.manual, isTrue);
        expect(requests.length, greaterThanOrEqualTo(2));
        final matching = requests
            .where((request) => request['generation'] == current.generation)
            .toList();
        expect(
          matching.last.containsKey('refreshRevision'),
          isFalse,
          reason: 'The actual native producer must respect the newer ordinary download intent, even when its batch captured daily metadata',
        );
      },
    );
  }
}
