import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/design_system/theme.dart';
import 'package:soundspan/features/tastes/taste_controller.dart';
import 'package:soundspan/features/tastes/taste_repository.dart';
import 'package:soundspan/features/tastes/taste_screen.dart';

import '../support/collection_fixtures.dart';

void main() {
  for (final scale in [1.0, 2.0]) {
    testWidgets('taste count and save stay reachable at 360dp scale $scale', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(360, 740);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final authority = CollectionAuthority();
      final repo = TasteRepository(
        transport: CollectionTransport(
          (r, _) => ApiResponse(
            200,
            r.path.endsWith('/artists')
                ? {
                    'artists': [
                      'Olivia Rodrigo',
                      'Кино',
                      'Очень длинное имя артиста',
                    ],
                    'nextPage': null,
                  }
                : {
                    'needsOnboarding': false,
                    'profile': {'genres': [], 'artists': []},
                  },
          ),
        ),
        authority: authority,
        fence: collectionFence,
        networkPolicy: const NetworkPolicy.online(),
      );
      final controller = TasteController(repo);
      await controller.load();
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: TextScaler.linear(scale)),
            child: child!,
          ),
          home: TasteScreen(controller: controller, onComplete: () {}),
        ),
      );
      final save = find.widgetWithText(OutlinedButton, 'Настроить под меня');
      expect(save.hitTestable(), findsOneWidget);
      expect(find.text('Выбрано: 0').hitTestable(), findsOneWidget);
      controller.toggle('Кино', artist: true);
      await tester.pumpAndSettle();
      expect(find.text('Выбрано: 1').hitTestable(), findsOneWidget);
      await tester.drag(find.byType(ListView).first, const Offset(0, -600));
      await tester.pumpAndSettle();
      expect(find.text('Применить выбор').hitTestable(), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      repo.dispose();
      await authority.updates.close();
    });
  }
}
