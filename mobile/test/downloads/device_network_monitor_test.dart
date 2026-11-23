import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/downloads/device_network_monitor.dart';

Map<String, Object?> route({bool connected = true, bool metered = false}) => {
  'v': 1,
  'connected': connected,
  'wifi': true,
  'metered': metered,
  'roaming': false,
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('soundspan/test_download_network');
  late StreamController<Object?> events;
  late DeviceNetworkMonitor monitor;
  late Future<Object?> Function(MethodCall) handler;
  setUp(() {
    events = StreamController<Object?>.broadcast(sync: true);
    handler = (call) async {
      expect(call.method, 'snapshot');
      expect(call.arguments, isNull);
      return route();
    };
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) => handler(call));
    monitor = DeviceNetworkMonitor(
      channel: channel,
      events: events.stream,
      timeout: const Duration(milliseconds: 100),
    );
  });
  tearDown(() async {
    await monitor.close();
    await events.close();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  test(
    'snapshot and route events retain actual metering independently of Wi-Fi',
    () async {
      await monitor.start();
      expect(monitor.value.connected, isTrue);
      expect(monitor.value.metered, isFalse);
      events.add(route(metered: true));
      expect(monitor.value.wifi, isTrue);
      expect(monitor.value.metered, isTrue);
      expect(monitor.failure, isNull);
    },
  );

  test(
    'older pending snapshot cannot reopen a route closed by a newer event',
    () async {
      await monitor.start();
      final pending = Completer<Object?>();
      handler = (_) => pending.future;
      final refresh = monitor.refresh();
      await Future<void>.delayed(Duration.zero);
      events.add(route(connected: false));
      pending.complete(route());
      expect((await refresh).connected, isFalse);
      expect(monitor.value.connected, isFalse);
    },
  );

  test(
    'unknown versions, malformed capabilities and stream loss close admission',
    () async {
      await monitor.start();
      for (final value in [
        {...route(), 'v': 2},
        {...route(), 'v': 1.0},
        {...route(), 'metered': 'false'},
        {...route(), 'ssid': 'not-part-of-this-protocol'},
        <String, Object?>{},
      ]) {
        events.add(value);
        expect(monitor.value.connected, isFalse);
        expect(monitor.failure, isNotNull);
      }
      events.add(route());
      expect(monitor.value.connected, isTrue);
      events.addError(StateError('fixture channel loss'));
      expect(monitor.value.connected, isFalse);
    },
  );

  test(
    'snapshot deadline is bounded and cannot leave the previous allow state',
    () async {
      await monitor.start();
      handler = (_) => Completer<Object?>().future;
      expect((await monitor.refresh()).connected, isFalse);
      expect(monitor.failure?.code, 'network_state_unavailable');
    },
  );

  test(
    'closing rejects a late reply without recreating a native subscription',
    () async {
      await monitor.start();
      final pending = Completer<Object?>();
      handler = (_) => pending.future;
      final refresh = monitor.refresh();
      await Future<void>.delayed(Duration.zero);
      await monitor.close();
      pending.complete(route());
      expect((await refresh).connected, isFalse);
      expect(monitor.value.connected, isFalse);
      expect(events.hasListener, isFalse);
    },
  );
}
