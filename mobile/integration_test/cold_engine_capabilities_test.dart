import 'package:flutter/services.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'an auto-registered engine has background capabilities before Activity attachment',
    (tester) async {
      await tester.runAsync(() async {
        const harness = MethodChannel('soundspan/session_probe_harness');
        final capabilities = await harness.invokeMapMethod<String, Object?>(
          'coldCapabilities',
        );
        // Only booleans from an engine with no Activity or running Dart.
        debugPrint('COLD_ENGINE_CAPABILITIES $capabilities');
        expect(capabilities, {
          'activityAttached': false,
          'sessionBroker': true,
          'downloads': true,
          'mediaProbe': true,
          'gain': true,
        });
      });
    },
  );
  testWidgets(
    'a private download engine keeps its restricted plugin allowlist',
    (tester) async {
      await tester.runAsync(() async {
        const harness = MethodChannel('soundspan/session_probe_harness');
        final capabilities = await harness.invokeMapMethod<String, Object?>(
          'privateCapabilities',
        );
        debugPrint('PRIVATE_ENGINE_CAPABILITIES $capabilities');
        expect(capabilities, {
          'sessionBroker': true,
          'mediaProbe': true,
          'downloads': false,
          'gain': false,
          'audio': false,
          'secureStorage': false,
        });
      });
    },
  );
}
