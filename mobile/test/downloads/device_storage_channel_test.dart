import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/downloads/device_storage_guard.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test('native probe is read-only and takes no filesystem path', () async {
    const channel = MethodChannel('soundspan/storage');
    final calls = <MethodCall>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          calls.add(call);
          return 1024 * 1024 * 1024;
        });
    addTearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null),
    );
    await const DeviceStorageGuard().requireSpace(256 * 1024);
    expect(calls.single.method, 'freeBytes');
    expect(calls.single.arguments, isNull);
  });
}
