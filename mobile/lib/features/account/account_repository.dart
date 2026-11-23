import '../../core/model/owner_key.dart';
import '../../core/model/app_failure.dart';
import '../../core/network/api_transport.dart';
import '../../core/network/network_policy.dart';
import '../../core/session/session_authority.dart';

enum AccountAction {
  changeEmail,
  changePassword,
  setup2fa,
  enable2fa,
  disable2fa,
  createAppPassword,
  revokeAppPassword,
  createApiKey,
  revokeApiKey,
  unlinkIdentity,
}

class AccountRepository {
  AccountRepository({
    required this.transport,
    required this.authority,
    required this.networkPolicy,
    required this.interactive,
  });
  final ApiTransport transport;
  final SessionAuthority authority;
  final NetworkPolicy networkPolicy;
  final bool interactive;
  Future<Map<String, Object?>> mutate(
    SessionFence fence,
    AccountAction action,
    Map<String, Object?> input,
  ) async {
    if (!interactive) {
      throw const AppFailure(
        code: 'interactive_required',
        message: 'Войдите с паролем для управления безопасностью.',
      );
    }
    final (path, method) = switch (action) {
      AccountAction.changeEmail => ('/api/auth/change-email', ApiMethod.post),
      AccountAction.changePassword => (
        '/api/auth/change-password',
        ApiMethod.post,
      ),
      AccountAction.setup2fa => ('/api/auth/2fa/setup', ApiMethod.post),
      AccountAction.enable2fa => ('/api/auth/2fa/enable', ApiMethod.post),
      AccountAction.disable2fa => ('/api/auth/2fa/disable', ApiMethod.post),
      AccountAction.createAppPassword => (
        '/api/auth/app-passwords',
        ApiMethod.post,
      ),
      AccountAction.revokeAppPassword => (
        '/api/auth/app-passwords/${_id(input)}',
        ApiMethod.delete,
      ),
      AccountAction.createApiKey => ('/api/api-keys', ApiMethod.post),
      AccountAction.revokeApiKey => (
        '/api/api-keys/${_id(input)}',
        ApiMethod.delete,
      ),
      AccountAction.unlinkIdentity => (
        '/api/auth/identities/${_id(input)}',
        ApiMethod.delete,
      ),
    };
    return _send(
      fence,
      path,
      method,
      method == ApiMethod.delete ? null : input,
    );
  }

  Future<Map<String, Object?>> read(SessionFence fence, String resource) async {
    final path = switch (resource) {
      'profile' => '/api/auth/me',
      'twoFactor' => '/api/auth/2fa/status',
      'appPasswords' => '/api/auth/app-passwords',
      'apiKeys' => '/api/api-keys',
      'identities' => '/api/auth/identities',
      _ => throw ArgumentError('Unknown account resource'),
    };
    final result = await _send(fence, path, ApiMethod.get, null);
    if (resource == 'profile') {
      if (result['id'] != fence.owner.userId ||
          result['username'] is! String ||
          (result['email'] != null && result['email'] is! String)) {
        throw _invalidShape;
      }
    } else if (resource == 'twoFactor') {
      if (result['enabled'] is! bool) throw _invalidShape;
    } else {
      final rows = result[resource];
      if (rows is! List) throw _invalidShape;
      for (final row in rows) {
        if (row is! Map || row['id'] is! String) throw _invalidShape;
        final name = resource == 'appPasswords'
            ? 'displayName'
            : resource == 'apiKeys'
            ? 'name'
            : 'provider';
        if (row[name] is! String) throw _invalidShape;
        for (final key in [
          'email',
          'displayName',
          'subjectHint',
          'createdAt',
          'lastUsedAt',
          'lastUsed',
          'expiresAt',
        ]) {
          if (row[key] != null && row[key] is! String) throw _invalidShape;
        }
      }
    }
    return result;
  }

  Future<Map<String, Object?>> _send(
    SessionFence fence,
    String path,
    ApiMethod method,
    Map<String, Object?>? body,
  ) async {
    final request = ApiRequest(
      origin: fence.owner.serverOrigin,
      method: method,
      path: path,
      body: body,
    );
    networkPolicy.requireNetwork();
    await authority.assertCurrent(fence);
    networkPolicy.requireNetwork();
    final result = await transport.send(request, fence: fence);
    await authority.assertCurrent(fence);
    result.requireSuccess();
    return accountObject(result.data);
  }

  static String _id(Map<String, Object?> input) {
    final id = input['id'];
    if (id is! String || !RegExp(r'^[a-zA-Z0-9_-]+$').hasMatch(id)) {
      throw const AppFailure(
        code: 'invalid_id',
        message: 'Некорректный идентификатор.',
      );
    }
    return id;
  }
}

const _invalidShape = AppFailure(
  code: 'invalid_account_data',
  message: 'Некорректный ответ сервера.',
);

Map<String, Object?> accountObject(Object? value) {
  if (value is! Map<String, dynamic>) {
    throw const AppFailure(
      code: 'invalid_account_data',
      message: 'Некорректный ответ сервера.',
    );
  }
  return Map<String, Object?>.from(value);
}
