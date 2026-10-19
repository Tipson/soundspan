import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/design_system/music_controls.dart';
import 'package:soundspan/design_system/theme.dart';
import 'package:soundspan/features/likes/preference_controller.dart';
import 'package:soundspan/features/player/full_player_screen.dart';
import 'package:soundspan/features/player/player_controller.dart';
import 'package:soundspan/playback/playback_controller.dart';

import '../support/collection_fixtures.dart';

const _title = 'Очень длинное название любимой песни';

void main() {
  late CollectionAuthority authority;
  late CollectionPlayback playback;
  late PreferenceController preferences;
  late PlayerController controller;
  var queues = 0, lyrics = 0, related = 0;

  setUp(() {
    queues = lyrics = related = 0;
    authority = CollectionAuthority();
    final entry = QueueEntry(
      entryId: 'first',
      track: const Track(
        ref: LibraryTrackRef('local-1'),
        title: _title,
        artist: 'Olivia Rodrigo',
        artistId: 'artist-1',
      ),
      context: const PlayContext(surface: PlaySurface.library),
    );
    playback = CollectionPlayback(
      QueueSnapshot(
        fence: collectionFence,
        entries: [entry],
        effectiveOrder: ['first'],
        currentEntryId: 'first',
        position: const Duration(seconds: 37),
        duration: const Duration(seconds: 177),
        processing: PlaybackProcessing.ready,
        playingIntent: true,
      ),
    )..moveOnNext = false;
    preferences = PreferenceController(
      transport: CollectionTransport(
        (_, _) => preferenceResponse('local-1', 'clear'),
      ),
      authority: authority,
      fence: collectionFence,
      playback: playback,
    );
    controller = PlayerController(
      playback: playback,
      authority: authority,
      fence: collectionFence,
      preferences: preferences,
      callbacks: PlayerCallbacks(
        onArtist: (_) {},
        onRadio: (_) {},
        onLyrics: (_) => lyrics++,
        onRelated: (_) => related++,
      ),
    );
  });

  tearDown(() async {
    controller.dispose();
    preferences.dispose();
    await authority.updates.close();
  });

  Future<void> mount(
    WidgetTester tester, {
    required Size size,
    double scale = 1,
  }) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        theme: SoundspanTheme.dark(),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(
            padding: const EdgeInsets.symmetric(vertical: 24),
            textScaler: TextScaler.linear(scale),
          ),
          child: child!,
        ),
        home: FullPlayerScreen(
          controller: controller,
          onOpenQueue: () => queues++,
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Finder feedback(String text) =>
      find.ancestor(of: find.text(text), matching: find.byType(MusicTapTarget));

  for (final scenario in [
    (size: const Size(320, 640), scale: 1.0),
    (size: const Size(360, 800), scale: 1.0),
    (size: const Size(320, 720), scale: 1.3),
    (size: const Size(360, 800), scale: 1.3),
  ]) {
    testWidgets('core controls fit before scrolling at $scenario', (
      tester,
    ) async {
      await mount(tester, size: scenario.size, scale: scenario.scale);
      final viewport = tester.getRect(find.byType(SingleChildScrollView).first);
      final controls = [
        find.byTooltip('Перемешать'),
        find.byTooltip('Предыдущий трек'),
        find.byType(FilledButton).first,
        find.byTooltip('Следующий трек'),
        find.byTooltip('Повтор выключен'),
        for (final label in ['Нравится', 'В волну', 'Не нравится'])
          feedback(label),
      ];
      for (final control in controls) {
        final rect = tester.getRect(control);
        expect(rect.width, greaterThanOrEqualTo(48));
        expect(rect.height, greaterThanOrEqualTo(48));
        expect(rect.top, greaterThanOrEqualTo(viewport.top));
        expect(
          rect.bottom,
          lessThanOrEqualTo(viewport.bottom),
          reason: '$control must fit in $viewport',
        );
        expect(control.hitTestable(), findsOneWidget);
      }
      final title = tester.renderObject<RenderParagraph>(find.text(_title));
      expect(title.didExceedMaxLines, isFalse);
      expect(tester.widget<Text>(find.text(_title)).maxLines, isNull);
      expect(playback.commands, isEmpty, reason: 'Opening is not playback');
      await tester.tap(find.byTooltip('Следующий трек'));
      await tester.pumpAndSettle();
      expect(playback.commands.single, isA<Next>());
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('artwork gives core controls space on a shorter viewport', (
    tester,
  ) async {
    await mount(tester, size: const Size(360, 900));
    final tall = tester.getSize(find.byKey(const ValueKey('player-art')));
    await mount(tester, size: const Size(360, 640));
    final short = tester.getSize(find.byKey(const ValueKey('player-art')));
    expect(short.height, lessThan(tall.height));
    expect(short.width, short.height);
    expect(tall.width, tall.height);
    expect(tester.takeException(), isNull);
  });

  for (final scenario in [
    (size: const Size(320, 640), scale: 2.0),
    (size: const Size(640, 360), scale: 1.0),
    (size: const Size(640, 360), scale: 1.3),
    (size: const Size(640, 360), scale: 2.0),
  ]) {
    testWidgets('large text and landscape keep scroll access at $scenario', (
      tester,
    ) async {
      await mount(tester, size: scenario.size, scale: scenario.scale);
      expect(tester.takeException(), isNull);
      for (final label in ['Нравится', 'В волну', 'Не нравится']) {
        final target = feedback(label);
        await tester.ensureVisible(target);
        await tester.pumpAndSettle();
        expect(target.hitTestable(), findsOneWidget);
        expect(tester.getSize(target).height, greaterThanOrEqualTo(48));
        expect(tester.getSize(target).width, greaterThanOrEqualTo(48));
      }
      for (final label in ['Открыть очередь', 'Текст', 'Похожее']) {
        final target = find.text(label);
        await tester.ensureVisible(target);
        await tester.pumpAndSettle();
        await tester.tap(target);
        await tester.pumpAndSettle();
      }
      expect(queues, 1);
      expect(lyrics, 1);
      expect(related, 1);
      expect(tester.widget<Text>(find.text(_title)).maxLines, isNull);
      await tester.tap(find.byTooltip('Действия трека'));
      await tester.pumpAndSettle();
      expect(find.text('Громкость'), findsOneWidget);
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    });
  }
}
