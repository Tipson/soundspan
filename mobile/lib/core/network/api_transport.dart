import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import '../model/app_failure.dart';
import '../model/owner_key.dart';
import 'request_cancellation.dart';

enum ApiMethod { get, post, put, patch, delete }

/// Fresh anonymous correlation for a logical run or one network dispatch.
String newPlaybackTraceId() => base64Url
    .encode(List<int>.generate(24, (_) => Random.secure().nextInt(256)))
    .replaceAll('=', '');

/// Invalid trace metadata is omitted without affecting playback or admission.
String? normalizePlaybackTraceId(Object? value) =>
    value is String && RegExp(r'^[A-Za-z0-9_-]{1,64}$').hasMatch(value)
    ? value
    : null;

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

/// JSON endpoint request with a dedicated binary input for staging track audio.
/// Paths are API-relative only; credentials belong in a
/// header/body and may never be supplied through query parameters.
final class ApiRequest {
  ApiRequest({
    required Uri origin,
    required this.method,
    required this.path,
    Map<String, String> query = const {},
    Map<String, Object?>? body,
    Uint8List? trackAudioDraftBody,
    this.authenticated = true,
    this.cancellation,
    String? playbackRunId,
  }) : origin = normalizeServerOrigin(origin),
       query = Map.unmodifiable(query),
       body = body == null ? null : _freezeBody(body),
       trackAudioDraftBody = _freezeTrackAudioDraft(trackAudioDraftBody),
       playbackRunId = normalizePlaybackTraceId(playbackRunId) {
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
    if (trackAudioDraftBody != null &&
        (!authenticated ||
            method != ApiMethod.put ||
            body != null ||
            query.isNotEmpty ||
            !_trackAudioDraftPath.hasMatch(path))) {
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
  final Uint8List? trackAudioDraftBody;
  final bool authenticated;
  final RequestCancellation? cancellation;

  /// Optional playback correlation; never authorizes or deduplicates a write.
  final String? playbackRunId;
  Uri get uri => origin
      .resolve(path)
      .replace(queryParameters: query.isEmpty ? null : query);

  static const maxTrackAudioDraftBytes = 16 * 1024 * 1024;
  static final _trackAudioDraftPath = RegExp(
    r'^/api/track-audio/(library|youtube|vk|yandex)/[^/]+/draft$',
  );

  static Uint8List? _freezeTrackAudioDraft(Uint8List? bytes) {
    if (bytes == null) return null;
    if (bytes.isEmpty) {
      throw const AppFailure(code: 'invalid_audio', message: 'Файл MP3 пуст');
    }
    if (bytes.length > maxTrackAudioDraftBytes) {
      throw const AppFailure(
        code: 'request_too_large',
        message: 'Файл MP3 больше 16 МиБ',
      );
    }
    return Uint8List.fromList(bytes).asUnmodifiableView();
  }

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
      if (statusCode == 409 &&
          data is Map &&
          (data as Map)['code'] == 'WAVE_SEQUENCE_RESET') {
        throw const AppFailure(
          code: 'wave_sequence_reset',
          message: 'Последовательность Волны нужно начать заново',
          retryable: true,
          statusCode: 409,
        );
      }
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

/// Low-level JSON response socket boundary, used by broker auth and ApiTransport.
abstract interface class JsonHttpClient {
  Future<ApiResponse> send(ApiRequest request, {String? accessToken});
}

abstract interface class ApiTransport {
  Future<ApiResponse> send(ApiRequest request, {SessionFence? fence});
}
