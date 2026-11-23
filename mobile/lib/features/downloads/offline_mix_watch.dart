import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'offline_mix_controller.dart';

/// Observe private worker commits only while this surface is exposed.
class OfflineMixWatch extends StatefulWidget {
  const OfflineMixWatch({
    super.key,
    required this.controller,
    required this.builder,
    this.visible,
  });
  final OfflineMixController controller;
  final WidgetBuilder builder;
  final ValueListenable<bool>? visible;
  @override
  State<OfflineMixWatch> createState() => _OfflineMixWatchState();
}

class _OfflineMixWatchState extends State<OfflineMixWatch>
    with WidgetsBindingObserver {
  Timer? _poll;
  bool _foreground = true, _ticker = true;
  @override
  void initState() {
    super.initState();
    final state = WidgetsBinding.instance.lifecycleState;
    _foreground = state == null || state == AppLifecycleState.resumed;
    WidgetsBinding.instance.addObserver(this);
    widget.visible?.addListener(_sync);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _load();
    });
  }

  bool get _exposed =>
      _foreground && _ticker && (widget.visible?.value ?? true);
  void _load() {
    if (_exposed && widget.controller.isCurrent && !widget.controller.busy) {
      unawaited(widget.controller.refresh());
    }
  }

  void _sync() {
    if (_exposed && widget.controller.isCurrent) {
      // Parent download polling may rebuild this widget every second. Keep the
      // running deadline so those rebuilds cannot postpone this observer forever.
      _poll ??= Timer.periodic(const Duration(seconds: 2), (_) => _load());
    } else {
      _poll?.cancel();
      _poll = null;
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _ticker = TickerMode.valuesOf(context).enabled;
    _sync();
  }

  @override
  void didUpdateWidget(OfflineMixWatch oldWidget) {
    super.didUpdateWidget(oldWidget);
    oldWidget.visible?.removeListener(_sync);
    widget.visible?.addListener(_sync);
    _sync();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    _sync();
    if (_foreground) _load();
  }

  @override
  void dispose() {
    _poll?.cancel();
    widget.visible?.removeListener(_sync);
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) => widget.builder(context),
  );
}
