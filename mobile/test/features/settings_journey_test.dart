import 'dart:typed_data';
import 'dart:async';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/features/settings/settings_models.dart';
import 'package:soundspan/features/settings/settings_repository.dart';
import 'package:soundspan/features/settings/settings_controller.dart';
import 'package:soundspan/features/tastes/taste_repository.dart';
import 'package:soundspan/features/tastes/taste_controller.dart';
import 'package:soundspan/features/tastes/taste_screen.dart';
import 'package:soundspan/features/settings/profile_screen.dart';
import 'package:soundspan/features/settings/playback_settings_screen.dart';
import 'package:soundspan/design_system/theme.dart';

import '../support/collection_fixtures.dart';

class SettingsAdmissionAuthority extends CollectionAuthority {
  Completer<void>? gate;
  @override
  Future<void> assertCurrent(fence) async {
    await gate?.future;
    await super.assertCurrent(fence);
  }
}

void main() {
  test(
    'owner switch immediately clears settings listeners and rejects writes',
    () async {
      final authority = CollectionAuthority();
      final transport = CollectionTransport(
        (_, _) => const ApiResponse(200, {'displayName': 'A'}),
      );
      final repo = SettingsRepository(
        transport: transport,
        authority: authority,
        fence: collectionFence,
        networkPolicy: const NetworkPolicy.online(),
      );
      final quality = ValueNotifier('original');
      final c = SettingsController(
        repository: repo,
        quality: quality,
        setQuality: (_) async {},
      );
      addTearDown(c.dispose);
      addTearDown(repo.dispose);
      addTearDown(quality.dispose);
      addTearDown(authority.updates.close);
      await c.load();
      var notified = 0;
      c.addListener(() => notified++);
      authority.switchOwner();
      expect(notified, greaterThan(0));
      expect(c.settings, isNull);
      expect(
        await c.update(const UserSettingsPatch(displayName: 'B')),
        isFalse,
      );
      expect(transport.requests.length, 1);
    },
  );
  test('disposed settings command never passes delayed admission', () async {
    final authority = SettingsAdmissionAuthority();
    final transport = CollectionTransport((_, _) => const ApiResponse(200, {}));
    final repo = SettingsRepository(
      transport: transport,
      authority: authority,
      fence: collectionFence,
      networkPolicy: const NetworkPolicy.online(),
    );
    final quality = ValueNotifier('original');
    final c = SettingsController(
      repository: repo,
      quality: quality,
      setQuality: (_) async {},
    );
    addTearDown(repo.dispose);
    addTearDown(quality.dispose);
    addTearDown(authority.updates.close);
    authority.gate = Completer<void>();
    final result = c.update(const UserSettingsPatch(displayName: 'B'));
    c.dispose();
    authority.gate!.complete();
    expect(await result, isFalse);
    expect(transport.requests, isEmpty);
  });
  test(
    'catalog stale filter and owner results never replace current ordered rows',
    () async {
      final authority = CollectionAuthority();
      final old = Completer<ApiResponse>();
      final transport = CollectionTransport((r, _) {
        if (r.path == '/api/taste-profile') {
          return const ApiResponse(200, {
            'profile': null,
            'needsOnboarding': true,
          });
        }
        if (r.query['genre'] == 'Рок') return old.future;
        return ApiResponse(200, {
          'artists': r.query['genre'] == 'Поп'
              ? ['ABBA', 'Madonna', 'abba']
              : ['Кино'],
          'nextPage': null,
        });
      });
      final repo = TasteRepository(
        transport: transport,
        authority: authority,
        fence: collectionFence,
        networkPolicy: const NetworkPolicy.online(),
      );
      final c = TasteController(repo);
      addTearDown(c.dispose);
      addTearDown(repo.dispose);
      addTearDown(authority.updates.close);
      await c.load();
      final rock = c.filter('Рок');
      await Future<void>.delayed(Duration.zero);
      await c.filter('Поп');
      expect(c.catalog, ['ABBA', 'Madonna']);
      old.complete(
        const ApiResponse(200, {
          'artists': ['Wrong'],
          'nextPage': null,
        }),
      );
      await rock;
      expect(c.catalog, ['ABBA', 'Madonna']);
      c.toggle('ABBA', artist: true);
      expect(c.catalog, ['ABBA', 'Madonna']);
      var notified = 0;
      c.addListener(() => notified++);
      authority.switchOwner();
      expect(notified, greaterThan(0));
      expect(c.catalog, isEmpty);
      expect(await c.save(), isFalse);
    },
  );
  testWidgets(
    'avatar validates decoded immutable PNG and rejects oversize dimensions',
    (tester) async {
      await tester.runAsync(() async {
        Future<Uint8List> png(int width) async {
          final recorder = ui.PictureRecorder();
          final canvas = ui.Canvas(recorder);
          canvas.drawColor(const ui.Color(0xff112233), ui.BlendMode.src);
          final picture = recorder.endRecording();
          final image = await picture.toImage(width, 1);
          final data = await image.toByteData(format: ui.ImageByteFormat.png);
          image.dispose();
          picture.dispose();
          return data!.buffer.asUint8List();
        }

        final bytes = await png(512);
        final avatar = await AvatarInput.validate(bytes);
        expect(avatar.width, 512);
        expect(avatar.mimeType, 'image/png');
        bytes[0] = 0;
        expect(avatar.bytes[0], 137);
        expect(() => avatar.bytes[0] = 0, throwsUnsupportedError);
        await expectLater(
          AvatarInput.validate(await png(513)),
          throwsA(anything),
        );
      });
    },
  );
  for (final size in [
    const Size(320, 740),
    const Size(390, 844),
    const Size(430, 932),
    const Size(844, 390),
  ]) {
    testWidgets('taste and settings fit $size at text scale2', (tester) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final authority = CollectionAuthority();
      final transport = CollectionTransport(
        (r, _) => ApiResponse(
          200,
          r.path.endsWith('/artists')
              ? {
                  'artists': ['Очень длинное полное имя исполнителя', 'Кино'],
                  'nextPage': null,
                }
              : r.path == '/api/taste-profile'
              ? {'profile': null, 'needsOnboarding': true}
              : {
                  'displayName': 'John',
                  'loudnessMode': 'auto',
                  'hasProfilePicture': false,
                },
        ),
      );
      final tastesRepo = TasteRepository(
        transport: transport,
        authority: authority,
        fence: collectionFence,
        networkPolicy: const NetworkPolicy.online(),
      );
      final tastes = TasteController(tastesRepo);
      await tastes.load();
      final repo = SettingsRepository(
        transport: transport,
        authority: authority,
        fence: collectionFence,
        networkPolicy: const NetworkPolicy.online(),
      );
      final quality = ValueNotifier('original');
      final settings = SettingsController(
        repository: repo,
        quality: quality,
        setQuality: (v) async {
          quality.value = v;
        },
      );
      await settings.load();
      addTearDown(tastes.dispose);
      addTearDown(tastesRepo.dispose);
      addTearDown(settings.dispose);
      addTearDown(repo.dispose);
      addTearDown(quality.dispose);
      addTearDown(authority.updates.close);
      Widget app(Widget child) => MaterialApp(
        theme: SoundspanTheme.dark(),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: const TextScaler.linear(2)),
          child: child!,
        ),
        home: child,
      );
      await tester.pumpWidget(
        app(TasteScreen(controller: tastes, onComplete: () {})),
      );
      await tester.pump();
      expect(tester.takeException(), isNull);
      expect(tastes.progress, 0);
      await tester.scrollUntilVisible(
        find.text('Все жанры'),
        300,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.text('Все жанры'));
      await tester.pumpAndSettle();
      expect(find.text('Закрыть жанры'), findsNothing);
      expect(find.byType(CheckboxListTile), findsWidgets);
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(find.byType(CheckboxListTile), findsNothing);
      tastes.toggle('Рок', artist: false);
      tastes.toggle('Поп', artist: false);
      tastes.toggle('Инди', artist: false);
      tastes.toggle('Джаз', artist: false);
      tastes.toggle('Кино', artist: true);
      await tester.pump();
      expect(tastes.progress, 1);
      expect(tester.takeException(), isNull);
      await tester.scrollUntilVisible(
        find.byKey(const ValueKey('taste-progress')),
        300,
        scrollable: find.byType(Scrollable).first,
      );
      expect(
        tester
            .widget<FractionallySizedBox>(
              find.byKey(const ValueKey('taste-progress')),
            )
            .widthFactor,
        1,
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(app(ProfileScreen(controller: settings)));
      await tester.pump();
      expect(tester.takeException(), isNull);
      await tester.scrollUntilVisible(
        find.byType(TextField),
        300,
        scrollable: find.byType(Scrollable).first,
      );
      tester.view.viewInsets = const FakeViewPadding(bottom: 280);
      await tester.enterText(find.byType(TextField), 'Иван');
      await tester.pump();
      expect(find.textContaining('Сервер принимает'), findsOneWidget);
      expect(tester.takeException(), isNull);
      tester.view.resetViewInsets();
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pumpWidget(
        app(PlaybackSettingsScreen(controller: settings)),
      );
      await tester.pump();
      await tester.scrollUntilVisible(
        find.text('Автоматически'),
        300,
        scrollable: find.byType(Scrollable).first,
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    });
  }
  test('taste create/replace/skip use exact routes without likes', () async {
    final authority = CollectionAuthority();
    final transport = CollectionTransport(
      (r, _) => ApiResponse(200, {
        'profile': {
          'genres': r.body?['genres'] ?? [],
          'artists': r.body?['artists'] ?? [],
        },
        'needsOnboarding': false,
        'completedAt': null,
        'skippedAt': null,
      }),
    );
    final repo = TasteRepository(
      transport: transport,
      authority: authority,
      fence: collectionFence,
      networkPolicy: const NetworkPolicy.online(),
    );
    addTearDown(repo.dispose);
    addTearDown(authority.updates.close);
    await repo.save(
      genres: [' Рок ', 'рок'],
      artists: ['Кино'],
      replace: false,
    );
    await repo.save(genres: [], artists: [], replace: true);
    await repo.skip(replace: false);
    expect(transport.requests.map((r) => r.method), [
      ApiMethod.post,
      ApiMethod.put,
      ApiMethod.post,
    ]);
    expect(
      transport.requests.every((r) => r.path == '/api/taste-profile'),
      isTrue,
    );
    expect(transport.requests.first.body, {
      'genres': ['Рок'],
      'artists': ['Кино'],
    });
    expect(transport.requests.last.body, {'skip': true});
  });
  test('profile ASCII validation and immutable allowlisted patch', () {
    expect(validateDisplayName('Иван'), isNotNull);
    expect(validateDisplayName('A' * 81), isNotNull);
    expect(validateDisplayName(' John Doe-2. '), isNull);
    expect(UserSettingsPatch(displayName: '').toJson(), {'displayName': null});
    expect(UserSettingsPatch(shareOnlinePresence: true).toJson(), {
      'shareOnlinePresence': true,
    });
  });
  test('malformed avatar is rejected before uploader', () async {
    await expectLater(
      AvatarInput.validate(Uint8List.fromList([1, 2, 3])),
      throwsA(anything),
    );
    await expectLater(
      AvatarInput.validate(Uint8List(5 * 1024 * 1024 + 1)),
      throwsA(anything),
    );
  });
  test(
    'quality only calls owner callback; server load cannot overwrite it',
    () async {
      final authority = CollectionAuthority();
      final transport = CollectionTransport(
        (_, _) => const ApiResponse(200, {
          'displayName': 'Test',
          'loudnessMode': 'auto',
          'shareOnlinePresence': false,
          'shareListeningStatus': false,
          'playbackQuality': 'medium',
          'hasProfilePicture': false,
        }),
      );
      final repo = SettingsRepository(
        transport: transport,
        authority: authority,
        fence: collectionFence,
        networkPolicy: const NetworkPolicy.online(),
      );
      final quality = ValueNotifier('original');
      final controller = SettingsController(
        repository: repo,
        quality: quality,
        setQuality: (v) async {
          quality.value = v;
        },
      );
      addTearDown(controller.dispose);
      addTearDown(repo.dispose);
      addTearDown(authority.updates.close);
      addTearDown(quality.dispose);
      await controller.load();
      expect(quality.value, 'original');
      await controller.changeQuality('high');
      expect(quality.value, 'high');
      expect(transport.requests.length, 1);
    },
  );
}
