import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/features/settings/settings_screen.dart';
import 'package:soundspan/features/updates/app_update_screen.dart';
import 'package:soundspan/design_system/theme.dart';

import '../../support/update_controller_fixtures.dart';

void main() {
  late UpdateControllerFixture f;
  setUp(() => f = UpdateControllerFixture());
  tearDown(() => f.close());
  Widget page({double scale = 1}) => MaterialApp(
    theme: SoundspanTheme.dark(),
    home: MediaQuery(
      data: MediaQueryData(textScaler: TextScaler.linear(scale)),
      child: AppUpdateScreen(controller: f.controller),
    ),
  );
  testWidgets('Settings exposes one explicit app update entry', (tester) async {
    var opens = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: SettingsScreen(
          onProfile: () {},
          onTaste: () {},
          onPlayback: () {},
          onOffline: () {},
          onAccount: () {},
          onHistory: () {},
          onUpdates: () => opens++,
        ),
      ),
    );
    await tester.scrollUntilVisible(find.text('Обновление приложения'), 250);
    await tester.tap(find.text('Обновление приложения'));
    expect(opens, 1);
    expect(f.requests, 0);
  });
  testWidgets('check download and install need three distinct taps', (
    tester,
  ) async {
    await tester.pumpWidget(page());
    expect(f.requests, 0);
    await tester.tap(find.byKey(const Key('update-check')));
    await tester.pumpAndSettle();
    expect(f.downloader.downloads, 0);
    await tester.tap(find.byKey(const Key('update-download')));
    await tester.pumpAndSettle();
    expect(f.installer.commits, 0);
    await tester.tap(find.byKey(const Key('update-install')));
    await tester.pumpAndSettle();
    expect(f.installer.commits, 1);
    expect(find.textContaining('не подтверждён'), findsOneWidget);
  });
  testWidgets('320px large Russian text scrolls without overflow', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 640);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    f.responseCode = 404;
    await tester.pumpWidget(page(scale: 1.8));
    await tester.ensureVisible(find.byKey(const Key('update-check')));
    await tester.tap(find.byKey(const Key('update-check')));
    await tester.pumpAndSettle();
    expect(
      find.text('Обновления на этом сервере не настроены.'),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });
  testWidgets('covering route cancels held native preparation while mounted', (
    tester,
  ) async {
    await tester.pumpWidget(page());
    await f.ready();
    await tester.pumpAndSettle();
    final entered = Completer<void>(), release = Completer<void>();
    f.installer.onStage = () {
      entered.complete();
      return release.future;
    };
    final pending = f.controller.install();
    await tester.pump();
    await entered.future;
    final context = tester.element(find.byType(AppUpdateScreen));
    unawaited(
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => const Scaffold(body: Text('Другая страница')),
        ),
      ),
    );
    await tester.pumpAndSettle();
    release.complete();
    await pending;
    expect(f.installer.commits, 0);
    expect(f.installer.cancels, greaterThan(0));
  });
}
