import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/design_system/design_system.dart';

void main() {
  testWidgets(
    'large-text empty state keeps its action reachable in a short view',
    (tester) async {
      tester.view.physicalSize = const Size(320, 480);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      var actions = 0;
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: TextScaler.linear(2)),
            child: child!,
          ),
          home: Scaffold(
            body: Align(
              alignment: Alignment.topCenter,
              child: SizedBox(
                width: 320,
                height: 240,
                child: MusicEmptyState(
                  title: 'Здесь будет ваша музыка',
                  message: 'Отмечайте понравившиеся треки, чтобы они появились в коллекции.',
                  actionLabel: 'Найти музыку',
                  onAction: () => actions++,
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await tester.ensureVisible(find.text('Найти музыку'));
      await tester.pumpAndSettle();
      expect(find.text('Найти музыку').hitTestable(), findsOneWidget);
      await tester.tap(find.text('Найти музыку'));
      expect(actions, 1);
    },
  );
}
