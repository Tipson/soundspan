import 'dart:io';

import 'package:flutter/material.dart';

import 'app/app_composition.dart';
import 'app/app_environment.dart';
import 'app/launcher_shortcut.dart';
import 'app/native_app_resources.dart';
import 'app/native_documents.dart';
import 'app/owner_feature_scope.dart';
import 'app/owner_services.dart';
import 'app/owner_avatar_uploader.dart';
import 'app/owner_shell.dart';
import 'app/owner_ui_session.dart';
import 'app/soundspan_app.dart';
import 'core/network/network_policy.dart';
import 'core/session/session_broker_entrypoint.dart';
import 'design_system/design_system.dart';
import 'downloads/download_worker_entrypoint.dart';
import 'features/account/registration_screen.dart';

@pragma('vm:entry-point')
void downloadWorkerMain() {
  runDownloadWorker();
}

@pragma('vm:entry-point')
void sessionBrokerMain() {
  runSessionBroker();
}

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const MainApp());
}

// Lazy, process-owned future: rebuilding or hiding the root never initializes a
// second broker UI role, audio handler or owner graph. Startup failure is final
// for this process; a UI retry cannot initialize AudioService twice.
final _process = _openProcess();
final _launcherShortcuts = Platform.isAndroid
    ? LauncherShortcut.androidEvents()
    : null;
Future<({NativeAppResources resources, AppComposition composition})>
_openProcess() async {
  final resources = await NativeAppResources.open(
    defaultOrigin: Uri.parse('https://music.agentik007.ru'),
  );
  final native = resources.environment;
  final composition = await AppComposition.create(
    AppEnvironment(
      authority: native.authority,
      auth: native.auth,
      origin: native.origin,
      createPlayback: native.createPlayback,
      processReady: native.processReady,
      release: native.release,
      createOwner: (fence, playback) async {
        final owner =
            await native.createOwner(fence, playback) as NativeOwnerServices;
        try {
          final avatar = OwnerAvatarUploader(
            authority: owner.authority,
            fence: fence,
            networkPolicy: owner.policy,
          );
          try {
            final session = await OwnerUiSession.create(
              owner: owner,
              logout: resources.auth.logout,
              avatarUploader: avatar,
            );
            session.lifetime.add(avatar.close);
            return OwnerFeatureScope(
              native: owner,
              session: session,
              closeFeatures: session.close,
            );
          } catch (_) {
            await avatar.close();
            rethrow;
          }
        } catch (_) {
          await owner.close();
          rethrow;
        }
      },
    ),
  );
  return (resources: resources, composition: composition);
}

class MainApp extends StatelessWidget {
  const MainApp({super.key});

  @override
  Widget build(BuildContext context) {
    return FutureBuilder(
      future: _process,
      builder: (context, snapshot) {
        final process = snapshot.data;
        if (process == null) {
          return MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: SoundspanTheme.dark(),
            home: Scaffold(
              body: SafeArea(
                child: Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: snapshot.hasError
                        ? const MusicEmptyState(
                            title: 'Не удалось открыть музыку',
                            message: 'Перезапустите приложение. Ваши сохранённые данные остаются на устройстве.',
                            icon: Icons.music_off_outlined,
                          )
                        : const MusicLoadingState(
                            label: 'Открываем вашу музыку',
                            rows: 0,
                          ),
                  ),
                ),
              ),
            ),
          );
        }
        return SoundspanApp(
          composition: process.composition,
          onOriginSelected: process.resources.rememberOrigin,
          launcherShortcuts: _launcherShortcuts,
          onLauncherShortcut: (owner, shortcut) =>
              (owner as OwnerFeatureScope<OwnerUiSession>).session
                  .launchShortcut(shortcut),
          registrationBuilder: (_, origin, onRegistered) => RegistrationScreen(
            transport: process.resources.transport,
            authority: process.resources.authority,
            networkPolicy: const NetworkPolicy.online(),
            origin: origin,
            onRegistered: onRegistered,
          ),
          ownerBuilder: (_, owner, exposure) {
            final session =
                (owner as OwnerFeatureScope<OwnerUiSession>).session;
            return OwnerShell(
              key: ValueKey(owner.fence),
              session: session,
              rootExposure: exposure,
              pickAvatar: () => NativeDocuments().pickAvatar(
                isCurrent: () => session.isCurrent,
              ),
            );
          },
        );
      },
    );
  }
}
