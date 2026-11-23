import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/session/auth_models.dart';
import 'package:soundspan/core/session/auth_repository.dart';
import 'package:soundspan/core/session/broker_client.dart';
import 'package:soundspan/core/session/local_session_authority.dart';
import 'package:soundspan/core/session/native_auth_repository_proxy.dart';
import 'package:soundspan/core/session/native_session_authority_proxy.dart';
import 'package:soundspan/core/session/secure_storage_credential_vault.dart';
import 'package:soundspan/core/session/session_broker_entrypoint.dart';
import 'package:soundspan/core/session/session_broker_protocol.dart';
import 'package:soundspan/core/session/session_broker_rpc_server.dart';
import 'package:soundspan/core/storage/sqlite_session_store.dart';

final _origin = Uri.parse('https://broker-fixture.invalid');
final _otherOrigin = Uri.parse('https://broker-fixture-b.invalid');

/// Test target replaces only the broker entrypoint; native host/plugin are real.
/// No real account, HTTP server or network traffic is involved in this fixture.
@pragma('vm:entry-point')
Future<void> sessionBrokerMain() async {
  WidgetsFlutterBinding.ensureInitialized();
  final store = await SqliteSessionStore.open();
  final client = _FixtureAuthClient();
  final authority = LocalSessionAuthority(
    vault: SecureStorageCredentialVault(),
    fenceStore: store,
    refreshTokens: (origin, token) =>
        LocalAuthRepository.refresh(client, origin, token),
  );
  await serveSessionBroker(
    SessionBrokerRpcServer(
      authority: authority,
      restoreCapturedFence: authority.restoreCapturedFence,
      auth: LocalAuthRepository(authority: authority, client: client),
    ),
  );
}

final class _FixtureAuthClient implements JsonHttpClient {
  int refreshes = 0;
  @override
  Future<ApiResponse> send(ApiRequest request, {String? accessToken}) async {
    if (request.origin != _origin && request.origin != _otherOrigin) {
      throw StateError('Fixture origins only');
    }
    return switch (request.path) {
      '/api/auth/config' => const ApiResponse(200, {
        'localLoginEnabled': true,
        'oidcEnabled': false,
        'oidcProviderName': '',
      }),
      '/api/auth/login' => const ApiResponse(200, {
        'token': 'fixture-access',
        'refreshToken': 'fixture-refresh',
        'user': {'id': 'fixture-user'},
      }),
      '/api/auth/refresh' => ApiResponse(200, {
        'token': 'fixture-access-${++refreshes}',
        'refreshToken': 'fixture-refresh-$refreshes',
      }),
      _ => throw StateError('Unexpected fixture route'),
    };
  }
}

@pragma('vm:entry-point')
Future<void> sessionProbeMain() async {
  WidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('soundspan/session_probe');
  NativeSessionAuthorityProxy? proxy;
  SqliteSessionStore? store;
  channel.setMethodCallHandler((call) async {
    switch (call.method) {
      case 'attach':
        final fence = BrokerCodec.fence(call.arguments);
        final client = BrokerClient(MethodChannelBrokerTransport());
        try {
          proxy = await NativeSessionAuthorityProxy.attach(
            client,
            ClientRole.download,
            expectedFence: fence,
          );
        } catch (_) {
          await client.close();
          rethrow;
        }
        store = await SqliteSessionStore.open();
        return BrokerCodec.encodeFence(proxy!.requireFence());
      case 'refresh':
        return BrokerCodec.encodeStamp(
          await proxy!.after401(BrokerCodec.stamp(call.arguments)),
        );
      case 'write':
        final fence = BrokerCodec.fence(call.arguments);
        try {
          await store!.guardedTransaction(fence, (tx) async {
            await tx.execute(
              'CREATE TABLE IF NOT EXISTS broker_probe (id INTEGER PRIMARY KEY, value TEXT)',
            );
            await tx.insert('broker_probe', {'value': 'accepted'});
          });
          return true;
        } catch (_) {
          return false;
        }
      case 'admit':
        try {
          await proxy!.assertCurrent(BrokerCodec.fence(call.arguments));
          return true;
        } catch (_) {
          return false;
        }
      case 'close':
        await proxy?.close();
        await store?.close();
        return null;
      default:
        throw MissingPluginException();
    }
  });
  await channel.invokeMethod<void>('ready');
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'two real client engines share one broker and SQLite rejects old epoch',
    (tester) async {
      const harness = MethodChannel('soundspan/session_probe_harness');
      final ui = await NativeSessionAuthorityProxy.attach(
        BrokerClient(MethodChannelBrokerTransport()),
        ClientRole.ui,
      );
      final auth = NativeAuthRepositoryProxy(ui.client);
      await auth.login(
        LoginInput(origin: _origin, username: 'fixture', password: 'fixture'),
      );
      final original = ui.requireFence();
      final stamp = (await ui.grantAccess(original, _origin)).authStamp;
      await harness.invokeMethod<void>('start');
      final probeFence = await harness.invokeMethod<Object?>('command', {
        'method': 'attach',
        'args': BrokerCodec.encodeFence(original),
      });
      expect(BrokerCodec.fence(probeFence), original);
      final stats = await harness.invokeMapMethod<String, int>('stats');
      expect(stats!['clients'], 2);
      expect(stats['brokerStarts'], 1);
      final results = await Future.wait([
        ui.after401(stamp).then((s) => s.tokenRevision),
        harness
            .invokeMethod<Object?>('command', {
              'method': 'refresh',
              'args': BrokerCodec.encodeStamp(stamp),
            })
            .then((s) => BrokerCodec.stamp(s).tokenRevision),
      ]);
      expect(results, [2, 2]);
      expect(
        (await ui.grantAccess(original, _origin)).accessToken,
        'fixture-access-1',
      );
      Future<bool?> write(SessionFence fence) => harness.invokeMethod<bool>(
        'command',
        {'method': 'write', 'args': BrokerCodec.encodeFence(fence)},
      );
      expect(await write(original), isTrue);
      await auth.logout();
      expect(await write(original), isFalse);
      await auth.login(
        LoginInput(origin: _origin, username: 'fixture', password: 'fixture'),
      );
      expect(ui.requireFence().epoch, greaterThan(original.epoch));
      expect(await write(original), isFalse);
      expect(
        await harness.invokeMethod<bool>('command', {
          'method': 'admit',
          'args': BrokerCodec.encodeFence(ui.requireFence()),
        }),
        isFalse,
      );
      await harness.invokeMethod<void>('stop');
      await auth.login(
        LoginInput(
          origin: _otherOrigin,
          username: 'fixture-b',
          password: 'fixture',
        ),
      );
      final capturedB = ui.requireFence();
      await ui.close();
      final restored = await NativeSessionAuthorityProxy.attach(
        BrokerClient(MethodChannelBrokerTransport()),
        ClientRole.ui,
      );
      final restoredAuth = NativeAuthRepositoryProxy(restored.client);
      // Stale A is the first worker to reach a fresh broker while B is durable.
      // It must not revoke B, and rejection must not poison B's following attach.
      await harness.invokeMethod<void>('start');
      await expectLater(
        harness.invokeMethod<Object?>('command', {
          'method': 'attach',
          'args': BrokerCodec.encodeFence(original),
        }),
        throwsA(isA<PlatformException>()),
      );
      expect(restored.state.fence, isNull);
      final recoveredB = await harness.invokeMethod<Object?>('command', {
        'method': 'attach',
        'args': BrokerCodec.encodeFence(capturedB),
      });
      expect(BrokerCodec.fence(recoveredB), capturedB);
      final restoredState = await restoredAuth.restore(_otherOrigin);
      expect(restoredState.fence, capturedB);
      expect(restoredState.fence?.epoch, greaterThan(original.epoch));
      expect(
        (await restored.grantAccess(
          restored.requireFence(),
          _otherOrigin,
        )).accessToken,
        'fixture-access',
      );
      final restartedStats = await harness.invokeMapMethod<String, int>(
        'stats',
      );
      expect(restartedStats!['brokerStarts'], 2);
      await harness.invokeMethod<void>('stop');
      await restoredAuth.logout();
      await restored.close();
    },
  );
}
