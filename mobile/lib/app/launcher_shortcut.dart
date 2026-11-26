import 'package:flutter/services.dart';

import 'app_composition.dart';
import 'app_environment.dart';

/// Explicit actions selected from the Android launcher.
enum LauncherShortcut {
  playWave,
  resume,
  downloads;

  static Stream<LauncherShortcut> androidEvents() async* {
    const channel = EventChannel('soundspan/launcher_shortcuts');
    await for (final event in channel.receiveBroadcastStream()) {
      final shortcut = switch (event) {
        'playWave' => LauncherShortcut.playWave,
        'resume' => LauncherShortcut.resume,
        'downloads' => LauncherShortcut.downloads,
        _ => null,
      };
      if (shortcut != null) yield shortcut;
    }
  }
}

/// Delivers an action only to the owner admitted when the launcher invoked it.
Future<void> deliverLauncherShortcut(
  AppComposition composition,
  LauncherShortcut shortcut, {
  required Future<void> Function() waitForUi,
  required Future<void> Function(AppOwnerScope, LauncherShortcut) dispatch,
}) async {
  final owner = composition.owner;
  if (owner == null) return;
  await waitForUi();
  if (identical(composition.owner, owner)) await dispatch(owner, shortcut);
}
