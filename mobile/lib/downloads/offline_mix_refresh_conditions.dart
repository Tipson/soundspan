import 'package:flutter/services.dart';

import 'device_network_monitor.dart';
import 'offline_mix_daily_refresh.dart';

/// WorkManager is a coarse filter. Read current native facts again before IO.
Future<OfflineMixRefreshConditions> readOfflineMixRefreshConditions(
  DeviceNetworkMonitor monitor, {
  Future<Object?> Function()? charging,
}) async {
  final network = await monitor.refresh();
  Object? actual;
  try {
    actual =
        await (charging != null
                ? charging()
                : const MethodChannel('soundspan/storage')
                      .invokeMethod<Object?>('charging'))
            .timeout(const Duration(seconds: 2));
  } catch (_) {
    /* Unknown never admits automatic IO. */
  }
  return OfflineMixRefreshConditions(
    charging: actual is bool && actual,
    unmetered: network.connected && network.metered == false,
  );
}
