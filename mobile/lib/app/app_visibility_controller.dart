import 'package:flutter/foundation.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';

/// Root route exposure, combined by the owner UI with tab/detail visibility.
/// A nested ModalRoute alone cannot observe a root-level player or dialog.
class AppVisibilityController extends NavigatorObserver
    with ChangeNotifier, WidgetsBindingObserver
    implements ValueListenable<bool> {
  AppVisibilityController() {
    _foreground =
        (WidgetsBinding.instance.lifecycleState ?? AppLifecycleState.resumed) ==
        AppLifecycleState.resumed;
    WidgetsBinding.instance.addObserver(this);
  }
  Route<dynamic>? _base, _top;
  bool _foreground = true, _disposed = false, _scheduled = false;
  @override
  bool get value => !_disposed && _foreground && _base != null && _base == _top;
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    _changed();
  }

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) {
    if (previousRoute == null) _base = route;
    _top = route;
    _changed();
  }

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) {
    _top = previousRoute;
    _changed();
  }

  @override
  void didRemove(Route<dynamic> route, Route<dynamic>? previousRoute) {
    if (_top == route) _top = previousRoute;
    if (_base == route) _base = null;
    _changed();
  }

  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) {
    if (_top == oldRoute) _top = newRoute;
    if (_base == oldRoute) _base = newRoute;
    _changed();
  }

  void _changed() {
    if (_disposed) return;
    if (SchedulerBinding.instance.schedulerPhase ==
        SchedulerPhase.persistentCallbacks) {
      if (_scheduled) return;
      _scheduled = true;
      SchedulerBinding.instance.addPostFrameCallback((_) {
        _scheduled = false;
        if (!_disposed) notifyListeners();
      });
    } else {
      notifyListeners();
    }
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }
}
