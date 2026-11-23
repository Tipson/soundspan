import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/design_system/design_system.dart';
import 'package:soundspan/features/home/home_controller.dart';
import 'package:soundspan/features/home/home_models.dart';
import 'package:soundspan/features/home/home_repository.dart';
import 'package:soundspan/features/home/mix_screen.dart';
import 'package:soundspan/features/library/library_models.dart';
import 'package:soundspan/features/settings/settings_screen.dart';

import '../support/collection_fixtures.dart';

Future<void> mount(
  WidgetTester tester,
  Widget child, {
  Size size = const Size(360, 720),
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
        data: MediaQuery.of(context)
            .copyWith(textScaler: TextScaler.linear(scale)),
        child: child!,
      ),
      home: child,
    ),
  );
  await tester.pumpAndSettle();
}

HomeController controller() => HomeController(
  repository: HomeRepository(
    authority: CollectionAuthority(),
    fence: collectionFence,
    transport: CollectionTransport((_, _) => const ApiResponse(200, {})),
  ),
  request: HomeRequest(
    localHour: 12,
    timezoneOffsetMinutes: 180,
    autoPlaylists: false,
    discovery: false,
  ),
);

MusicMix mix({String title = 'Olivia Rodrigo и похожее'}) => MusicMix(
  id: 'daily',
  title: title,
  description: 'Знакомое и новые находки',
  kind: MusicMixKind.daily,
  tracks: [
    Track(ref: LibraryTrackRef('one'), title: 'Первая песня', artist: 'Артист'),
    Track(
      ref: UnavailableTrackRef('tidal:two', reason: 'retired_provider'),
      title: 'Недоступная песня',
      artist: 'Артист',
    ),
    Track(
      ref: LibraryTrackRef('three'),
      title: 'Третья песня',
      artist: 'Артист',
    ),
  ],
);

void main() {
  testWidgets(
    'mix introduces the music before the middle of a compact screen',
    (tester) async {
      final home = controller();
      addTearDown(home.dispose);
      final requests = <CollectionPlaybackRequest>[];
      await mount(
        tester,
        MixScreen(controller: home, mix: mix(), onPlay: requests.add),
        size: const Size(360, 640),
      );
      expect(requests, isEmpty);
      expect(
        tester.getTopLeft(find.byKey(const ValueKey('mix-track-0'))).dy,
        lessThanOrEqualTo(360),
      );
      final cover = find.byType(Artwork).first;
      expect(tester.getSize(cover).width, lessThanOrEqualTo(112));
      await tester.tap(find.text('Слушать'));
      await tester.pump();
      expect(requests.single.tracks.map((track) => track.ref.identityKey), [
        'library:one',
        'library:three',
      ]);
      expect(requests.single.shuffle, isFalse);
      await tester.tap(find.byTooltip('Перемешать подборку'));
      await tester.pump();
      expect(requests.last.shuffle, isTrue);
      expect(tester.takeException(), isNull);
    },
  );

  for (final scale in [1.0, 2.0]) {
    testWidgets(
      'mix keeps the complete Russian title and actions at 320 scale $scale',
      (tester) async {
        final home = controller();
        addTearDown(home.dispose);
        const title =
            'Подборка с очень длинным русским названием для проверки переноса и доступности';
        var plays = 0;
        await mount(
          tester,
          MixScreen(
            controller: home,
            mix: mix(title: title),
            onPlay: (_) => plays++,
          ),
          size: const Size(320, 640),
          scale: scale,
        );
        final titleWidget = tester.widget<Text>(find.text(title));
        expect(titleWidget.maxLines, isNull);
        expect(titleWidget.overflow, isNot(TextOverflow.ellipsis));
        expect(
          titleWidget.style?.fontSize,
          SoundspanTheme.dark().textTheme.titleLarge?.fontSize,
        );
        await tester.ensureVisible(find.text('Слушать'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Слушать'));
        await tester.pump();
        expect(plays, 1);
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets(
    'settings starts with useful choices and keeps all destinations',
    (tester) async {
      final opened = <String>[];
      await mount(
        tester,
        SettingsScreen(
          onProfile: () => opened.add('Профиль'),
          onTaste: () => opened.add('Музыкальные вкусы'),
          onPlayback: () => opened.add('Воспроизведение'),
          onOffline: () => opened.add('Офлайн и загрузки'),
          onAccount: () => opened.add('Аккаунт и безопасность'),
          onHistory: () => opened.add('История прослушиваний'),
          onShares: () => opened.add('Мои ссылки'),
          onInbox: () => opened.add('Входящие'),
        ),
      );
      expect(
        tester.getTopLeft(find.text('Профиль')).dy,
        lessThanOrEqualTo(140),
      );
      for (final label in [
        'Профиль',
        'Музыкальные вкусы',
        'Воспроизведение',
        'Офлайн и загрузки',
        'История прослушиваний',
        'Аккаунт и безопасность',
        'Мои ссылки',
        'Входящие',
      ]) {
        await tester.scrollUntilVisible(
          find.text(label),
          200,
          scrollable: find.byType(Scrollable).first,
        );
        await tester.pumpAndSettle();
        await tester.tap(find.text(label));
        await tester.pump();
        expect(opened.last, label);
      }
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('settings remains scrollable at 320 with double-size text', (
    tester,
  ) async {
    var opened = 0;
    await mount(
      tester,
      SettingsScreen(
        onProfile: () {},
        onTaste: () {},
        onPlayback: () {},
        onOffline: () {},
        onAccount: () {},
        onHistory: () {},
        onInbox: () => opened++,
      ),
      size: const Size(320, 640),
      scale: 2,
    );
    await tester.scrollUntilVisible(
      find.text('Входящие'),
      240,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Входящие'));
    await tester.pump();
    expect(opened, 1);
    expect(tester.takeException(), isNull);
  });
}
