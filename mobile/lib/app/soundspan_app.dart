import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import '../core/model/owner_key.dart';
import '../design_system/design_system.dart';
import 'app_composition.dart';
import 'app_environment.dart';
import 'app_visibility_controller.dart';
import 'entry_controller.dart';
import 'entry_screen.dart';
import 'launcher_shortcut.dart';

typedef OwnerUiBuilder = Widget Function(
  BuildContext,
  AppOwnerScope,
  ValueListenable<bool>,
);
typedef RegistrationPageBuilder = Widget Function(
  BuildContext,
  Uri,
  VoidCallback,
);

/// UI lifetime only. The native process graph remains owned by main/resources.
class SoundspanApp extends StatefulWidget {
  const SoundspanApp({
    super.key,
    required this.composition,
    required this.ownerBuilder,
    this.registrationBuilder,
    this.onOriginSelected,
    this.launcherShortcuts,
    this.onLauncherShortcut,
  });
  final AppComposition composition;
  final OwnerUiBuilder ownerBuilder;
  final RegistrationPageBuilder? registrationBuilder;
  final FutureOr<void> Function(Uri)? onOriginSelected;
  final Stream<LauncherShortcut>? launcherShortcuts;
  final Future<void> Function(AppOwnerScope, LauncherShortcut)?
  onLauncherShortcut;
  @override
  State<SoundspanApp> createState() => _SoundspanAppState();
}

class _SoundspanAppState extends State<SoundspanApp> {
  EntryController? _entry;
  Uri? _rememberedOrigin;
  (AppComposition, SessionFence?)? _navigationId;
  GlobalKey<NavigatorState> _navigator = GlobalKey<NavigatorState>();
  late AppVisibilityController _visibility;
  StreamSubscription<LauncherShortcut>? _shortcutSubscription;
  String? _actionFailure;
  @override
  void initState() {
    super.initState();
    _visibility = AppVisibilityController();
    widget.composition.addListener(_changed);
    _syncEntry();
    _listenForShortcuts();
  }

  @override
  void didUpdateWidget(SoundspanApp oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.composition != widget.composition) {
      oldWidget.composition.removeListener(_changed);
      _clearEntry();
      widget.composition.addListener(_changed);
      _syncEntry();
    }
    if (oldWidget.launcherShortcuts != widget.launcherShortcuts) {
      unawaited(_shortcutSubscription?.cancel());
      _listenForShortcuts();
    }
  }

  void _listenForShortcuts() {
    _shortcutSubscription = widget.launcherShortcuts?.listen(
      (shortcut) => unawaited(_deliverShortcut(shortcut)),
    );
  }

  Future<void> _deliverShortcut(LauncherShortcut shortcut) {
    final graph = widget.composition;
    return deliverLauncherShortcut(
      graph,
      shortcut,
      // Mount the owner's router before navigating, even on a cold launch.
      waitForUi: () => WidgetsBinding.instance.endOfFrame,
      dispatch: (owner, action) async {
        if (mounted && identical(widget.composition, graph)) {
          await widget.onLauncherShortcut?.call(owner, action);
        }
      },
    );
  }

  void _changed() {
    _syncEntry();
    if (mounted) setState(() {});
  }

  void _clearEntry() {
    _entry?.removeListener(_entryChanged);
    _entry?.dispose();
    _entry = null;
  }

  void _syncEntry() {
    if (widget.composition.phase == AppPhase.signedOut) {
      if (_entry == null) {
        _entry = EntryController(
          auth: widget.composition.environment.auth,
          origin: widget.composition.origin,
        );
        _rememberedOrigin = _entry!.state.origin;
        _entry!.addListener(_entryChanged);
      }
    } else {
      _clearEntry();
    }
  }

  void _entryChanged() {
    final entry = _entry;
    if (entry == null || entry.state.origin == _rememberedOrigin) return;
    _rememberedOrigin = entry.state.origin;
    final callback = widget.onOriginSelected;
    if (callback != null) {
      unawaited(
        Future<void>.sync(() => callback(entry.state.origin))
            .catchError((Object _) {
              if (mounted && identical(_entry, entry)) {
                setState(
                  () => _actionFailure =
                      'Не удалось сохранить адрес сервера на устройстве.',
                );
              }
            }),
      );
    }
  }

  Future<void> _registration() async {
    final entry = _entry, builder = widget.registrationBuilder;
    final navigator = _navigator.currentState;
    if (entry == null || builder == null || navigator == null) return;
    final origin = entry.state.origin;
    late final MaterialPageRoute<void> route;
    route = MaterialPageRoute<void>(
      builder: (context) => builder(context, origin, () {
        if (!mounted ||
            !identical(_entry, entry) ||
            entry.state.origin != origin ||
            !route.isCurrent ||
            widget.composition.environment.authority.state.fence != null) {
          return;
        }
        navigator.pop();
        unawaited(entry.loadConfig());
      }),
    );
    await navigator.push(route);
  }

  Future<void> _logout() async {
    final graph = widget.composition;
    try {
      await graph.logout();
    } catch (_) {
      if (mounted && identical(widget.composition, graph)) {
        setState(
          () => _actionFailure =
              'Не удалось завершить сеанс. Перезапустите приложение.',
        );
      }
    }
  }

  Widget _body(BuildContext context) {
    final graph = widget.composition, owner = graph.owner;
    if (owner != null) return widget.ownerBuilder(context, owner, _visibility);
    if (graph.phase == AppPhase.signedOut && _entry != null) {
      return EntryScreen(
        controller: _entry!,
        onRegistration: widget.registrationBuilder == null
            ? null
            : () => unawaited(_registration()),
      );
    }
    if (graph.phase == AppPhase.failed || graph.phase == AppPhase.closed) {
      return Scaffold(
        body: SafeArea(
          child: SingleChildScrollView(
            child: Column(
              children: [
                MusicEmptyState(
                  title: 'Не удалось открыть музыку',
                  message:
                      graph.failure?.message ?? 'Перезапустите приложение.',
                  icon: Icons.music_off_outlined,
                  actionLabel: graph.environment.authority.state.fence == null
                      ? null
                      : 'Выйти из аккаунта',
                  onAction: graph.environment.authority.state.fence == null
                      ? null
                      : () => unawaited(_logout()),
                ),
                if (_actionFailure != null)
                  Padding(
                    padding: const EdgeInsets.all(24),
                    child: MusicStatus(message: _actionFailure!, error: true),
                  ),
              ],
            ),
          ),
        ),
      );
    }
    return const Scaffold(
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: EdgeInsets.all(24),
            child: MusicLoadingState(label: 'Открываем вашу музыку', rows: 0),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final id = (
      widget.composition,
      widget.composition.environment.authority.state.fence,
    );
    if (_navigationId != id) {
      if (_navigationId != null) {
        _visibility.dispose();
        _visibility = AppVisibilityController();
        _navigator = GlobalKey<NavigatorState>();
      }
      _navigationId = id;
    }
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: const SystemUiOverlayStyle(
        statusBarColor: Colors.transparent,
        statusBarIconBrightness: Brightness.light,
        systemNavigationBarColor: MusicColors.canvas,
        systemNavigationBarIconBrightness: Brightness.light,
      ),
      child: MaterialApp(
        key: ValueKey(id),
        navigatorKey: _navigator,
        navigatorObservers: [_visibility],
        title: 'Soundspan',
        debugShowCheckedModeBanner: false,
        theme: SoundspanTheme.dark(),
        locale: const Locale('ru'),
        localizationsDelegates: GlobalMaterialLocalizations.delegates,
        supportedLocales: const [Locale('ru'), Locale('en')],
        home: Builder(builder: _body),
      ),
    );
  }

  @override
  void dispose() {
    unawaited(_shortcutSubscription?.cancel());
    widget.composition.removeListener(_changed);
    _clearEntry();
    _visibility.dispose();
    // Removing/rebuilding UI does not dispose the native audio/download graph.
    super.dispose();
  }
}
