import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/design_system/design_system.dart';

const longTitle =
    'Очень длинное название музыкальной композиции, которое сохраняет точную идентичность записи и полностью доступно читателю экрана';
const track = Track(
  ref: LibraryTrackRef('recording-42'),
  title: longTitle,
  artist: 'Исполнитель с очень длинным русским названием коллектива',
);

Future<void> mount(
  WidgetTester tester,
  Widget child, {
  double width = 390,
  double scale = 1,
  bool reduced = false,
}) async {
  tester.view.physicalSize = Size(width, 900);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);
  await tester.pumpWidget(
    MaterialApp(
      theme: SoundspanTheme.dark(),
      home: MediaQuery(
        data: MediaQueryData(
          size: Size(width, 900),
          textScaler: TextScaler.linear(scale),
          disableAnimations: reduced,
        ),
        child: Scaffold(body: child),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  for (final width in [320.0, 390.0, 430.0]) {
    for (final scale in [1.0, 2.0]) {
      testWidgets('long Russian rows and recovery fit $width at scale $scale', (
        tester,
      ) async {
        var plays = 0;
        var menus = 0;
        var retries = 0;
        await mount(
          tester,
          SingleChildScrollView(
            child: Column(
              children: [
                TrackRow(
                  track: track,
                  onPlay: () => plays++,
                  onMore: () => menus++,
                ),
                MusicErrorState(
                  title: 'Не удалось загрузить вашу музыкальную библиотеку',
                  message: longTitle,
                  onRetry: () => retries++,
                ),
              ],
            ),
          ),
          width: width,
          scale: scale,
        );
        expect(tester.takeException(), isNull);
        await tester.tap(
          find.byKey(const ValueKey('track-play-library:recording-42')),
        );
        await tester.tap(find.byTooltip('Действия с треком «$longTitle»'));
        await tester.ensureVisible(find.text('Повторить'));
        await tester.tap(find.text('Повторить'));
        expect([plays, menus, retries], [1, 1, 1]);
      });
    }
  }

  testWidgets('action sheet Back cancels without mutation', (tester) async {
    var calls = 0;
    await mount(
      tester,
      Builder(
        builder: (context) => TextButton(
          onPressed: () => MusicActionSheet.show(context, [
            MusicAction(
              id: 'like',
              label: 'Нравится',
              icon: Icons.favorite_border,
              onSelected: () => calls++,
            ),
          ], title: longTitle),
          child: const Text('Открыть'),
        ),
      ),
    );
    await tester.tap(find.text('Открыть'));
    await tester.pumpAndSettle();
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.text('Нравится'), findsNothing);
    expect(calls, 0);
  });

  testWidgets('sheet reports disabled reason and executes chosen action once', (
    tester,
  ) async {
    var calls = 0;
    await mount(
      tester,
      Builder(
        builder: (context) => TextButton(
          onPressed: () => MusicActionSheet.show(context, [
            const MusicAction(
              id: 'download',
              label: 'Скачать на устройство',
              icon: Icons.download,
              disabledReason: 'Нужна сеть',
            ),
            MusicAction(
              id: 'like',
              label: 'Нравится',
              icon: Icons.favorite_border,
              onSelected: () => calls++,
            ),
          ], title: longTitle),
          child: const Text('Открыть'),
        ),
      ),
      width: 320,
      scale: 2,
    );
    await tester.tap(find.text('Открыть'));
    await tester.pumpAndSettle();
    expect(find.text('Нужна сеть'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.ensureVisible(find.text('Нравится'));
    await tester.tap(find.text('Нравится'));
    await tester.pumpAndSettle();
    expect(calls, 1);
    expect(find.text('Нужна сеть'), findsNothing);
  });

  testWidgets('unavailable track explains playback and keeps actions', (
    tester,
  ) async {
    var calls = 0;
    await mount(
      tester,
      TrackRow(
        track: const Track(
          ref: UnavailableTrackRef('missing', reason: 'Запись удалена'),
          title: longTitle,
          artist: 'Исполнитель',
          unavailableReason: 'Запись удалена',
        ),
        onMore: () => calls++,
      ),
      width: 320,
      scale: 2,
    );
    expect(find.text('Запись удалена'), findsOneWidget);
    await tester.tap(find.byTooltip('Действия с треком «$longTitle»'));
    expect(calls, 1);
    expect(tester.takeException(), isNull);
  });

  testWidgets('artwork fallback is stable and motion respects system', (
    tester,
  ) async {
    await mount(
      tester,
      Builder(
        builder: (context) => Column(
          children: [
            const Artwork(size: 48),
            Text(
              '${MusicMotion.duration(context, MusicMotion.navigation).inMilliseconds}',
            ),
          ],
        ),
      ),
      reduced: true,
    );
    expect(find.byIcon(Icons.music_note_rounded), findsOneWidget);
    expect(find.text('0'), findsOneWidget);
  });

  testWidgets('theme owns selection, focus and minimum touch size', (
    tester,
  ) async {
    final theme = SoundspanTheme.dark();
    expect(theme.colorScheme.primary, MusicColors.primary);
    expect(theme.textSelectionTheme.cursorColor, MusicColors.primary);
    await mount(
      tester,
      MusicIconButton(
        label: 'Настроить волну',
        icon: Icons.tune,
        onPressed: () {},
      ),
    );
    final size = tester.getSize(find.byType(IconButton));
    expect(size.width, greaterThanOrEqualTo(48));
    expect(size.height, greaterThanOrEqualTo(48));
  });

  testWidgets('large screen heading grows into scroll content above IME', (
    tester,
  ) async {
    await mount(
      tester,
      const ScreenScaffold(
        title: 'Музыкальная библиотека',
        child: Text('Последний раздел'),
      ),
      width: 320,
      scale: 2,
    );
    expect(
      find.ancestor(
        of: find.text('Музыкальная библиотека'),
        matching: find.byType(SingleChildScrollView),
      ),
      findsOneWidget,
    );
    expect(
      tester.getSize(find.text('Музыкальная библиотека')).height,
      greaterThan(56),
    );
    expect(tester.takeException(), isNull);
    await tester.ensureVisible(find.text('Последний раздел'));
    expect(find.text('Последний раздел'), findsOneWidget);
  });

  testWidgets(
    'card, shelf, primary, empty, and icon controls invoke callbacks once',
    (tester) async {
      final calls = List.filled(6, 0);
      await mount(
        tester,
        SingleChildScrollView(
          child: Column(
            children: [
              MusicButton(
                label: 'Слушать выбранную музыкальную подборку',
                icon: Icons.play_arrow,
                onPressed: () => calls[0]++,
              ),
              MusicShelf(
                title: 'Миксы для вас',
                onShowAll: () => calls[1]++,
                children: [
                  MusicCard(
                    title: 'Точный микс',
                    subtitle: 'Настоящий состав',
                    width: 132,
                    onOpen: () => calls[2]++,
                    onMore: () => calls[3]++,
                  ),
                ],
              ),
              MusicEmptyState(
                title: 'Пока нет плейлистов',
                message: 'Соберите свою музыку',
                actionLabel: 'Создать плейлист',
                onAction: () => calls[4]++,
              ),
              MusicIconButton(
                label: 'Настроить волну',
                icon: Icons.tune,
                onPressed: () => calls[5]++,
              ),
            ],
          ),
        ),
        width: 320,
        scale: 2,
      );
      for (final finder in [
        find.text('Слушать выбранную музыкальную подборку'),
        find.text('Показать все'),
        find.text('Точный микс'),
        find.byTooltip('Действия с подборкой «Точный микс»'),
        find.text('Создать плейлист'),
        find.byTooltip('Настроить волну'),
      ]) {
        await tester.ensureVisible(finder);
        await tester.tap(finder);
      }
      expect(calls, [1, 1, 1, 1, 1, 1]);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('busy and disabled controls communicate and do not execute', (
    tester,
  ) async {
    var calls = 0;
    final semantics = tester.ensureSemantics();
    await mount(
      tester,
      Column(
        children: [
          MusicButton(
            label: 'Сохраняем…',
            onPressed: () => calls++,
            busy: true,
          ),
          const MusicButton(
            label: 'Скачать',
            onPressed: null,
            disabledReason: 'Нужна сеть',
          ),
        ],
      ),
    );
    await tester.tap(find.text('Сохраняем…'));
    await tester.tap(find.text('Скачать'));
    expect(calls, 0);
    expect(find.text('Нужна сеть'), findsOneWidget);
    expect(tester.getSemantics(find.text('Сохраняем…')).value, 'Выполняется');
    semantics.dispose();
  });
}
