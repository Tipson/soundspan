import '../model/app_failure.dart';
import '../model/owner_key.dart';
import 'broker_client.dart';
import 'session_authority.dart';
import 'session_broker_protocol.dart';

/// Its state is only a UI cache. Every admission goes through the broker.
final class NativeSessionAuthorityProxy implements SessionAuthority {
  NativeSessionAuthorityProxy._(this.client);
  final BrokerClient client;
  static Future<NativeSessionAuthorityProxy> attach(
    BrokerClient client,
    ClientRole role, {
    SessionFence? expectedFence,
  }) async {
    await client.attach(role, expectedFence: expectedFence);
    return NativeSessionAuthorityProxy._(client);
  }

  @override
  SessionState get state => client.state;
  @override
  Stream<SessionState> get changes => client.changes;
  @override
  SessionFence requireFence() =>
      state.fence ??
      (throw const AppFailure(
        code: 'session_revoked',
        message: 'Сессия завершена',
      ));
  @override
  bool isCurrent(SessionFence fence) => state.fence == fence;
  @override
  Future<void> assertCurrent(SessionFence fence) async {
    await client.call('assertCurrent', {
      'fence': BrokerCodec.encodeFence(fence),
    });
  }

  @override
  Future<AccessGrant> grantAccess(SessionFence fence, Uri exactOrigin) async {
    if (exactOrigin != fence.owner.serverOrigin) {
      throw const AppFailure(
        code: 'origin_mismatch',
        message: 'Недопустимый сервер',
      );
    }
    final data = BrokerCodec.object(
      await client.call('grantAccess', {
        'fence': BrokerCodec.encodeFence(fence),
        'origin': exactOrigin.toString(),
      }),
      {'stamp', 'accessToken'},
    );
    final stamp = BrokerCodec.stamp(data['stamp']);
    if (stamp.fence != fence) throw BrokerCodec.invalid;
    return AccessGrant(
      authStamp: stamp,
      accessToken: BrokerCodec.text(data['accessToken']),
    );
  }

  @override
  Future<AuthStamp> after401(AuthStamp rejected) async => BrokerCodec.stamp(
    await client.call('after401', {'stamp': BrokerCodec.encodeStamp(rejected)}),
  );
  @override
  Future<void> invalidate() async {
    client.clearLocal();
    await client.call('logout');
  }

  Future<void> close() => client.close();
}
