import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/downloads/download_network_rules.dart';

void main() {
  const wifi = DeviceNetworkState(
    connected: true,
    wifi: true,
    metered: false,
    roaming: false,
  );
  const hotspot = DeviceNetworkState(
    connected: true,
    wifi: true,
    metered: true,
    roaming: false,
  );
  const cellular = DeviceNetworkState(
    connected: true,
    wifi: false,
    metered: true,
    roaming: false,
  );
  const ethernet = DeviceNetworkState(
    connected: true,
    wifi: false,
    metered: false,
    roaming: false,
  );
  const roaming = DeviceNetworkState(
    connected: true,
    wifi: false,
    metered: true,
    roaming: true,
  );

  test('default uses actual metering, independently of Wi-Fi transport', () {
    final rules = DownloadNetworkRules.decode(null);
    expect(rules.allows(wifi), isTrue);
    expect(rules.allows(ethernet), isTrue);
    expect(rules.allows(hotspot), isFalse);
    expect(rules.allows(cellular), isFalse);
    expect(rules.allows(const DeviceNetworkState.unknown()), isFalse);
  });

  test('explicit Wi-Fi choice is distinct from unmetered', () {
    const rules = DownloadNetworkRules(mode: DownloadNetworkMode.wifi);
    expect(rules.allows(wifi), isTrue);
    expect(rules.allows(hotspot), isTrue);
    expect(rules.allows(ethernet), isFalse);
    expect(rules.allows(cellular), isFalse);
  });

  test('any network still honors the independent roaming restriction', () {
    const rules = DownloadNetworkRules(mode: DownloadNetworkMode.any);
    expect(rules.allows(cellular), isTrue);
    expect(rules.allows(roaming), isFalse);
    expect(
      const DownloadNetworkRules(
        mode: DownloadNetworkMode.any,
        allowRoaming: true,
      ).allows(roaming),
      isTrue,
    );
  });

  test(
    'explicit one-off permits metered but never offline or blocked roaming',
    () {
      const rules = DownloadNetworkRules();
      expect(rules.allows(cellular), isFalse);
      expect(rules.allows(cellular, oneOff: true), isTrue);
      expect(rules.allows(roaming, oneOff: true), isFalse);
      expect(
        rules.allows(const DeviceNetworkState.unknown(), oneOff: true),
        isFalse,
      );
    },
  );

  test('unknown relevant network facts cannot admit a restricted transfer', () {
    expect(
      const DownloadNetworkRules().allows(
        const DeviceNetworkState(connected: true, wifi: true, roaming: false),
      ),
      isFalse,
    );
    expect(
      const DownloadNetworkRules(mode: DownloadNetworkMode.wifi).allows(
        const DeviceNetworkState(
          connected: true,
          metered: false,
          roaming: false,
        ),
      ),
      isFalse,
    );
    expect(
      const DownloadNetworkRules(mode: DownloadNetworkMode.any).allows(
        const DeviceNetworkState(connected: true, wifi: true, metered: false),
      ),
      isFalse,
    );
  });

  test('durable rules round-trip with strict version and shape', () {
    for (final mode in DownloadNetworkMode.values) {
      for (final allow in [false, true]) {
        final original = DownloadNetworkRules(mode: mode, allowRoaming: allow);
        final restored = DownloadNetworkRules.decode(original.encode());
        expect(restored.mode, mode);
        expect(restored.allowRoaming, allow);
      }
    }
    for (final row in [
      {'version': 2, 'mode': 'any', 'allowRoaming': true},
      {'version': 1.0, 'mode': 'any', 'allowRoaming': false},
      {'version': '1', 'mode': 'any', 'allowRoaming': false},
      {'version': 1, 'mode': 'future', 'allowRoaming': false},
      {'version': 1, 'mode': 'any', 'allowRoaming': 'false'},
      {'version': 1, 'mode': 'any', 'allowRoaming': false, 'extra': true},
      <String, Object?>{},
    ]) {
      expect(
        () => DownloadNetworkRules.decode(row),
        throwsA(isA<AppFailure>()),
      );
    }
  });
}
