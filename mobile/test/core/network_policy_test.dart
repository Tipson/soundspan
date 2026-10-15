import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/network/network_policy.dart';

void main() {
  test('network policy is independent of restored credential freshness', () {
    const online = NetworkPolicy.online();
    expect(online.networkAllowed, isTrue);
    expect(online.requireNetwork, returnsNormally);
  });

  test('explicit offline mode refuses admission with a safe typed failure', () {
    const offline = NetworkPolicy.offline();
    expect(offline.networkAllowed, isFalse);
    expect(
      offline.requireNetwork,
      throwsA(isA<AppFailure>().having((e) => e.code, 'code', 'offline_mode')),
    );
  });
}
