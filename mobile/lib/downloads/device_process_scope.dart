import 'package:flutter/services.dart';

/// Identity of the single Android application process, shared by its engines.
/// Unknown platforms or protocol values never prove that a reader has died.
final class DeviceProcessScope {
  const DeviceProcessScope.unknown() : processInstance = null;
  const DeviceProcessScope._(this.processInstance);
  final String? processInstance;
  static const _channel = MethodChannel('soundspan/storage');
  static final _uuid = RegExp(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  );

  factory DeviceProcessScope.fromNative(Object? value) =>
      value is String && _uuid.hasMatch(value)
      ? DeviceProcessScope._(value)
      : const DeviceProcessScope.unknown();

  static Future<DeviceProcessScope> read({
    Future<Object?> Function()? readInstance,
  }) async {
    try {
      final value =
          await (readInstance != null
                  ? readInstance()
                  : _channel.invokeMethod<Object?>('processInstance'))
              .timeout(const Duration(seconds: 2));
      return DeviceProcessScope.fromNative(value);
    } catch (_) {
      return const DeviceProcessScope.unknown();
    }
  }

  @override
  String toString() => 'DeviceProcessScope(<private>)';
}
