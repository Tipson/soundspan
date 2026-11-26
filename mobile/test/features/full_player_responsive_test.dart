import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/design_system/music_controls.dart';
import 'package:soundspan/design_system/theme.dart';
import 'package:soundspan/design_system/tokens.dart';
import 'package:soundspan/features/likes/preference_controller.dart';
import 'package:soundspan/features/player/full_player_screen.dart';
import 'package:soundspan/features/player/mini_player.dart';
import 'package:soundspan/features/player/player_controller.dart';
import 'package:soundspan/playback/playback_controller.dart';

import '../support/collection_fixtures.dart';

const _title = 'Очень длинное название любимой песни';
const _longTitle =
    'All I Want (From "High School Musical: The Musical: The Series")';

void main() {
  late CollectionAuthority authority;
  late CollectionPlayback playback;
  late PreferenceController preferences;
  late PlayerController controller;
  var queues = 0, lyrics = 0, related = 0;

  QueueSnapshot state(String title, {bool interrupted = false}) {
    final entry = QueueEntry(
      entryId: 'first',
      track: Track(
        ref: const LibraryTrackRef('local-1'),
        title: title,
        artist: 'Olivia Rodrigo',
        artistId: 'artist-1',
      ),
      context: const PlayContext(surface: PlaySurface.library),
    );
    return QueueSnapshot(
      fence: collectionFence,
      entries: [entry],
      effectiveOrder: ['first'],
      currentEntryId: 'first',
      position: const Duration(seconds: 37),
      duration: const Duration(seconds: 177),
      processing: PlaybackProcessing.ready,
      playingIntent: true,
      focusSuspended: interrupted,
    );
  }

  setUp(() {
    queues = lyrics = related = 0;
    authority = CollectionAuthority();
    playback = CollectionPlayback(state(_title))..moveOnNext = false;
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
    bool mini = false,
    bool longTitle = false,
    bool interrupted = false,
  }) async {
    if (longTitle || interrupted) {
      playback.value = state(
        longTitle ? _longTitle : _title,
        interrupted: interrupted,
      );
    }
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
        home: mini
            ? Scaffold(
                body: Align(
                  alignment: Alignment.bottomCenter,
                  child: MiniPlayer(
                    controller: controller,
                    onOpen: () => queues++,
                  ),
                ),
              )
            : FullPlayerScreen(
                controller: controller,
                onOpenQueue: () => queues++,
              ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('queue is directly reachable with long title on a short phone', (
    tester,
  ) async {
    await mount(
      tester,
      size: const Size(320, 640),
      scale: 1.3,
      longTitle: true,
    );
    final queue = find.byTooltip('Открыть очередь');
    expect(queue.hitTestable(), findsOneWidget);
    await tester.tap(queue);
    await tester.pumpAndSettle();
    expect(queues, 1);
    expect(playback.commands, isEmpty);
  });

  testWidgets('upcoming preview labels the next three tracks in play order', (
    tester,
  ) async {
    final current = state(_title).currentEntry!;
    const artist = 'Исполнитель';
    final entries = [
      for (var i = 0; i < 5; i++)
        QueueEntry(
          entryId: 'entry-$i',
          track: Track(
            ref: LibraryTrackRef('track-$i'),
            title: 'Трек $i',
            artist: artist,
          ),
          context: current.context,
        ),
    ];
    playback.value = QueueSnapshot(
      fence: collectionFence,
      entries: [current, ...entries],
      effectiveOrder: [
        entries[0].entryId,
        current.entryId,
        entries[3].entryId,
        entries[1].entryId,
        entries[4].entryId,
        entries[2].entryId,
      ],
      currentEntryId: current.entryId,
      playingIntent: true,
    );
    await mount(tester, size: const Size(360, 800));
    final header = find.text('Далее в очереди');
    expect(header, findsOneWidget);
    await tester.ensureVisible(header);
    final upcoming = [
      for (final i in [3, 1, 4]) find.text('Трек $i · $artist'),
    ];
    var previous = tester.getTopLeft(header).dy;
    for (final track in upcoming) {
      expect(track, findsOneWidget);
      final top = tester.getTopLeft(track).dy;
      expect(top, greaterThan(previous));
      previous = top;
    }
    for (final i in [0, 2]) {
      expect(find.text('Трек $i · $artist'), findsNothing);
    }
  });

  testWidgets('upcoming preview hides its heading at the end of the queue', (
    tester,
  ) async {
    await mount(tester, size: const Size(360, 800));
    expect(find.text('Далее в очереди'), findsNothing);
  });

  testWidgets(
    'long-title player exposes both text and related without scrolling',
    (tester) async {
      await mount(tester, size: const Size(360, 800), longTitle: true);
      for (final label in ['Текст', 'Похожее']) {
        expect(find.text(label).hitTestable(), findsOneWidget);
        expect(
          tester.getBottomLeft(find.text(label)).dy,
          lessThanOrEqualTo(776),
        );
      }
    },
  );

  Finder feedback(String text) =>
      find.ancestor(of: find.text(text), matching: find.byType(MusicTapTarget));

  for (final mini in [false, true]) {
    testWidgets(
      'focus pause offers one-tap resume in ${mini ? 'mini' : 'full'} player',
      (tester) async {
        await mount(
          tester,
          size: const Size(360, 800),
          interrupted: true,
          mini: mini,
        );
        final play = mini
            ? find.byTooltip('Продолжить')
            : find.byType(FilledButton).first;
        if (!mini) {
          expect(find.text('Пауза: звук в другом приложении'), findsOneWidget);
        }
        await tester.tap(play);
        await tester.pumpAndSettle();
        expect(playback.commands.single, isA<Resume>());
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets('long title retains square artwork and artist secondary', (
    tester,
  ) async {
    await mount(tester, size: const Size(360, 800), longTitle: true);
    final title = tester.renderObject<RenderParagraph>(find.text(_longTitle));
    final art = tester.getSize(find.byKey(const ValueKey('player-art')));
    // Flutter's test font has wide square glyphs; this still catches oversized
    // title roles while retaining the complete real-world title.
    expect(title.size.height, lessThanOrEqualTo(130));
    expect(title.text.style?.fontSize, 20);
    // A compact cover makes room for text/related actions without truncating
    // the title. Very long titles must not reduce it to a tiny placeholder.
    expect(art.height, greaterThanOrEqualTo(128));
    expect(art.width, art.height);
    final artist = tester.renderObject<RenderParagraph>(
      find.text('Olivia Rodrigo'),
    );
    expect(artist.text.style?.color, MusicColors.textSecondary);
    expect(title.didExceedMaxLines, isFalse);
    final viewport = tester.getRect(find.byType(SingleChildScrollView).first);
    expect(
      tester.getRect(find.byKey(const ValueKey('player-more'))).top,
      lessThanOrEqualTo(viewport.bottom - 24),
      reason: 'The lower actions need a visible cue before scrolling',
    );
    expect(playback.commands, isEmpty);
  });

  testWidgets('seek times align to the full content width', (tester) async {
    await mount(tester, size: const Size(360, 800));
    final title = tester.getRect(find.text(_title));
    final elapsed = tester.getRect(find.text('0:37'));
    final duration = tester.getRect(find.text('2:57'));
    expect(elapsed.left, closeTo(title.left, 1));
    expect(duration.right, closeTo(title.right, 1));
  });

  for (final width in [320.0, 360.0]) {
    testWidgets('seek has a 48 dp touch target at width $width', (
      tester,
    ) async {
      await mount(tester, size: Size(width, 800));
      expect(
        tester.getSize(find.byKey(const ValueKey('player-seek'))).height,
        greaterThanOrEqualTo(48),
      );
    });

    for (final offset in [-23.0, 23.0]) {
      testWidgets('seek accepts drag $offset dp from axis at width $width', (
        tester,
      ) async {
        await mount(tester, size: Size(width, 800));
        final slider = tester.getRect(
          find.byKey(const ValueKey('player-seek')),
        );
        final start = slider.center + Offset(0, offset);
        await tester.dragFrom(start, const Offset(40, 0));
        await tester.pumpAndSettle();
        expect(playback.commands, hasLength(1));
        expect(playback.commands.single, isA<Seek>());
        expect(
          (playback.commands.single as Seek).position,
          greaterThan(const Duration(seconds: 37)),
        );
        expect(tester.takeException(), isNull);
      });
    }
  }

  testWidgets('primary transport is a light 72 dp circle', (tester) async {
    await mount(tester, size: const Size(360, 800));
    final play = find.byType(FilledButton).first;
    final material = tester.widget<Material>(
      find.descendant(of: play, matching: find.byType(Material)).first,
    );
    expect(tester.getSize(play), const Size.square(72));
    expect(material.color, MusicColors.text);
    expect(material.shape, isA<CircleBorder>());
    final ordered = [
      'Нравится',
      'В волну',
      'Не нравится',
    ].map((label) => tester.getCenter(feedback(label)).dx).toList();
    expect(ordered[0], lessThan(ordered[1]));
    expect(ordered[1], lessThan(ordered[2]));
  });

  testWidgets('mini player clips its surface and exposes a light 48 dp play', (
    tester,
  ) async {
    await mount(tester, size: const Size(360, 800), mini: true);
    final surface = tester
        .widgetList<Material>(find.byType(Material))
        .singleWhere((material) => material.color == MusicColors.surface2);
    expect(surface.borderRadius, BorderRadius.circular(16));
    expect(surface.clipBehavior, isNot(Clip.none));
    final play = find.byTooltip('Пауза');
    expect(tester.getSize(play), const Size.square(48));
    final playMaterial = tester.widget<Material>(
      find
          .descendant(
            of: find.byWidgetPredicate(
              (widget) => widget is IconButton && widget.tooltip == 'Пауза',
            ),
            matching: find.byType(Material),
          )
          .first,
    );
    expect(playMaterial.color, MusicColors.text);
    expect(tester.widget<Text>(find.text(_title)).style?.fontSize, 14);
    expect(
      tester.widget<Text>(find.text('Olivia Rodrigo')).style?.fontSize,
      12,
    );
    await tester.tap(find.byKey(const ValueKey('mini-open')));
    await tester.pumpAndSettle();
    expect(queues, 1);
    expect(playback.commands, isEmpty);
    await tester.tap(play);
    await tester.pumpAndSettle();
    expect(playback.commands.single, isA<Pause>());
  });

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
    (size: const Size(320, 720), scale: 1.3),
    (size: const Size(360, 800), scale: 1.3),
    (size: const Size(320, 640), scale: 2.0),
    (size: const Size(360, 800), scale: 2.0),
    (size: const Size(640, 360), scale: 1.0),
    (size: const Size(640, 360), scale: 1.3),
    (size: const Size(640, 360), scale: 2.0),
  ]) {
    testWidgets('large text and landscape keep scroll access at $scenario', (
      tester,
    ) async {
      await mount(
        tester,
        size: scenario.size,
        scale: scenario.scale,
        longTitle: true,
      );
      expect(tester.takeException(), isNull);
      for (final label in ['Нравится', 'В волну', 'Не нравится']) {
        final target = feedback(label);
        await tester.ensureVisible(target);
        await tester.pumpAndSettle();
        expect(target.hitTestable(), findsOneWidget);
        expect(tester.getSize(target).height, greaterThanOrEqualTo(48));
        expect(tester.getSize(target).width, greaterThanOrEqualTo(48));
      }
      await tester.tap(find.byTooltip('Открыть очередь'));
      await tester.pumpAndSettle();
      for (final label in ['Текст', 'Похожее']) {
        final target = find.text(label);
        await tester.ensureVisible(target);
        await tester.pumpAndSettle();
        await tester.tap(target);
        await tester.pumpAndSettle();
      }
      expect(queues, 1);
      expect(lyrics, 1);
      expect(related, 1);
      expect(tester.widget<Text>(find.text(_longTitle)).maxLines, isNull);
      await tester.tap(find.byTooltip('Действия трека'));
      await tester.pumpAndSettle();
      expect(find.text('Громкость'), findsOneWidget);
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    });
  }
}
