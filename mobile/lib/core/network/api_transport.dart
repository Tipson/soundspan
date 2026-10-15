import 'dart:convert';

import '../model/app_failure.dart';
import '../model/owner_key.dart';

enum ApiMethod { get, post, put, patch, delete }

/// Strict HTTPS origin normalization. No URL credentials, suffix host aliases,
/// paths, fragments or query strings are accepted at the server boundary.
Uri normalizeServerOrigin(Uri value) {
  if (value.host.endsWith('.') || value.toString().contains('@')) {
    throw invalidTarget;
  }
  try {
    return OwnerKey(
      serverOrigin: value,
      userId: '_origin_validation',
    ).serverOrigin;
  } on ArgumentError {
    throw invalidTarget;
  }
}

const invalidTarget = AppFailure(
  code: 'invalid_api_target',
  message: 'Недопустимый адрес сервера',
);

/// JSON endpoint request. Paths are API-relative only; credentials belong in a
/// header/body and may never be supplied through query parameters.
final class ApiRequest {
  ApiRequest({
    required Uri origin,
    required this.method,
    required this.path,
    Map<String, String> query = const {},
    Map<String, Object?>? body,
    this.authenticated = true,
  }) : origin = normalizeServerOrigin(origin),
       query = Map.unmodifiable(query),
       body = body == null ? null : _freezeBody(body) {
    if (!path.startsWith('/api/') ||
        path.contains(RegExp(r'[\\?#\x00-\x20\x7f]')) ||
        path.contains('//') ||
        RegExp(
          r'%(?:2f|5c|2e|0[ad]|25)',
          caseSensitive: false,
        ).hasMatch(path) ||
        path.split('/').any((p) => p == '.' || p == '..') ||
        query.keys.any(
          (key) => RegExp(
            r'^(?:token|access[_-]?token|refresh[_-]?token|authorization|password)$',
            caseSensitive: false,
          ).hasMatch(key),
        )) {
      throw invalidTarget;
    }
    if (!authenticated &&
        path == '/api/auth/register' &&
        method != ApiMethod.post) {
      throw invalidTarget;
    }
    if (!authenticated &&
        !const {
          '/api/auth/config',
          '/api/auth/login',
          '/api/auth/refresh',
          '/api/auth/register',
        }.contains(path)) {
      throw invalidTarget;
    }
  }

  final Uri origin;
  final ApiMethod method;
  final String path;
  final Map<String, String> query;
  final Map<String, Object?>? body;
  final bool authenticated;
  Uri get uri => origin
      .resolve(path)
      .replace(queryParameters: query.isEmpty ? null : query);

  static Map<String, Object?> _freezeBody(Map<String, Object?> body) {
    // Snapshot before the first await: a caller cannot mutate a replay body.
    final encoded = jsonEncode(body);
    if (encoded.length > 1024 * 1024) {
      throw const AppFailure(
        code: 'request_too_large',
        message: 'Слишком большой запрос',
      );
    }
    return Map<String, Object?>.unmodifiable(
      jsonDecode(encoded) as Map<String, dynamic>,
    );
  }

  @override
  String toString() => 'ApiRequest(${method.name}, <redacted>)';
}

final class ApiResponse {
  const ApiResponse(this.statusCode, this.data, {this.retryAfter});
  final int statusCode;
  final Object? data;
  final Duration? retryAfter;
  bool get isSuccess => statusCode >= 200 && statusCode < 300;
  void requireSuccess() {
    if (!isSuccess) {
      throw failureForStatus(statusCode, retryAfter: retryAfter);
    }
  }
}

AppFailure failureForStatus(int status, {Duration? retryAfter}) => AppFailure(
  code: status == 401 ? 'unauthorized' : 'http_error',
  message: status == 401
      ? 'Требуется авторизация'
      : 'Сервер не выполнил запрос',
  statusCode: status,
  retryable: status == 429 || status == 503,
  retryAfter: status == 429 || status == 503 ? retryAfter : null,
);

/// Low-level JSON socket boundary, used by broker auth and ApiTransport only.
abstract interface class JsonHttpClient {
  Future<ApiResponse> send(ApiRequest request, {String? accessToken});
}

abstract interface class ApiTransport {
  Future<ApiResponse> send(ApiRequest request, {SessionFence? fence});
}
