import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';

import '../core/model/app_failure.dart';
import '../core/model/owner_key.dart';
import '../core/network/api_transport.dart';
import '../core/network/network_policy.dart';
import '../core/network/retry_after.dart';
import '../core/session/session_authority.dart';
import '../features/settings/settings_models.dart';
import '../features/settings/settings_repository.dart';

/// Only this owner's profile endpoints. The image is never handed to a foreign
/// URL, browser cookie jar, persistent cache, or a second authentication owner.
final class OwnerAvatarUploader implements AvatarUploader, AvatarPictureCache {
  OwnerAvatarUploader({
    required this.authority,
    required this.fence,
    required this.networkPolicy,
    this.securityContext,
    this.timeout = const Duration(seconds: 30),
  }) {
    _session = authority.changes.listen((_) {
      if (!authority.isCurrent(fence)) {
        _cancel();
        if (!_closed) clearPicture();
      }
    });
    if (networkPolicy is Listenable) {
      (networkPolicy as Listenable).addListener(_policyChanged);
    }
  }
  final SessionAuthority authority;
  final SessionFence fence;
  final NetworkPolicy networkPolicy;
  final SecurityContext? securityContext;
  final Duration timeout;
  final picture = ValueNotifier<Uint8List?>(null);
  late final StreamSubscription<SessionState> _session;
  final _active = <_AvatarOperation>{};
  bool _closed = false;
  Future<void>? _closing;
  int _pictureRevision = 0;

  void _policyChanged() {
    if (!networkPolicy.networkAllowed) _cancel();
  }

  void _cancel() {
    for (final operation in _active.toList(growable: false)) {
      operation.cancelled = true;
      operation.client.close(force: true);
    }
  }

  void _guard([_AvatarOperation? operation]) {
    if (_closed || operation?.cancelled == true) throw _cancelled;
    if (!authority.isCurrent(fence)) throw _stale;
    networkPolicy.requireNetwork();
  }

  @override
  Future<void> upload(AvatarInput input, SessionFence originalFence) async {
    if (originalFence != fence) throw _stale;
    _guard();
    final revision = ++_pictureRevision;
    final response = await _request(
      method: 'POST',
      path: '/api/settings/profile-picture',
      image: input,
      maxBytes: 64 * 1024,
    );
    _guard();
    if (response.mime != 'application/json' &&
        !(response.mime?.endsWith('+json') ?? false)) {
      throw _invalidReceipt;
    }
    Object? receipt;
    try {
      receipt = jsonDecode(utf8.decode(response.bytes));
    } on FormatException {
      throw _invalidReceipt;
    }
    if (receipt is! Map || receipt['success'] != true) throw _invalidReceipt;
    _guard();
    if (revision == _pictureRevision) picture.value = input.bytes;
  }

  /// Refreshes only this owner's image in memory. Late reads cannot undo a
  /// later upload or an acknowledged deletion.
  Future<void> loadPicture() async {
    _guard();
    final revision = ++_pictureRevision;
    final path =
        '/api/social/profile-picture/${Uri.encodeComponent(fence.owner.userId)}';
    _AvatarResponse response;
    try {
      response = await _request(
        method: 'GET',
        path: path,
        maxBytes: AvatarInput.maxBytes,
      );
    } on AppFailure catch (error) {
      _guard();
      if (error.statusCode != 404) rethrow;
      if (revision == _pictureRevision) picture.value = null;
      return;
    }
    _guard();
    if (revision != _pictureRevision) return;
    if (!const {
      'image/jpeg',
      'image/png',
      'image/webp',
    }.contains(response.mime)) {
      throw _invalidPicture;
    }
    final input = await AvatarInput.validate(response.bytes);
    _guard();
    if (input.mimeType != response.mime) throw _invalidPicture;
    if (revision == _pictureRevision) picture.value = input.bytes;
  }

  /// Called after a confirmed deletion, or when this owner's session ends.
  @override
  void clearPicture() {
    if (_closed) return;
    _pictureRevision++;
    picture.value = null;
  }

  Future<_AvatarResponse> _request({
    required String method,
    required String path,
    required int maxBytes,
    AvatarInput? image,
  }) async {
    _guard();
    final client = HttpClient(context: securityContext)
      ..connectionTimeout = timeout;
    final operation = _AvatarOperation(client);
    _active.add(operation);
    try {
      final response = await _send(
        operation,
        method,
        path,
        maxBytes,
        image,
      ).timeout(timeout);
      _guard(operation);
      return response;
    } catch (error) {
      _guard(operation);
      if (error is AppFailure) rethrow;
      if (error is TimeoutException) {
        throw const AppFailure(
          code: 'network_timeout',
          message: 'Сервер не ответил вовремя.',
          retryable: true,
        );
      }
      throw const AppFailure(
        code: 'avatar_network_failed',
        message: 'Не удалось передать фото. Проверьте соединение.',
      );
    } finally {
      operation.cancelled = true;
      client.close(force: true);
      _active.remove(operation);
      operation.done.complete();
    }
  }

  Future<_AvatarResponse> _send(
    _AvatarOperation operation,
    String method,
    String path,
    int maxBytes,
    AvatarInput? image,
  ) async {
    final origin = normalizeServerOrigin(fence.owner.serverOrigin);
    await authority.assertCurrent(fence);
    _guard(operation);
    final grant = await authority.grantAccess(fence, origin);
    _guard(operation);
    if (grant.authStamp.fence != fence ||
        grant.accessToken.isEmpty ||
        RegExp(r'[\s\x00-\x1f\x7f]').hasMatch(grant.accessToken)) {
      throw _stale;
    }
    final request = await operation.client.openUrl(
      method,
      origin.resolve(path),
    );
    request.followRedirects = false;
    request.maxRedirects = 0;
    await authority.assertCurrent(fence);
    _guard(operation);
    request.headers.set(
      HttpHeaders.authorizationHeader,
      'Bearer ${grant.accessToken}',
    );
    request.headers.set(
      HttpHeaders.acceptHeader,
      method == 'GET'
          ? 'image/jpeg, image/png, image/webp'
          : 'application/json',
    );
    if (image != null) {
      final random = Random.secure();
      final boundary =
          'soundspan-${List.generate(24, (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0')).join()}';
      final prefix = utf8.encode(
        '--$boundary\r\nContent-Disposition: form-data; name="file"; filename="${image.filename}"\r\nContent-Type: ${image.mimeType}\r\n\r\n',
      );
      final suffix = utf8.encode('\r\n--$boundary--\r\n');
      request.headers.set(
        HttpHeaders.contentTypeHeader,
        'multipart/form-data; boundary=$boundary',
      );
      request.contentLength =
          prefix.length + image.bytes.length + suffix.length;
      await request.addStream(
        _multipart(operation, prefix, image.bytes, suffix),
      );
      _guard(operation);
    }
    final response = await request.close();
    _guard(operation);
    final status = response.statusCode;
    if (status >= 300 && status < 400) {
      throw const AppFailure(
        code: 'api_redirect_rejected',
        message:
            'Сервер перенаправил запрос. Фото не отправлено на другой адрес.',
      );
    }
    if (status < 200 || status >= 300) {
      final failure = failureForStatus(
        status,
        retryAfter: RetryAfterPolicy.parse(
          statusCode: status,
          values: response.headers[HttpHeaders.retryAfterHeader],
          now: DateTime.now(),
        ),
      );
      // A 401 refusal may refresh the central credential revision, but a POST
      // is not replayed. The user may explicitly choose the image again.
      operation.client.close(force: true);
      if (status == 401) {
        await authority.after401(grant.authStamp);
        _guard(operation);
      }
      throw failure;
    }
    if (response.contentLength > maxBytes) throw _largeResponse;
    final bytes = BytesBuilder(copy: false);
    await for (final chunk in response) {
      _guard(operation);
      if (bytes.length + chunk.length > maxBytes) throw _largeResponse;
      bytes.add(chunk);
    }
    await authority.assertCurrent(fence);
    _guard(operation);
    return _AvatarResponse(
      response.headers.contentType?.mimeType,
      bytes.takeBytes(),
    );
  }

  Stream<List<int>> _multipart(
    _AvatarOperation operation,
    List<int> prefix,
    Uint8List bytes,
    List<int> suffix,
  ) async* {
    _guard(operation);
    yield prefix;
    for (var offset = 0; offset < bytes.length; offset += 32 * 1024) {
      _guard(operation);
      yield Uint8List.sublistView(
        bytes,
        offset,
        min(offset + 32 * 1024, bytes.length),
      );
    }
    _guard(operation);
    yield suffix;
  }

  Future<void> close() {
    if (_closing != null) return _closing!;
    final done = Completer<void>();
    _closing = done.future;
    _closed = true;
    _pictureRevision++;
    if (networkPolicy is Listenable) {
      (networkPolicy as Listenable).removeListener(_policyChanged);
    }
    _cancel();
    picture.value = null;
    done.complete(() async {
      await _session.cancel();
      await Future.wait(
        _active.map((operation) => operation.done.future).toList(),
      );
      picture.dispose();
    }());
    return done.future;
  }

  static const _cancelled = AppFailure(
    code: 'network_cancelled',
    message: 'Запрос отменён.',
  );
  static const _stale = AppFailure(
    code: 'stale_session',
    message: 'Сеанс завершён.',
  );
  static const _invalidReceipt = AppFailure(
    code: 'avatar_receipt_invalid',
    message: 'Не удалось подтвердить обновление фото. Обновите профиль.',
  );
  static const _largeResponse = AppFailure(
    code: 'response_too_large',
    message: 'Слишком большой ответ сервера.',
  );
  static const _invalidPicture = AppFailure(
    code: 'invalid_avatar',
    message: 'Сервер вернул неподдерживаемое фото профиля.',
  );
}

final class _AvatarOperation {
  _AvatarOperation(this.client);
  final HttpClient client;
  final done = Completer<void>();
  bool cancelled = false;
}

final class _AvatarResponse {
  const _AvatarResponse(this.mime, this.bytes);
  final String? mime;
  final Uint8List bytes;
}
