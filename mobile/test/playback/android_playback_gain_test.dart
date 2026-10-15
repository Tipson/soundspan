import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/playback/android_playback_gain.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('soundspan/playback_gain');
  test(
    'late old bind cannot replace active native lease acknowledgement',
    () async {
      final old = Completer<Map<String, Object?>>();
      Map? oldArgs;
      Map<String, Object?> response(Map args) => {
        'lease': args['lease'],
        'sessionId': args['sessionId'],
        'available': true,
        'targetGainMb': 0.0,
        'enabled': false,
        'failure': null,
      };
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
            final args = call.arguments as Map;
            if (args['sessionId'] == 42) {
              oldArgs = args;
              return old.future;
            }
            return response(args);
          });
      final bridge = AndroidPlaybackGain();
      final stale = bridge.bind(42);
      await Future<void>.delayed(Duration.zero);
      expect(await bridge.bind(43), isTrue);
      old.complete(response(oldArgs!));
      expect(await stale, isFalse);
      expect(bridge.diagnostics!.sessionId, 43);
      await bridge.release();
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null);
    },
  );
  test(
    'native acknowledged millibels and session must match current lease',
    () async {
      final calls = <MethodCall>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
            calls.add(call);
            final args = call.arguments as Map;
            return {
              'lease': args['lease'],
              'sessionId': call.method == 'release' ? null : 42,
              'available': call.method != 'release',
              'targetGainMb': call.method == 'gain'
                  ? (args['db'] as num) * 100
                  : 0.0,
              'enabled': call.method == 'gain' && (args['db'] as num) > 0,
              'failure': null,
            };
          });
      final bridge = AndroidPlaybackGain();
      expect(await bridge.bind(42), isTrue);
      await bridge.setBoostDb(3);
      expect(bridge.diagnostics?.targetGainMb, 300);
      expect(bridge.diagnostics?.sessionId, 42);
      expect(
        (calls.first.arguments as Map).containsKey('forceUnsupported'),
        isFalse,
      );
      await bridge.release();
      await bridge.setBoostDb(0);
      await expectLater(bridge.setBoostDb(3), throwsA(isA<UnsupportedError>()));
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null);
    },
  );
}
