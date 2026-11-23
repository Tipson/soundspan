import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/downloads/device_network_monitor.dart';
import 'package:soundspan/downloads/offline_mix_refresh_conditions.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('soundspan/download_network');
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  late DeviceNetworkMonitor monitor;
  Object? route;
  setUp(() {
    route = {
      'v': 1,
      'connected': true,
      'wifi': true,
      'metered': false,
      'roaming': false,
    };
    messenger.setMockMethodCallHandler(channel, (_) async => route);
    monitor = DeviceNetworkMonitor(
      channel: channel,
      events: const Stream.empty(),
    );
  });
  tearDown(() async {
    await monitor.close();
    messenger.setMockMethodCallHandler(channel, null);
  });
  test(
    'only current unmetered connected route and explicit native charging admit',
    () async {
      final allowed = await readOfflineMixRefreshConditions(
        monitor,
        charging: () async => true,
      );
      expect(allowed.charging && allowed.unmetered, isTrue);
      route = {
        'v': 1,
        'connected': true,
        'wifi': true,
        'metered': true,
        'roaming': false,
      };
      expect(
        (await readOfflineMixRefreshConditions(
          monitor,
          charging: () async => true,
        )).unmetered,
        isFalse,
      );
      route = null;
      expect(
        (await readOfflineMixRefreshConditions(
          monitor,
          charging: () async => true,
        )).unmetered,
        isFalse,
      );
    },
  );
  test('unknown malformed and failed charging probes never admit', () async {
    for (final value in [null, 1, 'true', false]) {
      expect(
        (await readOfflineMixRefreshConditions(
          monitor,
          charging: () async => value,
        )).charging,
        isFalse,
      );
    }
    expect(
      (await readOfflineMixRefreshConditions(
        monitor,
        charging: () async => throw StateError('platform'),
      )).charging,
      isFalse,
    );
  });
}
