import 'package:flutter/widgets.dart';

import '../core/model/owner_key.dart';
import 'artwork_loader.dart';

/// Immutable owner generation plus loader notifications; revocation rebuilds all
/// dependents immediately, even when a pending file read has not completed.
class ArtworkScope extends InheritedNotifier<ArtworkLoader> {
  ArtworkScope({super.key, required ArtworkLoader loader, required super.child})
    : fence = loader.fence,
      super(notifier: loader);
  final SessionFence fence;
  ArtworkLoader get loader => notifier!;
  static ArtworkScope? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<ArtworkScope>();
  @override
  bool updateShouldNotify(ArtworkScope oldWidget) =>
      fence != oldWidget.fence || super.updateShouldNotify(oldWidget);
}
