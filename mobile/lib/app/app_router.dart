import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import '../design_system/tokens.dart';
import 'app_destinations.dart';

/// Navigation only. Owned outside the shell; never constructs a media service.
class AppRouter extends ChangeNotifier {
  AppRouter({
    AppTab initialTab = AppTab.home,
    this.initialDestination,
    this.onScrollToTop,
    this.onUnavailable,
  }) : _currentTab = initialTab;
  final AppDestination? initialDestination;
  final ValueChanged<AppTab>? onScrollToTop;
  final ValueChanged<AppDestination>? onUnavailable;
  final Map<AppTab, GlobalKey<NavigatorState>> _keys = {
    for (final tab in AppTab.values)
      tab: GlobalKey<NavigatorState>(debugLabel: tab.name),
  };
  final Map<AppTab, int> _depth = {for (final tab in AppTab.values) tab: 1};
  final List<AppRouteKind> _overlays = [];
  AppTab _currentTab;
  BuildContext? _context;
  AppDestinationBuilder? _builder;
  AppCapabilities _capabilities = const AppCapabilities();
  bool _disposed = false;
  bool _notificationScheduled = false;
  bool _initialChecked = false;
  Set<AppTab> _availableTabs = AppTab.values.toSet();
  AppTab get currentTab => _currentTab;
  bool get playerVisible => _overlays.contains(AppRouteKind.player);
  bool get canExit =>
      _currentTab == AppTab.home &&
      (_depth[_currentTab] ?? 1) <= 1 &&
      _overlays.isEmpty;
  GlobalKey<NavigatorState> navigatorKey(AppTab tab) => _keys[tab]!;
  int stackDepth(AppTab tab) => _depth[tab]!;

  /// Shell lifecycle seam; feature code uses selectTab/push/openOverlay/back.
  void attach(
    BuildContext context,
    AppDestinationBuilder builder,
    AppCapabilities capabilities, {
    Set<AppTab>? availableTabs,
  }) {
    _context = context;
    _builder = builder;
    _capabilities = capabilities;
    _availableTabs = availableTabs ?? AppTab.values.toSet();
    if (!_capabilities.allowsTab(_currentTab) ||
        !_availableTabs.contains(_currentTab)) {
      _currentTab = AppTab.home;
    }
    if (!_initialChecked) {
      _initialChecked = true;
      final initial = initialDestination;
      if (initial != null && !_capabilities.allows(initial)) {
        SchedulerBinding.instance.addPostFrameCallback((_) {
          if (!_disposed) _reportUnavailable(initial);
        });
      } else if (initial?.kind == AppRouteKind.player) {
        SchedulerBinding.instance.addPostFrameCallback((_) {
          if (!_disposed && _context != null) {
            unawaited(openOverlay<void>(initial!));
          }
        });
      }
    }
  }

  void detach() {
    _context = null;
    _builder = null;
  }

  void selectTab(AppTab tab) {
    if (!_capabilities.allowsTab(tab) || !_availableTabs.contains(tab)) return;
    if (_currentTab == tab) {
      if ((_depth[tab] ?? 1) > 1) {
        _keys[tab]!.currentState?.popUntil((route) => route.isFirst);
      } else {
        onScrollToTop?.call(tab);
      }
    } else {
      _currentTab = tab;
      _notify();
    }
  }

  /// Reveal a tab's main screen when invoked from the OS launcher.
  void selectRootTab(AppTab tab) {
    if (!_capabilities.allowsTab(tab) || !_availableTabs.contains(tab)) return;
    if (_context case final context?) {
      Navigator.of(
        context,
        rootNavigator: true,
      ).popUntil((route) => route.isFirst);
    }
    if (_currentTab != tab) {
      _keys[tab]!.currentState?.popUntil((route) => route.isFirst);
    }
    selectTab(tab);
  }

  Future<T?> push<T>(AppDestination destination) {
    if (!_allowed(destination)) return Future.value();
    if (destination.kind == AppRouteKind.player) {
      return openOverlay<T>(destination);
    }
    final navigator = _keys[_currentTab]!.currentState;
    if (navigator == null) {
      throw StateError('AppShell должен быть смонтирован до навигации');
    }
    return navigator.push<T>(route<T>(destination));
  }

  /// Full player/queue/import/account can cover the active independent stack.
  Future<T?> openOverlay<T>(AppDestination destination) async {
    if (!_allowed(destination)) return null;
    final context = _context;
    if (context == null) {
      throw StateError('AppShell должен быть смонтирован до навигации');
    }
    if (destination.kind == AppRouteKind.player && playerVisible) return null;
    _overlays.add(destination.kind);
    _notify();
    try {
      return await Navigator.of(context, rootNavigator: true).push<T>(
        route<T>(
          destination,
          fullscreenDialog: destination.kind == AppRouteKind.player,
        ),
      );
    } finally {
      _overlays.remove(destination.kind);
      _notify();
    }
  }

  bool _allowed(AppDestination destination) {
    if (_capabilities.allows(destination)) return true;
    _reportUnavailable(destination);
    return false;
  }

  void _reportUnavailable(AppDestination destination) {
    if (onUnavailable != null) {
      onUnavailable!(destination);
    } else if (_context case final context?) {
      ScaffoldMessenger.maybeOf(
        context,
      )?.showSnackBar(const SnackBar(content: Text('Этот раздел недоступен')));
    }
  }

  /// Returns false only at Home root, allowing the OS to handle Back.
  bool back() {
    final context = _context;
    if (context != null && MediaQuery.viewInsetsOf(context).bottom > 0) {
      FocusManager.instance.primaryFocus?.unfocus();
      return true;
    }
    if (context != null &&
        ModalRoute.of(context)?.isCurrent == false &&
        Navigator.of(context, rootNavigator: true).canPop()) {
      Navigator.of(context, rootNavigator: true).pop();
      return true;
    }
    if ((_depth[_currentTab] ?? 1) > 1) {
      _keys[_currentTab]!.currentState?.pop();
      return true;
    }
    if (_currentTab != AppTab.home) {
      _currentTab = AppTab.home;
      _notify();
      return true;
    }
    return false;
  }

  Route<T> route<T>(
    AppDestination destination, {
    bool fullscreenDialog = false,
  }) {
    final builder = _builder;
    final context = _context;
    if (builder == null || context == null) {
      throw StateError('AppShell не подключён');
    }
    return _MusicRoute<T>(
      builder: (context) => builder(context, destination),
      settings: RouteSettings(
        name: '${destination.kind.name}/${destination.id ?? ''}',
        arguments: destination,
      ),
      fullscreenDialog: fullscreenDialog,
      reducedMotion: MediaQuery.disableAnimationsOf(context),
      player: destination.kind == AppRouteKind.player,
    );
  }

  NavigatorObserver observer(AppTab tab) => _StackObserver((delta) {
    _depth[tab] = (_depth[tab]! + delta).clamp(1, 100000);
    _notify();
  });
  void _notify() {
    if (_disposed) return;
    if (SchedulerBinding.instance.schedulerPhase ==
        SchedulerPhase.persistentCallbacks) {
      if (_notificationScheduled) return;
      _notificationScheduled = true;
      SchedulerBinding.instance.addPostFrameCallback((_) {
        _notificationScheduled = false;
        if (!_disposed) notifyListeners();
      });
    } else {
      notifyListeners();
    }
  }

  @override
  void dispose() {
    _disposed = true;
    detach();
    super.dispose();
  }
}

class _StackObserver extends NavigatorObserver {
  _StackObserver(this.changed);
  final ValueChanged<int> changed;
  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) {
    if (previousRoute != null) changed(1);
  }

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) {
    changed(-1);
  }

  @override
  void didRemove(Route<dynamic> route, Route<dynamic>? previousRoute) {
    changed(-1);
  }
}

class _MusicRoute<T> extends MaterialPageRoute<T> {
  _MusicRoute({
    required super.builder,
    required super.settings,
    super.fullscreenDialog,
    required this.reducedMotion,
    required this.player,
  });
  final bool reducedMotion;
  final bool player;
  @override
  Duration get transitionDuration => reducedMotion
      ? Duration.zero
      : (player ? MusicMotion.player : MusicMotion.navigation);
  @override
  Duration get reverseTransitionDuration => transitionDuration;
}
