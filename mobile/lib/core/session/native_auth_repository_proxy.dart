import 'auth_models.dart';
import 'auth_repository.dart';
import 'broker_client.dart';
import 'session_authority.dart';
import 'session_broker_protocol.dart';

final class NativeAuthRepositoryProxy implements AuthRepository {
  NativeAuthRepositoryProxy(this.client);
  final BrokerClient client;
  @override
  Future<AuthConfig> config(Uri origin) async {
    final data = BrokerCodec.object(
      await client.call('config', {'origin': origin.toString()}),
      {'localLoginEnabled', 'oidcEnabled', 'oidcProviderName'},
    );
    if (data['oidcProviderName'] is! String) throw BrokerCodec.invalid;
    return AuthConfig(
      localLoginEnabled: BrokerCodec.boolean(data['localLoginEnabled']),
      oidcEnabled: BrokerCodec.boolean(data['oidcEnabled']),
      oidcProviderName: data['oidcProviderName'] as String,
    );
  }

  @override
  Future<LoginResult> login(LoginInput input) async {
    client.clearLocal();
    final data = BrokerCodec.object(
      await client.call('login', {
        'origin': input.origin.toString(),
        'username': input.username,
        'password': input.password,
        'token': input.token,
      }),
      {'requires2FA', 'owner'},
    );
    if (BrokerCodec.boolean(data['requires2FA'])) {
      if (data['owner'] != null) throw BrokerCodec.invalid;
      return const LoginResult.requires2FA();
    }
    return LoginResult.success(BrokerCodec.owner(data['owner']));
  }

  @override
  Future<SessionState> restore(Uri origin) async => BrokerCodec.state(
    await client.call('restore', {'origin': origin.toString()}),
  );
  @override
  Future<AuthUser> me() async {
    final data = BrokerCodec.object(await client.call('me'), {
      'owner',
      'username',
      'displayName',
    });
    if (data['displayName'] != null && data['displayName'] is! String) {
      throw BrokerCodec.invalid;
    }
    return AuthUser(
      owner: BrokerCodec.owner(data['owner']),
      username: BrokerCodec.text(data['username']),
      displayName: data['displayName'] as String?,
    );
  }

  @override
  Future<void> logout() async {
    client.clearLocal();
    await client.call('logout');
  }
}
