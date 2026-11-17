import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/design_system/design_system.dart';
import 'package:soundspan/features/home/home_controller.dart';
import 'package:soundspan/features/home/home_models.dart';
import 'package:soundspan/features/home/home_repository.dart';
import 'package:soundspan/features/home/home_screen.dart';
import 'package:soundspan/features/library/library_controller.dart';
import 'package:soundspan/features/library/library_models.dart';
import 'package:soundspan/features/library/library_repository.dart';
import 'package:soundspan/features/library/library_screen.dart';

import '../support/collection_fixtures.dart';
import '../support/wave_reporting_fixtures.dart' show waveDto, waveFeed;

Future<void> mount(
  WidgetTester tester,
  Widget child, {
  double width = 360,
  double scale = 1,
}) async {
  tester.view.physicalSize = Size(width, 760);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    MaterialApp(
      theme: SoundspanTheme.dark(),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context)
            .copyWith(textScaler: TextScaler.linear(scale)),
        child: child!,
      ),
      home: child,
    ),
  );
  await tester.pumpAndSettle();
}

HomeController homeController() => HomeController(
  repository: HomeRepository(
    authority: CollectionAuthority(),
    fence: collectionFence,
    transport: CollectionTransport(
      (request, _) => request.path == '/api/personalized/daily-mixes'
          ? ApiResponse(200, {
              'mixes': [
                for (final id in ['rock', 'jazz', 'indie'])
                  {
                    'key': id,
                    'title': 'Микс $id',
                    'description': 'Близкая музыка и открытия',
                    'generationId': 'daily-$id',
                    'tracks': [waveDto(id)],
                  },
              ],
            })
          : ApiResponse(200, waveFeed([])),
    ),
  ),
  request: HomeRequest(
    localHour: 8,
    timezoneOffsetMinutes: 180,
    autoPlaylists: false,
    discovery: false,
  ),
);

void main() {
  for (final scale in [2.0, 3.0]) {
    testWidgets(
      'Home unavailable recording fits at 320dp scale $scale and cannot play',
      (tester) async {
        const longTitle =
            'Очень длинное название недоступной музыкальной записи с полным именем исполнителя';
        final unavailable = <String, Object?>{
          ...waveDto('missing'),
          'id': 'archive:missing',
          'source': 'archive',
          'streamSource': 'archive',
          'provider': <String, Object?>{},
          'title': longTitle,
        };
        final controller = HomeController(
          repository: HomeRepository(
            authority: CollectionAuthority(),
            fence: collectionFence,
            transport: CollectionTransport((request, _) {
              if (request.path == '/api/personalized/daily-mixes') {
                return const ApiResponse(200, {'mixes': []});
              }
              return ApiResponse(200, {
                ...waveFeed([]),
                'shelves': {
                  'listenAgain': [],
                  'quickPicks': [],
                  'discovery': request.query['surface'] == 'home'
                      ? [unavailable, waveDto('available')]
                      : [],
                },
              });
            }),
          ),
          request: HomeRequest(
            localHour: 8,
            timezoneOffsetMinutes: 180,
            autoPlaylists: false,
            discovery: false,
          ),
        );
        await controller.refresh();
        CollectionPlaybackRequest? played;
        await mount(
          tester,
          HomeScreen(
            controller: controller,
            autoLoad: false,
            onOpenWave: () {},
            onOpenMix: (_) {},
            onPlay: (request) => played = request,
          ),
          width: 320,
          scale: scale,
        );
        final shelf = find.byKey(const ValueKey('home-shelf-discovery'));
        await tester.scrollUntilVisible(
          shelf,
          400,
          scrollable: find.byType(Scrollable).first,
        );
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        await tester.ensureVisible(find.text(longTitle));
        await tester.tap(find.text(longTitle));
        await tester.pump();
        expect(played, isNull);
        final reason = tester.renderObject<RenderParagraph>(
          find.text('Запись недоступна'),
        );
        final fullReason = TextPainter(
          text: reason.text,
          textDirection: reason.textDirection,
          textScaler: reason.textScaler,
        )..layout(maxWidth: reason.size.width);
        expect(reason.size.height, greaterThanOrEqualTo(fullReason.height));
        fullReason.dispose();
        expect(
          tester.getBottomLeft(find.text('Запись недоступна')).dy,
          lessThanOrEqualTo(tester.getBottomLeft(shelf).dy),
        );
        await tester.ensureVisible(find.text('available'));
        await tester.tap(find.text('available'));
        await tester.pump();
        expect(played?.tracks.map((track) => track.title), ['available']);
        expect(played?.startIndex, 0);
        expect(played?.fence, collectionFence);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        controller.dispose();
      },
    );
  }

  for (final scale in [2.0, 3.0]) {
    testWidgets(
      'Home hero paints its full title at 320dp and text scale $scale',
      (tester) async {
        final controller = homeController();
        await mount(
          tester,
          HomeScreen(
            controller: controller,
            autoLoad: false,
            onOpenWave: () {},
            onOpenMix: (_) {},
            onPlay: (_) {},
          ),
          width: 320,
          scale: scale,
        );
        final paragraph = tester.renderObject<RenderParagraph>(
          find.text('Ваша волна'),
        );
        final fullTitle = TextPainter(
          text: paragraph.text,
          textDirection: paragraph.textDirection,
          textScaler: paragraph.textScaler,
          locale: paragraph.locale,
          textHeightBehavior: paragraph.textHeightBehavior,
        )..layout(maxWidth: paragraph.size.width);
        expect(paragraph.size.height, greaterThanOrEqualTo(fullTitle.height));
        fullTitle.dispose();
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        controller.dispose();
      },
    );
  }

  testWidgets(
    'Home navigation remains accessible at 320dp with large text and all actions',
    (tester) async {
      final controller = homeController();
      await controller.refresh();
      var starts = 0, opens = 0, settings = 0, plays = 0;
      await mount(
        tester,
        HomeScreen(
          controller: controller,
          autoLoad: false,
          onOpenWave: () => opens++,
          onOpenMix: (_) {},
          onPlay: (_) => plays++,
          onStartWave: () => starts++,
          onConfigureWave: () => settings++,
        ),
        width: 320,
        scale: 2,
      );
      expect(tester.takeException(), isNull);
      await tester.ensureVisible(find.text('Открыть волну'));
      await tester.tap(find.text('Открыть волну'));
      await tester.pump();
      await tester.ensureVisible(find.byTooltip('Настроить волну'));
      await tester.tap(find.byTooltip('Настроить волну'));
      await tester.pump();
      expect([starts, opens, settings, plays], [0, 1, 1, 0]);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    },
  );

  testWidgets(
    'Home keeps listening and the daily shelf in the first viewport',
    (tester) async {
      final controller = homeController();
      await controller.refresh();
      var starts = 0, opens = 0, settings = 0;
      await mount(
        tester,
        HomeScreen(
          controller: controller,
          autoLoad: false,
          onOpenWave: () => opens++,
          onOpenMix: (_) {},
          onPlay: (_) {},
          onStartWave: () => starts++,
          onConfigureWave: () => settings++,
        ),
      );
      final shelfTop = tester.getTopLeft(find.text('Миксы для вас')).dy;
      expect(shelfTop, lessThan(330));
      expect(
        tester.getBottomLeft(find.text('Слушать волну')).dy,
        lessThan(300),
      );
      await tester.tap(find.text('Слушать волну'));
      await tester.pump();
      await tester.tap(find.text('Открыть волну'));
      await tester.pump();
      await tester.tap(find.byTooltip('Настроить волну'));
      await tester.pump();
      expect([starts, opens, settings], [1, 1, 1]);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    },
  );

  for (final width in [360.0, 430.0]) {
    testWidgets(
      'daily shelf reveals a next mix and opens its exact identity at $width',
      (tester) async {
        final controller = homeController();
        await controller.refresh();
        MusicMix? opened;
        var plays = 0;
        await mount(
          tester,
          HomeScreen(
            controller: controller,
            autoLoad: false,
            onOpenWave: () {},
            onOpenMix: (mix) => opened = mix,
            onPlay: (_) => plays++,
          ),
          width: width,
        );
        final first = find.widgetWithText(MusicCard, 'Микс rock');
        final third = find.widgetWithText(MusicCard, 'Микс indie');
        expect(tester.getSize(first).width, inInclusiveRange(132, 148));
        expect(tester.getTopLeft(third).dx, lessThanOrEqualTo(width - 32));
        await tester.ensureVisible(find.text('Микс rock'));
        await tester.pumpAndSettle();
        final horizontal = find
            .ancestor(of: first, matching: find.byType(SingleChildScrollView))
            .first;
        await tester.drag(horizontal, const Offset(-240, 0));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Микс indie'));
        await tester.pump();
        expect(opened?.id, 'indie');
        expect(plays, 0);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        controller.dispose();
      },
    );
  }

  testWidgets(
    'Library keeps quick destinations and playlists near its header',
    (tester) async {
      final controller = LibraryController(
        repository: LibraryRepository(
          authority: CollectionAuthority(),
          fence: collectionFence,
          transport: CollectionTransport(
            (request, _) => request.path == '/api/playlists'
                ? const ApiResponse(200, [
                    {
                      'id': 'private-exact',
                      'name': 'Мой плейлист',
                      'trackCount': 3,
                      'isOwner': true,
                    },
                  ])
                : const ApiResponse(200, {'items': [], 'total': 0}),
          ),
        ),
      );
      await controller.refresh();
      var liked = 0, downloads = 0, created = 0;
      String? opened;
      await mount(
        tester,
        LibraryScreen(
          controller: controller,
          autoLoad: false,
          onOpenLiked: () => liked++,
          onOpenDownloads: () => downloads++,
          onCreatePlaylist: () => created++,
          onOpenPlaylist: (id) => opened = id,
        ),
      );
      expect(tester.getTopLeft(find.text('Мой плейлист')).dy, lessThan(360));
      expect(
        tester
            .getSize(
              find
                  .ancestor(
                    of: find.text('Любимое'),
                    matching: find.byType(MusicTapTarget),
                  )
                  .first,
            )
            .height,
        lessThanOrEqualTo(104),
      );
      expect(
        tester.getTopLeft(find.text('Исполнители')).dy,
        tester.getTopLeft(find.text('Всё')).dy,
      );
      for (final text in ['Любимое', 'Загрузки']) {
        await tester.tap(find.text(text));
        await tester.pump();
      }
      expect(find.text('Создать плейлист'), findsNothing);
      await tester.tap(find.byTooltip('Действия с коллекцией'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Создать плейлист'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Мой плейлист'));
      await tester.pump();
      expect([liked, downloads, created], [1, 1, 1]);
      expect(opened, 'private-exact');
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    },
  );
}
