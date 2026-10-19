import 'dart:async';

import 'package:flutter/material.dart' hide SearchController;
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/design_system/design_system.dart';
import 'package:soundspan/features/home/home_controller.dart';
import 'package:soundspan/features/home/home_models.dart';
import 'package:soundspan/features/home/home_repository.dart';
import 'package:soundspan/features/home/home_screen.dart';
import 'package:soundspan/features/home/mix_screen.dart';
import 'package:soundspan/features/search/search_controller.dart';
import 'package:soundspan/features/search/search_repository.dart';
import 'package:soundspan/features/search/search_screen.dart';

import '../support/collection_fixtures.dart';

HomeController _home(CollectionTransport transport, CollectionAuthority auth) =>
    HomeController(
      repository: HomeRepository(
        transport: transport,
        authority: auth,
        fence: collectionFence,
      ),
      request: HomeRequest(
        localHour: 12,
        timezoneOffsetMinutes: 180,
        autoPlaylists: false,
        discovery: false,
      ),
    );

void main() {
  testWidgets('home Wave start exposes progress, failure and explicit retry', (
    tester,
  ) async {
    final auth = CollectionAuthority();
    final home = _home(
      CollectionTransport((_, _) => ApiResponse(200, {})),
      auth,
    );
    final first = Completer<void>(), second = Completer<void>();
    var starts = 0;
    await tester.pumpWidget(
      MaterialApp(
        theme: SoundspanTheme.dark(),
        home: HomeScreen(
          controller: home,
          autoLoad: false,
          onOpenWave: () {},
          onOpenMix: (_) {},
          onPlay: (_) {},
          onStartWave: () {
            starts++;
            return starts == 1 ? first.future : second.future;
          },
        ),
      ),
    );
    await tester.tap(find.text('Слушать волну'));
    await tester.pump();
    expect(find.text('Запускаем волну…'), findsOneWidget);
    final startingButton = find.ancestor(
      of: find.text('Запускаем волну…'),
      matching: find.byType(FilledButton),
    );
    expect(tester.widget<FilledButton>(startingButton).onPressed, isNull);
    await tester.tap(find.text('Запускаем волну…'));
    await tester.pump();
    expect(starts, 1);

    first.completeError(
      const AppFailure(
        code: 'wave_fixture',
        message: 'Источник волны недоступен',
      ),
    );
    await tester.pump();
    expect(find.text('Источник волны недоступен'), findsOneWidget);
    expect(find.text('Повторить запуск'), findsOneWidget);
    await tester.ensureVisible(find.text('Повторить запуск'));
    await tester.tap(find.text('Повторить запуск'));
    await tester.pump();
    expect(starts, 2);
    expect(find.text('Источник волны недоступен'), findsNothing);
    second.complete();
    await tester.pumpAndSettle();
    expect(find.text('Слушать волну'), findsOneWidget);
    expect(find.text('Повторить запуск'), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    home.dispose();
    await auth.updates.close();
  });

  testWidgets('lazy mix reserves unavailable counts for completed detail', (
    tester,
  ) async {
    final auth = CollectionAuthority(), response = Completer<ApiResponse>();
    final home = _home(CollectionTransport((_, _) => response.future), auth);
    final mix = MusicMix(
      id: 'lazy',
      title: 'Мой микс',
      description: 'Подборка',
      kind: MusicMixKind.legacy,
      trackCount: 40,
      loaded: false,
    );
    await tester.pumpWidget(
      MaterialApp(
        theme: SoundspanTheme.dark(),
        home: MixScreen(controller: home, mix: mix, onPlay: (_) {}),
      ),
    );
    await tester.pump();
    expect(home.state.mixLoading, isTrue);
    expect(find.byType(MusicLoadingState), findsOneWidget);
    expect(find.text('40 треков · 0 доступны'), findsNothing);
    expect(find.textContaining('записей пока недоступны'), findsNothing);
    response.complete(
      ApiResponse(200, {
        'id': 'lazy',
        'name': 'Мой микс',
        'description': 'Подборка',
        'trackCount': 2,
        'tracks': [likedDto(1)],
      }),
    );
    await tester.pumpAndSettle();
    expect(find.text('2 треков · 1 доступны'), findsOneWidget);
    expect(find.textContaining('1 записей пока недоступны'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    home.dispose();
    await auth.updates.close();
  });

  for (final providerFailed in [true, false]) {
    testWidgets(
      'search empty notice respects provider failure=$providerFailed',
      (tester) async {
        final auth = CollectionAuthority();
        final transport = CollectionTransport((request, _) {
          if (request.path == '/api/search/discover') {
            return providerFailed
                ? const ApiResponse(503, {})
                : const ApiResponse(200, {'results': []});
          }
          return ApiResponse(200, {
            'tracks': [],
            'artists': [],
            'albums': [],
            'unavailable': [],
          });
        });
        final controller = SearchController(
          repository: SearchRepository(
            transport: transport,
            authority: auth,
            fence: collectionFence,
            networkPolicy: const NetworkPolicy.online(),
          ),
        );
        await controller.submit('Неизвестная песня');
        await tester.pumpWidget(
          MaterialApp(
            theme: SoundspanTheme.dark(),
            home: SearchScreen(controller: controller),
          ),
        );
        final empty = find.text(
          'Ничего не найдено. Попробуйте другое название.',
        );
        expect(empty, providerFailed ? findsNothing : findsOneWidget);
        expect(
          find.text('Повторить поиск'),
          providerFailed ? findsOneWidget : findsNothing,
        );
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox.shrink());
        controller.dispose();
        await auth.updates.close();
      },
    );
  }
}
