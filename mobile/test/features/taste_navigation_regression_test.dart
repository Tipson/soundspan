import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/features/tastes/taste_controller.dart';
import 'package:soundspan/features/tastes/taste_repository.dart';
import 'package:soundspan/features/tastes/taste_screen.dart';

import '../support/collection_fixtures.dart';

const _profile = ApiResponse(200, {
  'needsOnboarding': false,
  'profile': {'genres': <String>[], 'artists': <String>[]},
});

void main() {
  for (final scenario in [
    'success',
    'back',
    'covered',
    'stale tap',
    'owner revoked',
    'controller replaced',
    'source hidden',
    'source stale tap',
  ]) {
    testWidgets('taste save navigation: $scenario', (tester) async {
      final authority = CollectionAuthority();
      final gate = Completer<ApiResponse>();
      final transport = CollectionTransport((r, _) {
        if (r.path == '/api/taste-profile/artists') {
          return const ApiResponse(200, {
            'artists': <String>[],
            'nextPage': null,
          });
        }
        return r.method == ApiMethod.get ? _profile : gate.future;
      });
      final repo = TasteRepository(
        transport: transport,
        authority: authority,
        fence: collectionFence,
        networkPolicy: const NetworkPolicy.online(),
      );
      final controller = TasteController(repo);
      final replacement = TasteController(repo);
      await controller.load();
      await replacement.load();
      addTearDown(() async {
        controller.dispose();
        replacement.dispose();
        repo.dispose();
        await authority.updates.close();
      });
      final nav = GlobalKey<NavigatorState>();
      var completions = 0;
      var current = controller;
      var sourceCurrent = true;
      late StateSetter rebuild;
      await tester.pumpWidget(
        MaterialApp(
          navigatorKey: nav,
          home: const Scaffold(body: Text('Home')),
        ),
      );
      unawaited(
        nav.currentState!.push<void>(
          MaterialPageRoute(
            builder: (_) => const Scaffold(body: Text('Previous route')),
          ),
        ),
      );
      await tester.pumpAndSettle();
      unawaited(
        nav.currentState!.push<void>(
          PageRouteBuilder<void>(
            transitionDuration: const Duration(milliseconds: 500),
            reverseTransitionDuration: const Duration(milliseconds: 500),
            pageBuilder: (_, _, _) => StatefulBuilder(
              builder: (_, setState) {
                rebuild = setState;
                return TasteScreen(
                  controller: current,
                  current: () => sourceCurrent,
                  onComplete: () {
                    completions++;
                    nav.currentState!.pop();
                  },
                );
              },
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final save = find.widgetWithText(OutlinedButton, 'Настроить под меня');
      await tester.scrollUntilVisible(
        save,
        300,
        scrollable: find.byType(Scrollable).first,
      );
      final onPressed = tester.widget<OutlinedButton>(save).onPressed!;
      if (scenario == 'stale tap') nav.currentState!.pop();
      if (scenario == 'source stale tap') sourceCurrent = false;
      onPressed();
      await tester.pump(const Duration(milliseconds: 1));
      if (scenario == 'back') nav.currentState!.pop();
      if (scenario == 'covered') {
        unawaited(
          nav.currentState!.push<void>(
            MaterialPageRoute(
              builder: (_) => const Scaffold(body: Text('Cover')),
            ),
          ),
        );
      }
      if (scenario == 'owner revoked') authority.switchOwner();
      if (scenario == 'controller replaced') {
        rebuild(() => current = replacement);
      }
      if (scenario == 'source hidden') sourceCurrent = false;
      await tester.pump(const Duration(milliseconds: 1));
      gate.complete(_profile);
      await tester.pump(const Duration(milliseconds: 1));
      expect(completions, scenario == 'success' ? 1 : 0);
      expect(
        transport.requests.where((r) => r.method != ApiMethod.get),
        hasLength(
          scenario == 'stale tap' || scenario == 'source stale tap' ? 0 : 1,
        ),
      );
      await tester.pumpAndSettle();
      if (scenario == 'success' ||
          scenario == 'back' ||
          scenario == 'stale tap') {
        expect(find.text('Previous route'), findsOneWidget);
      }
      if (scenario == 'covered') expect(find.text('Cover'), findsOneWidget);
      if (scenario == 'back') {
        expect(controller.saving, isFalse);
        expect(controller.failure, isNull);
      }
      await tester.pumpWidget(const SizedBox.shrink());
    });
  }
}
