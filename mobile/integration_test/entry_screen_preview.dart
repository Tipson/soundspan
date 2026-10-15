// Native UI preview scenario reads public auth config; no credentials supplied.
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:soundspan/app/entry_controller.dart';
import 'package:soundspan/app/entry_screen.dart';
import 'package:soundspan/core/session/broker_client.dart';
import 'package:soundspan/core/session/native_auth_repository_proxy.dart';
import 'package:soundspan/core/session/native_session_authority_proxy.dart';
import 'package:soundspan/core/session/session_broker_entrypoint.dart';
import 'package:soundspan/core/session/session_broker_protocol.dart';
import 'package:soundspan/design_system/theme.dart';
import 'package:soundspan/downloads/download_worker_entrypoint.dart';

@pragma('vm:entry-point')
Future<void> sessionBrokerMain() => runSessionBroker();
@pragma('vm:entry-point')
Future<void> downloadWorkerMain() => runDownloadWorker();

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final client = BrokerClient(MethodChannelBrokerTransport());
  await NativeSessionAuthorityProxy.attach(client, ClientRole.ui);
  final entry = EntryController(
    auth: NativeAuthRepositoryProxy(client),
    origin: Uri.parse('https://music.agentik007.ru'),
  );
  runApp(
    MaterialApp(
      title: 'Soundspan',
      debugShowCheckedModeBanner: false,
      theme: SoundspanTheme.dark(),
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      supportedLocales: const [Locale('ru'), Locale('en')],
      locale: const Locale('ru'),
      home: EntryScreen(controller: entry),
    ),
  );
}
