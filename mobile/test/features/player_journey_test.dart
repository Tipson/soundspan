import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/semantics.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/features/likes/likes_models.dart';
import 'package:soundspan/playback/queue_coordinator.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/features/likes/preference_controller.dart';
import 'package:soundspan/features/player/player_controller.dart';
import 'package:soundspan/features/player/mini_player.dart';
import 'package:soundspan/features/player/full_player_screen.dart';
import 'package:soundspan/features/player/queue_screen.dart';
import 'package:soundspan/design_system/theme.dart';
import 'package:soundspan/design_system/artwork.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/playback/playback_controller.dart';

import '../support/collection_fixtures.dart';
import '../playback/queue_coordinator_test.dart' show FakeEngine;

class JourneyPlayback extends CollectionPlayback {
  JourneyPlayback(super.value);
  final updates = StreamController<QueueSnapshot>.broadcast(sync: true);
  @override
  Stream<QueueSnapshot> get snapshots => updates.stream;
  void publish(QueueSnapshot next) {
    value = next;
    updates.add(next);
  }
}

class AdmissionAuthority extends CollectionAuthority {
  Completer<void>? gate;
  @override
  Future<void> assertCurrent(SessionFence fence) async {
    await gate?.future;
    await super.assertCurrent(fence);
  }
}

void main() {
  late AdmissionAuthority authority;
  late JourneyPlayback playback;
  late PreferenceController preferences;
  late PlayerController controller;
  late CollectionTransport transport;
  final entries = [
    for (final id in ['a', 'b', 'c'])
      QueueEntry(
        entryId: id,
        track: collectionTrack(1),
        context: const PlayContext(surface: PlaySurface.playlist),
      ),
  ];
  QueueSnapshot state({
    String current = 'b',
    int lineage = 1,
    int generation = 1,
    bool playing = false,
    bool shuffle = false,
    double volume = 1,
    List<String> order = const ['a', 'b', 'c'],
  }) => QueueSnapshot(
    entries: entries,
    effectiveOrder: order,
    currentEntryId: current,
    fence: collectionFence,
    lineage: lineage,
    generation: generation,
    position: const Duration(seconds: 37),
    duration: const Duration(seconds: 180),
    bufferedPosition: const Duration(seconds: 70),
    playingIntent: playing,
    shuffle: shuffle,
    volume: volume,
  );
  setUp(() {
    authority = AdmissionAuthority();
    playback = JourneyPlayback(state())..moveOnNext = false;
    transport = CollectionTransport(
      (request, _) => preferenceResponse(
        'local-1',
        (request.body as Map?)?['signal'] as String? ?? 'clear',
      ),
    );
    preferences = PreferenceController(
      transport: transport,
      authority: authority,
      fence: collectionFence,
      playback: playback,
    );
    controller = PlayerController(
      playback: playback,
      authority: authority,
      fence: collectionFence,
      preferences: preferences,
    );
  });
  tearDown(() async {
    controller.dispose();
    preferences.dispose();
    await playback.updates.close();
    await authority.updates.close();
  });
  testWidgets(
    'single-item queue has no idle reorder action but editing can finish',
    (tester) async {
      QueueSnapshot queued(int count) => QueueSnapshot(
        entries: entries.take(count),
        effectiveOrder: entries.take(count).map((e) => e.entryId),
        currentEntryId: 'a',
        fence: collectionFence,
        lineage: count,
      );
      playback.value = queued(1);
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: QueueScreen(controller: controller),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('1 позиция · Ваша очередь'), findsOneWidget);
      expect(find.byTooltip('Изменить порядок'), findsNothing);
      playback.publish(queued(2));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Изменить порядок'));
      await tester.pumpAndSettle();
      playback.publish(queued(1));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Готово'));
      await tester.pumpAndSettle();
      expect(find.byTooltip('Изменить порядок'), findsNothing);
      expect(playback.commands, isEmpty);
      expect(tester.takeException(), isNull);
    },
  );
  test(
    'transport dispatches exact commands without autoplay on mount',
    () async {
      expect(playback.commands, isEmpty);
      await controller.togglePlayback();
      await controller.previous();
      await controller.next();
      await controller.seek(const Duration(seconds: 65));
      await controller.setVolume(.4);
      await controller.toggleMute();
      await controller.toggleShuffle();
      await controller.cycleRepeat();
      expect(playback.commands.map((c) => c.runtimeType), [
        Resume,
        Previous,
        Next,
        Seek,
        SetVolume,
        SetVolume,
        SetShuffle,
        SetRepeat,
      ]);
      expect((playback.commands[3] as Seek).position.inSeconds, 65);
      expect((playback.commands[4] as SetVolume).volume, .4);
      expect((playback.commands[5] as SetVolume).volume, 0);
      expect((playback.commands[6] as SetShuffle).enabled, true);
      expect((playback.commands[7] as SetRepeat).repeat, QueueRepeat.all);
    },
  );
  test(
    'duplicate rows address occurrence and reorder keeps service position',
    () async {
      await controller.playEntry('c');
      await controller.remove('a');
      await controller.reorder(['c', 'b', 'a']);
      expect((playback.commands[0] as PlayEntry).entryId, 'c');
      expect((playback.commands[1] as Remove).entryId, 'a');
      expect((playback.commands[2] as Reorder).entryIds, ['c', 'b', 'a']);
      expect(playback.snapshot.currentEntryId, 'b');
      expect(playback.snapshot.position.inSeconds, 37);
    },
  );
  test('late admission cannot affect replacement queue or new owner', () async {
    authority.gate = Completer<void>();
    final action = controller.remove('a');
    playback.publish(state(lineage: 2));
    authority.gate!.complete();
    await action;
    expect(playback.commands, isEmpty);
    authority.switchOwner();
    await controller.togglePlayback();
    expect(playback.commands, isEmpty);
    expect(controller.snapshot.entries, isEmpty);
  });
  test('mute restores the observed volume rather than full gain', () async {
    playback.publish(state(volume: .35));
    await controller.toggleMute();
    playback.publish(state(volume: 0));
    await controller.toggleMute();
    expect(playback.commands.whereType<SetVolume>().map((c) => c.volume), [
      0,
      .35,
    ]);
  });
  test(
    'listen next rejects current occurrence changed during admission',
    () async {
      authority.gate = Completer<void>();
      final target = controller.captureQueue()!;
      final task = controller.playNext('a', target: target);
      playback.publish(state(current: 'c', generation: 2));
      authority.gate!.complete();
      await task;
      expect(playback.commands, isEmpty);
    },
  );
  test(
    'shared likes toggle and dislike uses one guarded service Next',
    () async {
      await Future<void>.delayed(Duration.zero);
      await controller.feedback(PreferenceSignal.like);
      expect(
        preferences.current(entries.first.track.ref).signal,
        PreferenceSignal.like,
      );
      await controller.feedback(PreferenceSignal.like);
      expect(
        preferences.current(entries.first.track.ref).signal,
        PreferenceSignal.clear,
      );
      await controller.feedback(PreferenceSignal.dislike);
      expect(playback.commands.whereType<Next>().single.expectedEntryId, 'b');
      expect(
        transport.requests
            .where((r) => r.method == ApiMethod.post)
            .map((r) => (r.body as Map)['signal']),
        ['thumbs_up', 'clear', 'thumbs_down'],
      );
    },
  );
  test(
    'captured callback guard survives await and rejects new track or owner',
    () async {
      final wait = Completer<void>();
      var mutations = 0;
      final pending = controller.invoke((target) async {
        await wait.future;
        await target.assertCurrent();
        mutations++;
      });
      await Future<void>.delayed(Duration.zero);
      playback.publish(state(current: 'c', generation: 2));
      wait.complete();
      await pending;
      expect(mutations, 0);
      expect(controller.failure?.code, 'stale_player_action');
      final old = controller.captureTrack()!;
      authority.switchOwner();
      expect(old.isCurrent, false);
      await expectLater(old.assertCurrent(), throwsA(isA<AppFailure>()));
    },
  );
  test(
    'service reorder of current occurrence preserves real audio and position',
    () async {
      final engine = FakeEngine();
      final queue = QueueCoordinator(
        authority: authority,
        engine: engine,
        prepare: (entry, fence) async => PreparedAudio(
          uri: Uri.parse('http://127.0.0.1/a'),
          revoke: () async {},
        ),
      );
      final ui = PlayerController(
        playback: queue,
        authority: authority,
        fence: collectionFence,
        preferences: preferences,
      );
      await queue.dispatch(
        ReplaceQueue(
          entries,
          fence: collectionFence,
          initialEntryId: 'b',
          play: false,
        ),
      );
      engine.emit(position: const Duration(seconds: 37), playing: false);
      await ui.reorder(['c', 'b', 'a']);
      expect(queue.snapshot.currentEntryId, 'b');
      expect(queue.snapshot.position.inSeconds, 37);
      expect(engine.loaded.length, 1);
      await ui.remove('b');
      expect(queue.snapshot.currentEntryId, 'a');
      ui.dispose();
      await queue.dispose();
    },
  );
  Future<void> mount(
    WidgetTester tester,
    Widget child, {
    double width = 390,
    double height = 844,
    double scale = 1,
  }) async {
    tester.view.physicalSize = Size(width, height);
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

  testWidgets('mini exposes quick like and opens full without autoplay', (
    tester,
  ) async {
    var opens = 0;
    await mount(
      tester,
      Scaffold(
        body: MiniPlayer(controller: controller, onOpen: () => opens++),
      ),
    );
    expect(find.byTooltip('Нравится'), findsOneWidget);
    await tester.tap(find.byTooltip('Продолжить'));
    await tester.pumpAndSettle();
    expect(playback.commands.single, isA<Resume>());
    await tester.tap(find.byKey(const ValueKey('mini-open')));
    expect(opens, 1);
  });
  testWidgets('full has one feedback row and root overflow above art', (
    tester,
  ) async {
    await mount(tester, FullPlayerScreen(controller: controller));
    expect(find.text('Нравится'), findsOneWidget);
    expect(find.text('Не нравится'), findsOneWidget);
    expect(
      tester.getTopLeft(find.byTooltip('Действия трека')).dy,
      lessThan(tester.getTopLeft(find.byKey(const ValueKey('player-art'))).dy),
    );
    await tester.tap(find.byTooltip('Действия трека'));
    await tester.pumpAndSettle();
    expect(find.text('Громкость'), findsOneWidget);
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(playback.commands, isEmpty);
    expect(find.text('Сейчас играет'), findsOneWidget);
  });
  testWidgets('queue exact duplicate removal and cancelled clear', (
    tester,
  ) async {
    await mount(tester, QueueScreen(controller: controller));
    await tester.tap(find.byKey(const ValueKey('entry-actions-c')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Удалить из очереди'));
    await tester.pumpAndSettle();
    expect((playback.commands.single as Remove).entryId, 'c');
    await tester.tap(find.byTooltip('Действия очереди'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Очистить очередь'));
    await tester.pumpAndSettle();
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(playback.commands.length, 1);
  });
  testWidgets(
    'seek previews until release and old drag never seeks new track',
    (tester) async {
      await mount(tester, FullPlayerScreen(controller: controller));
      var slider = tester.widget<Slider>(
        find.byKey(const ValueKey('player-seek')),
      );
      slider.onChangeStart!(50000);
      slider.onChanged!(50000);
      await tester.pump();
      expect(playback.commands, isEmpty);
      slider = tester.widget<Slider>(find.byKey(const ValueKey('player-seek')));
      slider.onChangeEnd!(50000);
      await tester.pumpAndSettle();
      expect((playback.commands.single as Seek).position.inMilliseconds, 50000);
      slider.onChangeStart!(60000);
      slider.onChanged!(60000);
      playback.publish(state(current: 'c', generation: 2));
      await tester.pump();
      slider.onChangeEnd!(60000);
      await tester.pumpAndSettle();
      expect(playback.commands.length, 1);
    },
  );
  testWidgets('volume preview commits once on release', (tester) async {
    await mount(tester, FullPlayerScreen(controller: controller));
    await tester.tap(find.byTooltip('Действия трека'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Громкость'));
    await tester.pumpAndSettle();
    final slider = tester.widget<Slider>(find.byType(Slider).last);
    slider.onChanged!(.4);
    await tester.pump();
    expect(playback.commands, isEmpty);
    tester.widget<Slider>(find.byType(Slider).last).onChangeEnd!(.4);
    await tester.pumpAndSettle();
    expect((playback.commands.single as SetVolume).volume, .4);
  });
  testWidgets('accessible seek advances exactly ten seconds', (tester) async {
    final semantics = tester.ensureSemantics();

    await mount(tester, FullPlayerScreen(controller: controller));
    final node = tester.getSemantics(
      find.byKey(const ValueKey('player-seek-semantics')),
    );
    tester.binding.rootPipelineOwner.visitChildren((owner) {
      owner.semanticsOwner?.performAction(node.id, SemanticsAction.increase);
    });
    await tester.pumpAndSettle();
    expect((playback.commands.single as Seek).position.inSeconds, 47);
    semantics.dispose();
  });
  testWidgets(
    'busy Back remains available and hidden capabilities have no buttons',
    (tester) async {
      var collapses = 0;
      await mount(
        tester,
        FullPlayerScreen(controller: controller, onCollapse: () => collapses++),
      );
      final wait = Completer<void>();
      final task = controller.invoke((_) => wait.future);
      await tester.pump();
      expect(controller.busy, true);
      await tester.tap(find.byTooltip('Свернуть плеер'));
      expect(collapses, 1);
      expect(find.text('В волну'), findsNothing);
      await tester.tap(find.byTooltip('Действия трека'));
      await tester.pumpAndSettle();
      expect(find.text('Скачать на устройство'), findsNothing);
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(playback.commands, isEmpty);
      wait.complete();
      await task;
    },
  );
  testWidgets('old queue sheet cannot delete from replacement queue', (
    tester,
  ) async {
    await mount(tester, QueueScreen(controller: controller));
    await tester.tap(find.byKey(const ValueKey('entry-actions-c')));
    await tester.pumpAndSettle();
    playback.publish(state(lineage: 2));
    await tester.pump();
    await tester.tap(find.text('Удалить из очереди'));
    await tester.pumpAndSettle();
    expect(playback.commands, isEmpty);
  });
  testWidgets(
    '1001 queue positions mount only viewport and ignore position ticks',
    (tester) async {
      final many = [
        for (var i = 0; i < 1001; i++)
          QueueEntry(
            entryId: 'e$i',
            track: Track(
              ref: collectionTrack(i).ref,
              title: 'Песня $i',
              artist: 'Исполнитель',
            ),
            context: const PlayContext(surface: PlaySurface.playlist),
          ),
      ];
      QueueSnapshot large({
        Duration position = Duration.zero,
        String current = 'e0',
      }) => QueueSnapshot(
        entries: many,
        effectiveOrder: many.map((e) => e.entryId),
        currentEntryId: current,
        fence: collectionFence,
        position: position,
      );
      playback.publish(large());
      await mount(tester, QueueScreen(controller: controller));
      expect(find.byType(Artwork).evaluate().length, lessThan(100));
      final initialArtwork = tester.widget<Artwork>(find.byType(Artwork).first);
      playback.publish(large(position: const Duration(seconds: 37)));
      await tester.pump();
      expect(
        identical(
          initialArtwork,
          tester.widget<Artwork>(find.byType(Artwork).first),
        ),
        true,
        reason: 'Position ticks do not rebuild the queue projection.',
      );
      expect(controller.snapshot.entries.length, 1001);
      playback.publish(large(current: 'e800'));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('e800')), findsOneWidget);
      expect(find.byType(Artwork).evaluate().length, lessThan(100));
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'lazy queue scroll and drag a noninitial occurrence without truncation',
    (tester) async {
      final many = [
        for (var i = 0; i < 1001; i++)
          QueueEntry(
            entryId: 'e$i',
            track: Track(
              ref: collectionTrack(i).ref,
              title: 'Песня $i',
              artist: 'Исполнитель',
            ),
            context: const PlayContext(surface: PlaySurface.playlist),
          ),
      ];
      playback.publish(
        QueueSnapshot(
          entries: many,
          effectiveOrder: many.map((e) => e.entryId),
          currentEntryId: 'e0',
          fence: collectionFence,
        ),
      );
      await mount(tester, QueueScreen(controller: controller));
      await tester.tap(find.byTooltip('Изменить порядок'));
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.byKey(const ValueKey('e80')),
        500,
        scrollable: find.byType(Scrollable).first,
        maxScrolls: 50,
      );
      await tester.pumpAndSettle();
      expect(find.byType(Artwork).evaluate().length, lessThan(100));
      final handle = find.descendant(
        of: find.byKey(const ValueKey('e80')),
        matching: find.byType(ReorderableDragStartListener),
      );
      await tester.ensureVisible(handle);
      final gesture = await tester.startGesture(tester.getCenter(handle));
      await tester.pump(const Duration(milliseconds: 200));
      await gesture.moveBy(const Offset(0, 10));
      await tester.pump();
      await gesture.moveBy(const Offset(0, 180));
      await tester.pump(const Duration(milliseconds: 600));
      await gesture.up();
      await tester.pumpAndSettle();
      final reorder = playback.commands.whereType<Reorder>().single;
      expect(reorder.entryIds.length, 1001);
      expect(reorder.entryIds.toSet().length, 1001);
      expect(reorder.entryIds.indexOf('e80'), greaterThan(80));
      expect(reorder.entryIds.first, 'e0');
    },
  );
  testWidgets(
    'old drag cannot reorder replacement queue reusing occurrence IDs',
    (tester) async {
      await mount(tester, QueueScreen(controller: controller));
      await tester.tap(find.byTooltip('Изменить порядок'));
      await tester.pumpAndSettle();
      tester
          .widget<SliverReorderableList>(find.byType(SliverReorderableList))
          .onReorderStart!(0);
      playback.publish(state(lineage: 2));
      await tester.pump();
      tester
          .widget<SliverReorderableList>(find.byType(SliverReorderableList))
          .onReorderItem!(0, 2);
      await tester.pumpAndSettle();
      expect(playback.commands, isEmpty);
    },
  );
  testWidgets(
    'unpainted queue replacement cannot retarget an old drag handle',
    (tester) async {
      await mount(tester, QueueScreen(controller: controller));
      await tester.tap(find.byTooltip('Изменить порядок'));
      await tester.pumpAndSettle();
      final oldList = tester.widget<SliverReorderableList>(
        find.byType(SliverReorderableList),
      );
      playback.publish(state(lineage: 2));
      oldList.onReorderStart!(1);
      oldList.onReorderItem!(1, 2);
      await tester.pumpAndSettle();
      expect(playback.commands, isEmpty);
    },
  );
  testWidgets('unknown duration disables seek and retry is honest', (
    tester,
  ) async {
    playback.publish(
      QueueSnapshot(
        entries: entries,
        effectiveOrder: ['a', 'b', 'c'],
        currentEntryId: 'b',
        fence: collectionFence,
        processing: PlaybackProcessing.failed,
        failure: const AppFailure(
          code: 'test',
          message: 'Не удалось загрузить трек.',
        ),
      ),
    );
    await mount(tester, FullPlayerScreen(controller: controller));
    expect(
      tester
          .widget<Slider>(find.byKey(const ValueKey('player-seek')))
          .onChanged,
      isNull,
    );
    expect(find.text('Длительность неизвестна'), findsOneWidget);
    await tester.drag(
      find.byType(SingleChildScrollView).first,
      const Offset(0, -800),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Повторить'));
    await tester.pumpAndSettle();
    expect(playback.commands.single, isA<Resume>());
  });
  testWidgets(
    'queue save delegates captured effective order and preserves duplicates',
    (tester) async {
      PlayerQueueTarget? saved;
      controller.dispose();
      controller = PlayerController(
        playback: playback,
        authority: authority,
        fence: collectionFence,
        preferences: preferences,
        callbacks: PlayerCallbacks(onSaveQueue: (target) => saved = target),
      );
      playback.publish(state(shuffle: true, order: ['c', 'b', 'a']));
      await mount(tester, QueueScreen(controller: controller));
      await tester.tap(find.byTooltip('Действия очереди'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Сохранить плейлист'));
      await tester.pumpAndSettle();
      expect(saved!.snapshot.effectiveOrder, ['c', 'b', 'a']);
      expect(saved!.tracks.length, 3);
      expect(saved!.tracks.map((t) => t.ref).toSet().length, 1);
      expect(playback.commands, isEmpty);
    },
  );
  for (final width in [320.0, 390.0, 430.0, 640.0]) {
    for (final scale in [1.0, 2.0]) {
      testWidgets('player and queue scroll at $width scale$scale', (
        tester,
      ) async {
        await mount(
          tester,
          FullPlayerScreen(controller: controller),
          width: width,
          height: width == 640 ? 360 : 568,
          scale: scale,
        );
        expect(tester.takeException(), isNull);
        await tester.drag(
          find.byType(SingleChildScrollView).first,
          const Offset(0, -1600),
        );
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        expect(find.text('Не нравится'), findsOneWidget);
        await mount(
          tester,
          QueueScreen(controller: controller),
          width: width,
          height: width == 640 ? 360 : 568,
          scale: scale,
        );
        expect(tester.takeException(), isNull);
        await mount(
          tester,
          Scaffold(
            body: MiniPlayer(controller: controller, onOpen: () {}),
          ),
          width: width,
          height: 568,
          scale: scale,
        );
        expect(tester.takeException(), isNull);
      });
    }
  }
}
