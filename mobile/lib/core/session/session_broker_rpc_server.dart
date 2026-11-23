import 'dart:async';

import '../model/app_failure.dart';
import '../model/owner_key.dart';
import '../network/api_transport.dart';
import 'auth_models.dart';
import 'auth_repository.dart';
import 'session_authority.dart';
import 'session_broker_protocol.dart';

/// Lives only in the dedicated broker isolate. Calls overlap intentionally:
/// logout must revoke an in-flight login/refresh immediately, not queue behind it.
final class SessionBrokerRpcServer {
  SessionBrokerRpcServer({
    required this.authority,
    required this.auth,
    required this.restoreCapturedFence,
  }) {
    _subscription = authority.changes.listen((_) {
      _sequence++;
      _events.add(snapshot);
    });
  }
  final SessionAuthority authority;
  final AuthRepository auth;
  final Future<SessionState> Function(SessionFence) restoreCapturedFence;
  late final StreamSubscription<SessionState> _subscription;
  final _events = StreamController<Map<String, Object?>>.broadcast(sync: true);
  final Map<String, ({ClientRole role, SessionFence? fence})> _clients = {};
  int _sequence = 0;
  bool _coldRestoreAllowed = true;
  Map<String, Object?> get snapshot =>
      BrokerCodec.encodeEvent(_sequence, authority.state);
  Stream<Map<String, Object?>> get events => _events.stream;
  void detach(String clientId) => _clients.remove(clientId);

  Future<Map<String, Object?>> dispatch(
    String clientId,
    Object? request,
  ) async {
    try {
      final envelope = BrokerCodec.object(request, {'v', 'method', 'args'});
      if (envelope['v'] is! int || envelope['v'] != 1) {
        throw BrokerCodec.invalid;
      }
      final method = BrokerCodec.text(envelope['method']);
      final args = envelope['args'];
      if (method == 'attach') {
        final data = BrokerCodec.object(args, {'role', 'expectedFence'});
        final role = ClientRole.values
            .where((r) => r.name == data['role'])
            .firstOrNull;
        if (role == null || _clients.containsKey(clientId)) {
          throw BrokerCodec.invalid;
        }
        final fence = data['expectedFence'] == null
            ? null
            : BrokerCodec.fence(data['expectedFence']);
        if (role == ClientRole.download && fence == null) {
          throw BrokerCodec.invalid;
        }
        if (fence != null) {
          if (_coldRestoreAllowed && authority.state.fence == null) {
            await restoreCapturedFence(fence);
          }
          await authority.assertCurrent(fence);
        }
        _clients[clientId] = (role: role, fence: fence);
        return _ok(snapshot);
      }
      final client = _clients[clientId];
      if (client == null) {
        throw const AppFailure(
          code: 'broker_unattached',
          message: 'Сессия не подключена',
        );
      }
      if (client.fence != null) await authority.assertCurrent(client.fence!);
      if (const {
            'login',
            'logout',
            'restore',
            'config',
            'me',
          }.contains(method) &&
          client.role != ClientRole.ui) {
        throw const AppFailure(
          code: 'broker_role',
          message: 'Недоступная операция',
        );
      }
      if (const {'login', 'logout', 'restore'}.contains(method)) {
        _coldRestoreAllowed = false;
      }
      switch (method) {
        case 'assertCurrent':
          final data = BrokerCodec.object(args, {'fence'});
          await authority.assertCurrent(_fence(data['fence'], client.fence));
          return _ok(null);
        case 'grantAccess':
          final data = BrokerCodec.object(args, {'fence', 'origin'});
          final grant = await authority.grantAccess(
            _fence(data['fence'], client.fence),
            Uri.parse(BrokerCodec.text(data['origin'])),
          );
          return _ok({
            'stamp': BrokerCodec.encodeStamp(grant.authStamp),
            'accessToken': grant.accessToken,
          });
        case 'after401':
          final data = BrokerCodec.object(args, {'stamp'});
          final rejected = BrokerCodec.stamp(data['stamp']);
          _fence(BrokerCodec.encodeFence(rejected.fence), client.fence);
          return _ok(
            BrokerCodec.encodeStamp(await authority.after401(rejected)),
          );
        case 'config':
          final data = BrokerCodec.object(args, {'origin'});
          final config = await auth.config(
            normalizeServerOrigin(Uri.parse(BrokerCodec.text(data['origin']))),
          );
          return _ok({
            'localLoginEnabled': config.localLoginEnabled,
            'oidcEnabled': config.oidcEnabled,
            'oidcProviderName': config.oidcProviderName,
          });
        case 'login':
          final data = BrokerCodec.object(args, {
            'origin',
            'username',
            'password',
            'token',
          });
          final result = await auth.login(
            LoginInput(
              origin: Uri.parse(BrokerCodec.text(data['origin'])),
              username: BrokerCodec.text(data['username']),
              password: BrokerCodec.text(data['password']),
              token: data['token'] == null
                  ? null
                  : BrokerCodec.text(data['token']),
            ),
          );
          return _ok({
            'requires2FA': result.requires2FA,
            'owner': result.owner == null
                ? null
                : BrokerCodec.encodeOwner(result.owner!),
          });
        case 'restore':
          final data = BrokerCodec.object(args, {'origin'});
          return _ok(
            BrokerCodec.encodeState(
              await auth.restore(Uri.parse(BrokerCodec.text(data['origin']))),
            ),
          );
        case 'me':
          BrokerCodec.object(args, {});
          final user = await auth.me();
          return _ok({
            'owner': BrokerCodec.encodeOwner(user.owner),
            'username': user.username,
            'displayName': user.displayName,
          });
        case 'logout':
          BrokerCodec.object(args, {});
          await auth.logout();
          return _ok(null);
        default:
          throw BrokerCodec.invalid;
      }
    } on AppFailure catch (error) {
      return _error(error);
    } catch (_) {
      return _error(
        const AppFailure(code: 'broker_failure', message: 'Сессия недоступна'),
      );
    }
  }

  SessionFence _fence(Object? data, SessionFence? bound) {
    final fence = BrokerCodec.fence(data);
    if (bound != null && bound != fence) {
      throw const AppFailure(
        code: 'session_revoked',
        message: 'Сессия завершена',
      );
    }
    return fence;
  }

  Map<String, Object?> _ok(Object? value) => {
    'v': 1,
    'ok': true,
    'value': value,
  };
  Map<String, Object?> _error(AppFailure error) => {
    'v': 1,
    'ok': false,
    'error': {
      'code': error.code,
      'retryable': error.retryable,
      'statusCode': error.statusCode,
      'retryAfterMillis':
          (error.statusCode == 429 || error.statusCode == 503) &&
              error.retryAfter != null &&
              error.retryAfter!.inMilliseconds >= 0 &&
              error.retryAfter!.inMilliseconds <= 999999999999000
          ? error.retryAfter!.inMilliseconds
          : null,
    },
  };
  Future<void> close() async {
    await _subscription.cancel();
    await _events.close();
  }
}
