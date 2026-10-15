import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/app/app_destinations.dart';
import 'package:soundspan/app/app_router.dart';
import 'package:soundspan/app/app_shell.dart';
import 'package:soundspan/design_system/design_system.dart';

class PlayerFixture extends StatefulWidget {
  const PlayerFixture({super.key});
  @override
  State<PlayerFixture> createState() => _PlayerFixtureState();
}

class _PlayerFixtureState extends State<PlayerFixture> {
  final identity = Object();
  @override
  Widget build(BuildContext context) =>
      const SizedBox(height: 72, child: Text('Текущая запись'));
}

Future<void> mount(
  WidgetTester tester,
  AppRouter router, {
  double width = 390,
  double scale = 1,
  Widget? player,
  double height = 900,
  double keyboardInset = 0,
  AppCapabilities capabilities = const AppCapabilities(),
}) async {
  tester.view.physicalSize = Size(width, height);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    MaterialApp(
      theme: SoundspanTheme.dark(),
      home: MediaQuery(
        data: MediaQueryData(
          size: Size(width, height),
          textScaler: TextScaler.linear(scale),
          viewInsets: EdgeInsets.only(bottom: keyboardInset),
        ),
        child: AppShell(
          router: router,
          capabilities: capabilities,
          destinations: {
            for (final tab in AppTab.values)
              tab: (context) => ListView(
                key: PageStorageKey(tab),
                children: [
                  Text('Корень ${tab.name}'),
                  for (var i = 0; i < 100; i++) Text('Строка ${tab.name} $i'),
                ],
              ),
          },
          routeBuilder: (context, route) => Scaffold(
            appBar: AppBar(title: Text(route.id ?? route.kind.name)),
            body: const Text('Содержимое записи'),
          ),
          miniPlayer: player,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'initial player deep link is root overlay and hides mini until Back',
    (tester) async {
      final router = AppRouter(
        initialDestination: const AppDestination(AppRouteKind.player),
      );
      addTearDown(router.dispose);
      await mount(tester, router, player: const PlayerFixture());
      expect(router.playerVisible, isTrue);
      expect(router.stackDepth(AppTab.home), 1);
      expect(find.byType(PlayerFixture), findsNothing);
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(router.playerVisible, isFalse);
      expect(find.byType(PlayerFixture), findsOneWidget);
      expect(find.text('Корень home'), findsOneWidget);
    },
  );

  testWidgets('rapid sheet selection cannot pop the underlying detail route', (
    tester,
  ) async {
    final router = AppRouter();
    addTearDown(router.dispose);
    await mount(tester, router);
    router.openOverlay(
      const AppDestination(AppRouteKind.album, id: 'Точный альбом'),
    );
    await tester.pumpAndSettle();
    var calls = 0;
    MusicActionSheet.show(tester.element(find.text('Содержимое записи')), [
      MusicAction(
        id: 'like',
        label: 'Нравится',
        icon: Icons.favorite_border,
        onSelected: () => calls++,
      ),
    ]);
    await tester.pumpAndSettle();
    final target = tester.getCenter(find.text('Нравится'));
    final queuedActivation = tester
        .widget<MusicTapTarget>(
          find.ancestor(
            of: find.text('Нравится'),
            matching: find.byType(MusicTapTarget),
          ),
        )
        .onTap!;
    await tester.tapAt(target);
    queuedActivation();
    await tester.pumpAndSettle();
    expect(calls, 1);
    expect(find.text('Точный альбом'), findsOneWidget);
    expect(router.stackDepth(AppTab.home), 1);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'tab changes preserve injected player state and independent stacks',
    (tester) async {
      final router = AppRouter();
      addTearDown(router.dispose);
      const player = PlayerFixture();
      await mount(tester, router, player: player);
      final identity = tester
          .state<_PlayerFixtureState>(find.byType(PlayerFixture))
          .identity;
      router.push(const AppDestination(AppRouteKind.album, id: 'Альбом'));
      await tester.pumpAndSettle();
      router.selectTab(AppTab.search);
      await tester.pumpAndSettle();
      expect(find.text('Корень search'), findsOneWidget);
      router.push(const AppDestination(AppRouteKind.artist, id: 'Артист'));
      await tester.pumpAndSettle();
      router.selectTab(AppTab.home);
      await tester.pumpAndSettle();
      expect(find.text('Альбом'), findsOneWidget);
      expect(
        tester.state<_PlayerFixtureState>(find.byType(PlayerFixture)).identity,
        same(identity),
      );
      router.selectTab(AppTab.home);
      await tester.pumpAndSettle();
      expect(find.text('Корень home'), findsOneWidget);
      router.selectTab(AppTab.search);
      await tester.pumpAndSettle();
      expect(find.text('Артист'), findsOneWidget);
    },
  );

  for (final width in [320.0, 390.0, 430.0]) {
    testWidgets('scale 2 destination sheet uses full labels at $width', (
      tester,
    ) async {
      final router = AppRouter();
      addTearDown(router.dispose);
      await mount(tester, router, width: width, scale: 2);
      await tester.tap(find.text('Разделы: Главная'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Моя музыка'));
      await tester.tap(find.text('Моя музыка'));
      await tester.pumpAndSettle();
      expect(router.currentTab, AppTab.library);
      expect(find.text('Корень library'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('Back handles player then detail then tab then Home', (
    tester,
  ) async {
    final router = AppRouter();
    addTearDown(router.dispose);
    await mount(tester, router, player: const PlayerFixture());
    router.selectTab(AppTab.library);
    router.push(const AppDestination(AppRouteKind.playlist, id: 'Плейлист'));
    await tester.pumpAndSettle();
    router.openOverlay(const AppDestination(AppRouteKind.player));
    await tester.pumpAndSettle();
    expect(find.byType(PlayerFixture), findsNothing);
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.text('Плейлист'), findsOneWidget);
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.text('Корень library'), findsOneWidget);
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(router.currentTab, AppTab.home);
  });

  testWidgets(
    'deep link Back returns Home and disabled destination is absent',
    (tester) async {
      final router = AppRouter(
        initialDestination: const AppDestination(
          AppRouteKind.album,
          id: 'Из ссылки',
        ),
      );
      addTearDown(router.dispose);
      await mount(
        tester,
        router,
        capabilities: const AppCapabilities(downloads: false),
      );
      expect(find.text('Из ссылки'), findsOneWidget);
      expect(find.text('Загрузки'), findsNothing);
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(find.text('Корень home'), findsOneWidget);
    },
  );

  testWidgets('wide layout uses rail and current root requests scroll to top', (
    tester,
  ) async {
    var requests = 0;
    final router = AppRouter(onScrollToTop: (_) => requests++);
    addTearDown(router.dispose);
    await mount(tester, router, width: 780);
    expect(find.byType(NavigationRail), findsOneWidget);
    router.selectTab(AppTab.home);
    expect(requests, 1);
    expect(tester.takeException(), isNull);
  });

  testWidgets('disabled initial deep link reports unavailability then Home', (
    tester,
  ) async {
    AppDestination? rejected;
    final router = AppRouter(
      initialTab: AppTab.downloads,
      initialDestination: const AppDestination(AppRouteKind.downloads),
      onUnavailable: (route) => rejected = route,
    );
    addTearDown(router.dispose);
    await mount(
      tester,
      router,
      capabilities: const AppCapabilities(downloads: false),
    );
    expect(router.currentTab, AppTab.home);
    expect(rejected?.kind, AppRouteKind.downloads);
    expect(find.text('Корень home'), findsOneWidget);
    expect(router.canExit, isTrue);
  });

  testWidgets('sheet Back precedes player and preserves selected exact route', (
    tester,
  ) async {
    final router = AppRouter();
    addTearDown(router.dispose);
    await mount(tester, router, player: const PlayerFixture());
    router.push(const AppDestination(AppRouteKind.album, id: 'Точный альбом'));
    await tester.pumpAndSettle();
    router.openOverlay(const AppDestination(AppRouteKind.player));
    await tester.pumpAndSettle();
    var calls = 0;
    MusicActionSheet.show(tester.element(find.text('Содержимое записи')), [
      MusicAction(
        id: 'like',
        label: 'Нравится',
        icon: Icons.favorite_border,
        onSelected: () => calls++,
      ),
    ]);
    await tester.pumpAndSettle();
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(router.playerVisible, isTrue);
    expect(calls, 0);
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.text('Точный альбом'), findsOneWidget);
  });

  testWidgets('tab scroll positions survive switching', (tester) async {
    final router = AppRouter();
    addTearDown(router.dispose);
    await mount(tester, router);
    await tester.drag(find.byType(ListView).first, const Offset(0, -400));
    await tester.pumpAndSettle();
    final homeScroll = tester
        .state<ScrollableState>(find.byType(Scrollable).first)
        .position
        .pixels;
    expect(homeScroll, greaterThan(0));
    router.selectTab(AppTab.search);
    await tester.pumpAndSettle();
    expect(
      tester
          .state<ScrollableState>(find.byType(Scrollable).first)
          .position
          .pixels,
      0,
    );
    router.selectTab(AppTab.home);
    await tester.pumpAndSettle();
    expect(
      tester
          .state<ScrollableState>(find.byType(Scrollable).first)
          .position
          .pixels,
      homeScroll,
    );
  });

  testWidgets('keyboard hides footer without replacing injected player', (
    tester,
  ) async {
    final router = AppRouter(initialTab: AppTab.search);
    addTearDown(router.dispose);
    await mount(
      tester,
      router,
      keyboardInset: 340,
      player: const PlayerFixture(),
    );
    expect(find.text('Текущая запись'), findsNothing);
    expect(find.text('Главная'), findsNothing);
    expect(find.text('Корень search'), findsOneWidget);
    expect(router.back(), isTrue);
    expect(router.currentTab, AppTab.search);
    expect(tester.takeException(), isNull);
  });

  for (final width in [320.0, 390.0, 430.0, 640.0, 780.0]) {
    testWidgets('shell has no overflow at width $width', (tester) async {
      final router = AppRouter();
      addTearDown(router.dispose);
      await mount(
        tester,
        router,
        width: width,
        height: width >= 600 ? 360 : 900,
        player: const PlayerFixture(),
      );
      expect(tester.takeException(), isNull);
      await tester.tap(
        width >= 600 ? find.byTooltip('Волна') : find.text('Волна'),
      );
      await tester.pumpAndSettle();
      expect(router.currentTab, AppTab.wave);
      expect(tester.takeException(), isNull);
    });
  }
}
