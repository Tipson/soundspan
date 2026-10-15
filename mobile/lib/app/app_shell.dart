import 'package:flutter/material.dart';

import '../design_system/design_system.dart';
import 'app_destinations.dart';
import 'app_router.dart';

/// Five retained feature stacks and an injected, stable mini-player subtree.
/// Footer is laid out before content, so its actual intrinsic height and safe
/// inset reduce content constraints without a guessed overlay padding.
class AppShell extends StatefulWidget {
  const AppShell({
    super.key,
    required this.router,
    required this.destinations,
    required this.routeBuilder,
    this.capabilities = const AppCapabilities(),
    this.miniPlayer,
  });
  final AppRouter router;
  final Map<AppTab, WidgetBuilder> destinations;
  final AppDestinationBuilder routeBuilder;
  final AppCapabilities capabilities;
  final Widget? miniPlayer;
  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  final _storage = PageStorageBucket();
  late Map<AppTab, NavigatorObserver> _observers;
  @override
  void initState() {
    super.initState();
    _connect();
  }

  void _connect() {
    widget.router.addListener(_changed);
    _observers = {
      for (final tab in AppTab.values) tab: widget.router.observer(tab),
    };
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  void didUpdateWidget(AppShell oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.router != widget.router) {
      oldWidget.router.removeListener(_changed);
      oldWidget.router.detach();
      _connect();
    }
  }

  @override
  void dispose() {
    widget.router.removeListener(_changed);
    widget.router.detach();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    widget.router.attach(
      context,
      widget.routeBuilder,
      widget.capabilities,
      availableTabs: widget.destinations.keys.toSet(),
    );
    final tabs = AppTab.values
        .where(
          (tab) =>
              widget.capabilities.allowsTab(tab) &&
              widget.destinations.containsKey(tab),
        )
        .toList();
    if (!tabs.contains(AppTab.home)) {
      throw ArgumentError('Главная — обязательная точка возврата AppShell');
    }
    final selected = tabs.indexOf(widget.router.currentTab);
    final keyboard = MediaQuery.viewInsetsOf(context).bottom > 0;
    return PopScope(
      canPop: widget.router.canExit && !keyboard,
      onPopInvokedWithResult: (didPop, result) {
        if (!didPop) widget.router.back();
      },
      child: Scaffold(
        resizeToAvoidBottomInset: true,
        body: SafeArea(
          bottom: false,
          child: LayoutBuilder(
            builder: (context, constraints) {
              final rail = constraints.maxWidth >= 600;
              final largeText =
                  MediaQuery.textScalerOf(context).scale(16) > 20.8;
              final content = PageStorage(
                bucket: _storage,
                child: IndexedStack(
                  index: selected < 0 ? 0 : selected,
                  children: [
                    for (final tab in tabs)
                      TickerMode(
                        enabled: tab == widget.router.currentTab,
                        child: Navigator(
                          key: widget.router.navigatorKey(tab),
                          observers: [_observers[tab]!],
                          onGenerateInitialRoutes: (navigator, initialRoute) =>
                              [
                                MaterialPageRoute<void>(
                                  settings: RouteSettings(name: tab.name),
                                  builder: widget.destinations[tab]!,
                                ),
                                if (tab == widget.router.currentTab &&
                                    widget.router.initialDestination != null &&
                                    widget.router.initialDestination!.kind !=
                                        AppRouteKind.player &&
                                    widget.capabilities.allows(
                                      widget.router.initialDestination!,
                                    ))
                                  widget.router.route<void>(
                                    widget.router.initialDestination!,
                                  ),
                              ],
                          onGenerateRoute: (_) => null,
                        ),
                      ),
                  ],
                ),
              );
              final body = Expanded(
                child: Column(
                  children: [
                    Expanded(child: content),
                    Offstage(
                      offstage:
                          keyboard ||
                          widget.router.playerVisible ||
                          widget.miniPlayer == null,
                      child: Padding(
                        padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
                        child: widget.miniPlayer,
                      ),
                    ),
                    if (!keyboard)
                      SafeArea(
                        top: false,
                        left: false,
                        right: false,
                        child: rail
                            ? const SizedBox.shrink()
                            : largeText
                            ? _sectionsButton(context)
                            : _bottomNavigation(tabs),
                      ),
                  ],
                ),
              );
              return Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (rail && !keyboard)
                    SizedBox(
                      width: 88,
                      child: NavigationRail(
                        selectedIndex: selected < 0 ? 0 : selected,
                        minWidth: 88,
                        labelType: NavigationRailLabelType.none,
                        groupAlignment: -0.5,
                        onDestinationSelected: (index) =>
                            widget.router.selectTab(tabs[index]),
                        destinations: [
                          for (final tab in tabs)
                            NavigationRailDestination(
                              icon: Tooltip(
                                message: tab.label,
                                child: Icon(tab.icon),
                              ),
                              selectedIcon: Tooltip(
                                message: tab.label,
                                child: Icon(tab.selectedIcon),
                              ),
                              label: Text(tab.label),
                            ),
                        ],
                      ),
                    ),
                  body,
                ],
              );
            },
          ),
        ),
      ),
    );
  }

  Widget _sectionsButton(BuildContext context) => SizedBox(
    width: double.infinity,
    child: TextButton(
      onPressed: () => MusicActionSheet.show(
        context,
        [
          for (final tab in AppTab.values.where(
            (tab) =>
                widget.capabilities.allowsTab(tab) &&
                widget.destinations.containsKey(tab),
          ))
            MusicAction(
              id: tab.name,
              label: tab.label,
              icon: tab.icon,
              selected: tab == widget.router.currentTab,
              onSelected: () => widget.router.selectTab(tab),
            ),
        ],
        title: 'Разделы',
        fullHeight: true,
      ),
      style: TextButton.styleFrom(
        minimumSize: const Size(48, 64),
        alignment: Alignment.centerLeft,
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
      ),
      child: Row(
        children: [
          const Icon(Icons.menu_rounded),
          const SizedBox(width: 12),
          Expanded(child: Text('Разделы: ${widget.router.currentTab.label}')),
        ],
      ),
    ),
  );

  Widget _bottomNavigation(List<AppTab> tabs) => Material(
    color: MusicColors.canvas,
    child: ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 72),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final tab in tabs)
            Expanded(
              child: Semantics(
                selected: tab == widget.router.currentTab,
                button: true,
                label: tab.label,
                excludeSemantics: true,
                child: MusicTapTarget(
                  onTap: () => widget.router.selectTab(tab),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      vertical: 10,
                      horizontal: 4,
                    ),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Container(
                          width: 48,
                          height: 28,
                          decoration: BoxDecoration(
                            color: tab == widget.router.currentTab
                                ? MusicColors.primaryContainer
                                : Colors.transparent,
                            borderRadius: BorderRadius.circular(16),
                          ),
                          child: Icon(
                            tab == widget.router.currentTab
                                ? tab.selectedIcon
                                : tab.icon,
                            size: 24,
                            color: tab == widget.router.currentTab
                                ? MusicColors.primary
                                : MusicColors.textSecondary,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          tab.label,
                          textAlign: TextAlign.center,
                          style: Theme.of(context).textTheme.labelSmall
                              ?.copyWith(
                                color: tab == widget.router.currentTab
                                    ? MusicColors.primary
                                    : MusicColors.textSecondary,
                              ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    ),
  );
}
