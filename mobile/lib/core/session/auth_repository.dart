import '../model/app_failure.dart';
import '../model/owner_key.dart';
import '../network/api_transport.dart';
import '../network/dart_api_transport.dart';
import 'auth_models.dart';
import 'credential_vault.dart';
import 'local_session_authority.dart';
import 'session_authority.dart';

abstract interface class AuthRepository {
  Future<AuthConfig> config(Uri origin);
  Future<LoginResult> login(LoginInput input);
  Future<SessionState> restore(Uri origin);
  Future<AuthUser> me();
  Future<void> logout();
}

/// Auth executes inside the broker. Logout is local and works without network;
/// the server's logout endpoint is stateless and does not revoke native tokens.
final class LocalAuthRepository implements AuthRepository {
  LocalAuthRepository({required this.authority, required this.client});
  final LocalSessionAuthority authority;
  final JsonHttpClient client;

  @override
  Future<AuthConfig> config(Uri origin) async {
    final response = await client.send(
      ApiRequest(
        origin: origin,
        method: ApiMethod.get,
        path: '/api/auth/config',
        authenticated: false,
      ),
    );
    response.requireSuccess();
    final data = _object(response.data);
    if (data['localLoginEnabled'] is! bool ||
        data['oidcEnabled'] is! bool ||
        data['oidcProviderName'] is! String) {
      throw _invalid;
    }
    return AuthConfig(
      localLoginEnabled: data['localLoginEnabled'] as bool,
      oidcEnabled: data['oidcEnabled'] as bool,
      oidcProviderName: data['oidcProviderName'] as String,
    );
  }

  @override
  Future<LoginResult> login(LoginInput input) async {
    final origin = normalizeServerOrigin(input.origin);
    if (input.username.trim().isEmpty ||
        input.password.isEmpty ||
        (input.token != null &&
            !RegExp(r'^(?:\d{6}|[a-fA-F0-9]{8})$').hasMatch(input.token!))) {
      throw const AppFailure(
        code: 'invalid_login_input',
        message: 'Проверьте данные входа',
      );
    }
    final generation = await authority.beginAuthentication();
    final settings = await config(origin);
    authority.assertAuthenticationCurrent(generation);
    if (!settings.localLoginEnabled) {
      throw const AppFailure(
        code: 'local_login_disabled',
        message: 'Вход по паролю отключён на сервере',
      );
    }
    final response = await client.send(
      ApiRequest(
        origin: origin,
        method: ApiMethod.post,
        path: '/api/auth/login',
        authenticated: false,
        body: {
          'username': input.username,
          'password': input.password,
          if (input.token != null) 'token': input.token,
        },
      ),
    );
    response.requireSuccess();
    final data = _object(response.data);
    if (data['requires2FA'] == true) {
      authority.assertAuthenticationCurrent(generation);
      if (data.containsKey('token') || data.containsKey('refreshToken')) {
        throw _invalid;
      }
      return const LoginResult.requires2FA();
    }
    final pair = _tokens(data);
    final user = _object(data['user']);
    final id = _text(user, 'id');
    final owner = OwnerKey(serverOrigin: origin, userId: id);
    await authority.establish(owner, pair, expectedGeneration: generation);
    return LoginResult.success(owner);
  }

  /// Callback passed to LocalSessionAuthority at composition time; no recursive
  /// authenticated transport or automatic retry is used by refresh itself.
  static Future<TokenPair> refresh(
    JsonHttpClient client,
    Uri origin,
    String refreshToken,
  ) async {
    final response = await client.send(
      ApiRequest(
        origin: origin,
        method: ApiMethod.post,
        path: '/api/auth/refresh',
        authenticated: false,
        body: {'refreshToken': refreshToken},
      ),
    );
    response.requireSuccess();
    return _tokens(_object(response.data));
  }

  @override
  Future<SessionState> restore(Uri origin) =>
      authority.restore(normalizeServerOrigin(origin));
  @override
  Future<void> logout() => authority.invalidate();
  @override
  Future<AuthUser> me() async {
    final fence = authority.requireFence();
    final response =
        await DartApiTransport(client: client, authority: authority).send(
          ApiRequest(
            origin: fence.owner.serverOrigin,
            method: ApiMethod.get,
            path: '/api/auth/me',
          ),
          fence: fence,
        );
    final data = _object(response.data);
    if (_text(data, 'id') != fence.owner.userId) throw _invalid;
    return AuthUser(
      owner: fence.owner,
      username: _text(data, 'username'),
      displayName: data['displayName'] is String
          ? data['displayName'] as String
          : null,
    );
  }

  static const _invalid = AppFailure(
    code: 'invalid_auth_response',
    message: 'Некорректный ответ авторизации',
  );
  static Map<String, dynamic> _object(Object? value) {
    if (value is! Map<String, dynamic>) throw _invalid;
    return value;
  }

  static String _text(Map<String, dynamic> value, String key) {
    final result = value[key];
    if (result is! String || result.isEmpty) throw _invalid;
    return result;
  }

  static TokenPair _tokens(Map<String, dynamic> data) {
    final result = TokenPair(
      accessToken: _text(data, 'token'),
      refreshToken: _text(data, 'refreshToken'),
    );
    result.validate();
    return result;
  }
}
