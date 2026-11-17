import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import '../core/model/app_failure.dart';
import 'download_network_rules.dart';

/// Active-route capabilities shared through the native plugin in each engine.
/// Snapshot replies cannot overwrite a newer route event or another refresh.
final class DeviceNetworkMonitor extends ChangeNotifier {
  DeviceNetworkMonitor({
    MethodChannel channel = const MethodChannel('soundspan/download_network'),
    Stream<Object?>? events,
    this.timeout = const Duration(seconds: 3),
  }) : _channel = channel,
       _events =
           events ??
           const EventChannel('soundspan/download_network_events')
               .receiveBroadcastStream();

  final MethodChannel _channel;
  final Stream<Object?> _events;
  final Duration timeout;
  DeviceNetworkState _value = const DeviceNetworkState.unknown();
  AppFailure? _failure;
  StreamSubscription<Object?>? _subscription;
  Future<void>? _starting, _closing;
  int _requestRevision = 0, _eventRevision = 0;
  bool _closed = false;

  DeviceNetworkState get value =>
      _closed ? const DeviceNetworkState.unknown() : _value;
  AppFailure? get failure => _failure;

  Future<void> start() {
    if (_closed) return Future.value();
    return _starting ??= _attach();
  }

  Future<void> _attach() async {
    _subscription = _events.listen(
      _event,
      onError: (Object _) => _event(null),
      onDone: () => _event(null),
    );
    await refresh();
  }

  void _event(Object? raw) {
    if (_closed) return;
    _eventRevision++;
    _publish(_decode(raw));
  }

  Future<DeviceNetworkState> refresh() async {
    if (_closed) return const DeviceNetworkState.unknown();
    final request = ++_requestRevision, event = _eventRevision;
    Object? raw;
    try {
      raw = await _channel.invokeMethod<Object?>('snapshot').timeout(timeout);
    } catch (_) {
      // A missing plugin, timeout or malformed result cannot retain an allow.
    }
    if (!_closed && request == _requestRevision && event == _eventRevision) {
      _publish(_decode(raw));
    }
    return value;
  }

  static DeviceNetworkState? _decode(Object? raw) {
    if (raw is! Map ||
        raw.length != 5 ||
        !raw.keys.toSet().containsAll({
          'v',
          'connected',
          'wifi',
          'metered',
          'roaming',
        }) ||
        raw['v'] is! int ||
        raw['v'] != 1 ||
        raw['connected'] is! bool ||
        [
          'wifi',
          'metered',
          'roaming',
        ].any((key) => raw[key] != null && raw[key] is! bool)) {
      return null;
    }
    return DeviceNetworkState(
      connected: raw['connected'] as bool,
      wifi: raw['wifi'] as bool?,
      metered: raw['metered'] as bool?,
      roaming: raw['roaming'] as bool?,
    );
  }

  void _publish(DeviceNetworkState? state) {
    if (_closed) return;
    final next = state ?? const DeviceNetworkState.unknown();
    final failed = state == null;
    final changed =
        next.connected != _value.connected ||
        next.wifi != _value.wifi ||
        next.metered != _value.metered ||
        next.roaming != _value.roaming ||
        failed != (_failure != null);
    _value = next;
    _failure = failed ? unavailable : null;
    if (changed) notifyListeners();
  }

  static const unavailable = AppFailure(
    code: 'network_state_unavailable',
    message: 'Не удалось определить сеть для загрузок.',
    retryable: true,
  );

  Future<void> close() {
    if (_closing != null) return _closing!;
    _closed = true;
    _requestRevision++;
    _eventRevision++;
    _closing = _subscription?.cancel() ?? Future.value();
    super.dispose();
    return _closing!;
  }

  @override
  void dispose() => unawaited(close());
}
