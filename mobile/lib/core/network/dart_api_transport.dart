import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';

import '../model/app_failure.dart';
import '../model/owner_key.dart';
import '../session/session_authority.dart';
import 'api_transport.dart';
import 'network_policy.dart';
import 'retry_after.dart';

/// One original operation owns one 401 replay budget. Lost mutation responses,
/// transient failures and provider failures are never retried automatically.
final class DartApiTransport implements ApiTransport {
  DartApiTransport({required this.client, required this.authority});
  final JsonHttpClient client;
  final SessionAuthority authority;

  @override
  Future<ApiResponse> send(ApiRequest request, {SessionFence? fence}) async {
    if (!request.authenticated) {
      final response = await client.send(request);
      response.requireSuccess();
      return response;
    }
    final captured = fence ?? authority.requireFence();
    for (var attempt = 0; attempt < 2; attempt++) {
      final grant = await authority.grantAccess(captured, request.origin);
      final response = await client.send(
        request,
        accessToken: grant.accessToken,
      );
      await authority.assertCurrent(captured);
      if (response.statusCode == 401 && attempt == 0) {
        await authority.after401(grant.authStamp);
        continue;
      }
      response.requireSuccess();
      return response;
    }
    throw StateError('Unreachable replay limit');
  }
}

/// Standard verified TLS, a bounded total deadline and bounded JSON response.
/// JSON redirects are explicitly rejected; media redirects have a separate
/// capability policy. No shared cookie jar or browser credential propagation.
final class DartJsonHttpClient implements JsonHttpClient {
  DartJsonHttpClient({
    this.timeout = const Duration(seconds: 30),
    this.maxResponseBytes = 4 * 1024 * 1024,
    this._securityContext,
    this.networkPolicy = const NetworkPolicy.online(),
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now {
    if (networkPolicy is Listenable) {
      (networkPolicy as Listenable).addListener(_policyChanged);
    }
  }
  final Duration timeout;
  final int maxResponseBytes;
  final SecurityContext? _securityContext;
  final DateTime Function() _now;
  final NetworkPolicy networkPolicy;
  final _active = <_JsonOperation>{};
  bool _closed = false;
  Future<void>? _closing;

  void _policyChanged() {
    if (!networkPolicy.networkAllowed) _cancelActive();
  }

  List<_JsonOperation> _cancelActive() {
    final active = _active.toList(growable: false);
    for (final operation in active) {
      operation.cancelled = true;
      operation.client.close(force: true);
    }
    return active;
  }

  /// Sockets close synchronously. A later explicit request is allowed only if
  /// the shared policy permits it; cancelled operations never replay.
  Future<void> cancelPending() => Future.wait<void>(
    _cancelActive().map((operation) => operation.done.future),
  ).then((_) {});

  Future<void> close() {
    if (_closing != null) return _closing!;
    final completion = Completer<void>();
    _closing = completion.future;
    _closed = true;
    if (networkPolicy is Listenable) {
      (networkPolicy as Listenable).removeListener(_policyChanged);
    }
    completion.complete(cancelPending());
    return completion.future;
  }

  void _check([_JsonOperation? operation]) {
    if (_closed || operation?.cancelled == true) {
      throw const AppFailure(
        code: 'network_cancelled',
        message: 'Запрос отменён.',
      );
    }
    networkPolicy.requireNetwork();
  }

  @override
  Future<ApiResponse> send(ApiRequest request, {String? accessToken}) async {
    _check();
    final client = HttpClient(context: _securityContext)
      ..connectionTimeout = timeout;
    final operation = _JsonOperation(client);
    _active.add(operation);
    // Each operation owns its sockets; timeout must abort I/O, not merely stop
    // awaiting a still-active mutating request or an unbounded response stream.
    try {
      final response = await _send(
        operation,
        request,
        accessToken,
      ).timeout(timeout);
      _check(operation);
      return response;
    } catch (error) {
      _check(operation);
      if (error is AppFailure) rethrow;
      if (error is TimeoutException) {
        throw const AppFailure(
          code: 'network_timeout',
          message: 'Сервер не ответил вовремя',
          retryable: true,
        );
      }
      if (error is HandshakeException) {
        throw const AppFailure(
          code: 'tls_failed',
          message: 'Не удалось проверить защищённое соединение',
        );
      }
      if (error is SocketException) {
        throw const AppFailure(
          code: 'network_unavailable',
          message: 'Нет соединения с сервером',
          retryable: true,
        );
      }
      if (error is HttpException) {
        throw const AppFailure(
          code: 'invalid_http_response',
          message: 'Некорректный ответ сервера',
        );
      }
      if (error is FormatException) {
        throw const AppFailure(
          code: 'invalid_json',
          message: 'Некорректный ответ сервера',
        );
      }
      rethrow;
    } finally {
      client.close(force: true);
      _active.remove(operation);
      operation.done.complete();
    }
  }

  Future<ApiResponse> _send(
    _JsonOperation operation,
    ApiRequest input,
    String? token,
  ) async {
    final request = await operation.client.openUrl(
      input.method.name.toUpperCase(),
      input.uri,
    );
    _check(operation);
    request.followRedirects = false;
    request.maxRedirects = 0;
    request.headers.set(HttpHeaders.acceptHeader, 'application/json');
    if (token != null) {
      if (!input.authenticated ||
          token.isEmpty ||
          RegExp(r'[\s\x00-\x1f\x7f]').hasMatch(token)) {
        throw invalidTarget;
      }
      request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
    }
    if (input.body != null) {
      request.headers.contentType = ContentType.json;
      request.add(utf8.encode(jsonEncode(input.body)));
    }
    final response = await request.close();
    _check(operation);
    if (response.statusCode >= 300 && response.statusCode < 400) {
      throw const AppFailure(
        code: 'api_redirect_rejected',
        message: 'Сервер перенаправил API-запрос',
      );
    }
    if (response.contentLength > maxResponseBytes) throw _tooLarge;
    final bytes = <int>[];
    await for (final chunk in response) {
      _check(operation);
      if (bytes.length + chunk.length > maxResponseBytes) throw _tooLarge;
      bytes.addAll(chunk);
    }
    if (bytes.isEmpty && response.statusCode == 204) {
      return const ApiResponse(204, null);
    }
    // Non-JSON error responses still retain status for 401/429/503 policy.
    if (response.statusCode < 200 || response.statusCode >= 300) {
      return ApiResponse(
        response.statusCode,
        null,
        retryAfter: RetryAfterPolicy.parse(
          statusCode: response.statusCode,
          values: response.headers[HttpHeaders.retryAfterHeader],
          now: _now(),
        ),
      );
    }
    final mime = response.headers.contentType?.mimeType;
    if (mime != 'application/json' && !(mime?.endsWith('+json') ?? false)) {
      throw const AppFailure(
        code: 'invalid_json_type',
        message: 'Сервер вернул данные другого типа',
      );
    }
    return ApiResponse(response.statusCode, jsonDecode(utf8.decode(bytes)));
  }

  static const _tooLarge = AppFailure(
    code: 'response_too_large',
    message: 'Слишком большой ответ сервера',
  );
}

final class _JsonOperation {
  _JsonOperation(this.client);
  final HttpClient client;
  final done = Completer<void>();
  bool cancelled = false;
}
