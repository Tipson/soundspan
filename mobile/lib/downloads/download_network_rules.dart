import '../core/model/app_failure.dart';

enum DownloadNetworkMode { unmetered, wifi, any }

/// Facts about the active route, without SSID, address or location data.
/// Null capabilities are unknown and cannot satisfy a restrictive rule.
final class DeviceNetworkState {
  const DeviceNetworkState({
    required this.connected,
    this.wifi,
    this.metered,
    this.roaming,
  });
  const DeviceNetworkState.unknown()
    : connected = false,
      wifi = null,
      metered = null,
      roaming = null;

  final bool connected;
  final bool? wifi, metered, roaming;
}

/// Download and prewarm admission only; foreground Play has its own policy.
final class DownloadNetworkRules {
  const DownloadNetworkRules({
    this.mode = DownloadNetworkMode.unmetered,
    this.allowRoaming = false,
  });

  final DownloadNetworkMode mode;
  final bool allowRoaming;
  static const namespace = 'settings';
  static const key = 'downloadNetwork';

  factory DownloadNetworkRules.decode(Map<String, Object?>? row) {
    if (row == null) return const DownloadNetworkRules();
    if (row.length != 3 ||
        row['version'] is! int ||
        row['version'] != 1 ||
        row['allowRoaming'] is! bool) {
      throw invalid;
    }
    final mode = switch (row['mode']) {
      'unmetered' => DownloadNetworkMode.unmetered,
      'wifi' => DownloadNetworkMode.wifi,
      'any' => DownloadNetworkMode.any,
      _ => throw invalid,
    };
    return DownloadNetworkRules(
      mode: mode,
      allowRoaming: row['allowRoaming'] as bool,
    );
  }

  Map<String, Object?> encode() => {
    'version': 1,
    'mode': mode.name,
    'allowRoaming': allowRoaming,
  };

  /// A caller may supply an explicit one-job permission. It never overrides
  /// lack of a route or the independent roaming restriction.
  bool allows(DeviceNetworkState state, {bool oneOff = false}) {
    if (!state.connected || (!allowRoaming && state.roaming != false)) {
      return false;
    }
    if (oneOff) return true;
    return switch (mode) {
      DownloadNetworkMode.unmetered => state.metered == false,
      DownloadNetworkMode.wifi => state.wifi == true,
      DownloadNetworkMode.any => true,
    };
  }

  static const invalid = AppFailure(
    code: 'invalid_download_network_preference',
    message: 'Настройка сети для загрузок недоступна. Выберите её снова.',
  );
}
