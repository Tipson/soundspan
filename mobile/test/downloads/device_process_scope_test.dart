import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/downloads/device_process_scope.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const token = 'abcdefab-cdef-4abc-8abc-abcdefabcdef';
  const channel = MethodChannel('soundspan/storage');
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  tearDown(() => messenger.setMockMethodCallHandler(channel, null));

  test(
    'native process scope uses exact storage method without arguments',
    () async {
      var called = false;
      messenger.setMockMethodCallHandler(channel, (call) async {
        called = true;
        expect(call.method, 'processInstance');
        expect(call.arguments, isNull);
        return token;
      });
      final scope = await DeviceProcessScope.read();
      expect(called, isTrue);
      expect(scope.processInstance == token, isTrue);
      expect(scope.toString().contains(token), isFalse);
    },
  );

  test('missing platform and failures yield unknown identity', () async {
    expect((await DeviceProcessScope.read()).processInstance, isNull);
    expect(
      (await DeviceProcessScope.read(
        readInstance: () async => throw StateError('platform'),
      )).processInstance,
      isNull,
    );
  });

  test(
    'only exact canonical version4 native UUID establishes process identity',
    () {
      for (final value in [
        null,
        1,
        token.toUpperCase(),
        ' $token',
        '$token ',
        token.replaceFirst('-4abc-', '-3abc-'),
        {'processInstance': token},
      ]) {
        expect(DeviceProcessScope.fromNative(value).processInstance, isNull);
      }
      expect(
        DeviceProcessScope.fromNative(token).processInstance != null,
        isTrue,
      );
    },
  );
}
