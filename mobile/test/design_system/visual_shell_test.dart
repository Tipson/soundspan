import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/app/app_destinations.dart';
import 'package:soundspan/app/app_router.dart';
import 'package:soundspan/app/app_shell.dart';
import 'package:soundspan/design_system/design_system.dart';

void main() {
  for (final width in [320.0, 360.0, 430.0]) {
    testWidgets(
      'compact navigation keeps all destinations in a calm footer $width',
      (tester) async {
        tester.view.physicalSize = Size(width, 640);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final router = AppRouter();
        addTearDown(router.dispose);
        await tester.pumpWidget(
          MaterialApp(
            theme: SoundspanTheme.dark(),
            home: AppShell(
              router: router,
              destinations: {
                for (final tab in AppTab.values)
                  tab: (_) => ColoredBox(
                    key: ValueKey('surface-${tab.name}'),
                    color: MusicColors.canvas,
                  ),
              },
              routeBuilder: (_, _) => const SizedBox.shrink(),
            ),
          ),
        );
        await tester.pumpAndSettle();
        final content = tester.getRect(
          find.byKey(const ValueKey('surface-home')),
        );
        expect(
          640 - content.bottom,
          lessThanOrEqualTo(72),
          reason: 'The stable footer must leave space for the music, even at 320 dp.',
        );
        for (final tab in AppTab.values) {
          final semantics = find.byWidgetPredicate(
            (widget) =>
                widget is Semantics &&
                widget.properties.label == tab.label &&
                widget.properties.button == true,
          );
          expect(semantics, findsOneWidget);
          final rect = tester.getRect(semantics);
          expect(rect.width, greaterThanOrEqualTo(48));
          expect(rect.height, greaterThanOrEqualTo(48));
          await tester.tap(semantics);
          await tester.pumpAndSettle();
          expect(router.currentTab, tab);
        }
        expect(tester.takeException(), isNull);
      },
    );
  }
}
