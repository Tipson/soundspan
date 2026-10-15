import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../core/model/app_failure.dart';
import '../../core/model/owner_key.dart';
import '../../core/network/api_transport.dart';
import '../../core/network/network_policy.dart';
import '../../core/session/session_authority.dart';

const staleCapability = AppFailure(
  code: 'stale_session',
  message: 'Сеанс или действие завершено.',
);
const invalidCapability = AppFailure(
  code: 'invalid_capability_data',
  message: 'Некорректный ответ сервера.',
);

/// Shared authenticated owner boundary for links and inbox. No mutation retry.
class OwnerEndpoint {
  OwnerEndpoint({
    required this.transport,
    required this.authority,
    required this.fence,
    required this.networkPolicy,
  });
  final ApiTransport transport;
  final SessionAuthority authority;
  final SessionFence fence;
  final NetworkPolicy networkPolicy;
  bool _closed = false;
  bool get isCurrent => !_closed && authority.isCurrent(fence);
  Future<void> guard([bool Function()? current]) async {
    if (!isCurrent || current?.call() == false) throw staleCapability;
    await authority.assertCurrent(fence);
    if (!isCurrent || current?.call() == false) throw staleCapability;
  }

  Future<Object?> request(
    String path, {
    ApiMethod method = ApiMethod.get,
    Map<String, Object?>? body,
    bool Function()? current,
    VoidCallback? admitted,
  }) async {
    final request = ApiRequest(
      origin: fence.owner.serverOrigin,
      method: method,
      path: path,
      body: body,
    );
    await guard(current);
    networkPolicy.requireNetwork();
    admitted?.call();
    final response = await transport.send(request, fence: fence);
    // Back retires presentation; an already admitted response may acknowledge
    // the original operation. The durable authority still fences all results.
    await authority.assertCurrent(fence);
    response.requireSuccess();
    return response.data;
  }

  Future<void> close() async {
    _closed = true;
  }
}

/// One serialized feature operation. Retiring a route immediately erases data,
/// then drains its admitted operation before the native owner may retire.
abstract class MemoryFeatureController extends ChangeNotifier {
  MemoryFeatureController(this.endpoint) {
    _session = endpoint.authority.changes.listen((_) {
      if (!endpoint.isCurrent) {
        clearData();
        changed();
      }
    });
  }
  final OwnerEndpoint endpoint;
  late final StreamSubscription<SessionState> _session;
  bool _closed = false, _disposed = false;
  bool busy = false;
  AppFailure? failure;
  String? message;
  Future<void>? _flight, _closing;
  VoidCallback? onClosed;
  bool get isCurrent => !_closed && endpoint.isCurrent;
  bool get canRead => isCurrent && endpoint.networkPolicy.networkAllowed;
  void clearData();
  void changed() {
    if (!_closed && !_disposed) notifyListeners();
  }

  Future<void> work(Future<void> Function() operation) {
    if (!isCurrent || busy) return Future.value();
    busy = true;
    failure = null;
    changed();
    final next = () async {
      try {
        await operation();
      } catch (error) {
        if (isCurrent) failure = safeCapabilityFailure(error);
      } finally {
        busy = false;
        changed();
      }
    }();
    _flight = next;
    return next;
  }

  Future<void> close() {
    if (_closing != null) return _closing!;
    _closed = true;
    clearData();
    failure = null;
    message = null;
    final retired = endpoint.close();
    return _closing = () async {
      await Future.wait([retired, ?_flight, _session.cancel()]);
      onClosed?.call();
      onClosed = null;
      if (!_disposed) dispose();
    }();
  }

  @override
  void dispose() {
    unawaited(close());
    if (!_disposed) {
      _disposed = true;
      super.dispose();
    }
  }
}

AppFailure safeCapabilityFailure(Object error) =>
    error is AppFailure &&
        const {
          'offline_mode',
          'stale_session',
          'share_pending',
          'unsupported_share',
          'invalid_share_options',
          'share_unavailable',
        }.contains(error.code)
    ? error
    : const AppFailure(
        code: 'capability_failed',
        message: 'Не удалось выполнить действие. Обновите список и проверьте результат.',
      );

String capabilityId(Object? value) {
  if (value is! String ||
      value.length > 256 ||
      !RegExp(r'^[A-Za-z0-9_-]+$').hasMatch(value)) {
    throw invalidCapability;
  }
  return value;
}

Map<String, Object?> capabilityObject(Object? value) {
  if (value is! Map<String, dynamic>) throw invalidCapability;
  return Map<String, Object?>.from(value);
}
