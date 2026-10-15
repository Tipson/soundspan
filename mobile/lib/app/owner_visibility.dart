import 'package:flutter/foundation.dart';

import 'app_destinations.dart';
import 'app_router.dart';

/// Retained tabs are exposed only at their root and below no root overlay.
final class OwnerVisibility {
  OwnerVisibility({required this.router, required this.root}) {
    router.addListener(_update);
    root.addListener(_update);
    _update();
  }
  final AppRouter router;
  final ValueListenable<bool> root;
  final home = ValueNotifier(false), downloads = ValueNotifier(false);
  void _update() {
    home.value =
        root.value &&
        router.currentTab == AppTab.home &&
        router.stackDepth(AppTab.home) == 1;
    downloads.value =
        root.value &&
        router.currentTab == AppTab.downloads &&
        router.stackDepth(AppTab.downloads) == 1;
  }

  void dispose() {
    router.removeListener(_update);
    root.removeListener(_update);
    home.dispose();
    downloads.dispose();
  }
}
