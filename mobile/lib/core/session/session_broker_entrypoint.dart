import 'package:flutter/widgets.dart';
import 'package:flutter/services.dart';

import '../network/dart_api_transport.dart';
import '../storage/sqlite_session_store.dart';
import 'auth_repository.dart';
import 'local_session_authority.dart';
import 'secure_storage_credential_vault.dart';
import 'session_broker_rpc_server.dart';
import 'session_broker_protocol.dart';

/// No runApp, audio service, player or worker is constructed in this isolate.
Future<void> runSessionBroker() async {
  WidgetsFlutterBinding.ensureInitialized();
  final store = await SqliteSessionStore.open();
  final client = DartJsonHttpClient();
  final authority = LocalSessionAuthority(
    vault: SecureStorageCredentialVault(),
    fenceStore: store,
    refreshTokens: (origin, token) =>
        LocalAuthRepository.refresh(client, origin, token),
  );
  final server = SessionBrokerRpcServer(
    authority: authority,
    restoreCapturedFence: authority.restoreCapturedFence,
    auth: LocalAuthRepository(authority: authority, client: client),
  );
  await serveSessionBroker(server);
}

/// Binds the authoritative server to the host after its dependencies are ready.
Future<void> serveSessionBroker(SessionBrokerRpcServer server) async {
  const channel = MethodChannel('soundspan/session_broker');
  server.events.listen((event) {
    channel.invokeMethod<void>('event', event);
  });
  channel.setMethodCallHandler((call) async {
    if (call.method == 'dispatch') {
      final args = BrokerCodec.object(call.arguments, {'clientId', 'request'});
      return server.dispatch(
        BrokerCodec.text(args['clientId']),
        args['request'],
      );
    }
    if (call.method == 'detach') {
      server.detach(BrokerCodec.text(call.arguments));
      return null;
    }
    throw MissingPluginException();
  });
  await channel.invokeMethod<void>('ready', {'v': 1});
}
