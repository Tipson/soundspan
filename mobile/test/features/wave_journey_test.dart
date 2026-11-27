import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/design_system/design_system.dart';
import 'package:soundspan/features/recommendations/recommendation_repository.dart';
import 'package:soundspan/features/wave/wave_controller.dart';
import 'package:soundspan/features/wave/wave_screen.dart';
import 'package:soundspan/playback/wave_continuation.dart';
import 'package:soundspan/playback/playback_command.dart';
import 'package:soundspan/playback/queue_snapshot.dart';

import '../support/collection_fixtures.dart';
import '../support/wave_reporting_fixtures.dart';

void main() {
  test(
    'launcher Wave starts audible playback and reuses its active queue',
    () async {
      final authority = CollectionAuthority(), playback = ReportingController();
      final transport = ControlledTransport()
        ..respond = (_) async =>
            ApiResponse(200, waveFeed(['a', 'b', 'c', 'd']));
      final continuation = WaveContinuation(
        controller: playback,
        repository: RecommendationRepository(transport: transport),
        authority: authority,
      );
      final wave = WaveController(
        continuation: continuation,
        playback: playback,
        authority: authority,
        fence: collectionFence,
      );
      addTearDown(() async {
        wave.dispose();
        await continuation.dispose();
        await playback.dispose();
        await authority.updates.close();
      });

      await wave.playOrStart();
      expect(playback.snapshot.currentEntry?.track.title, 'a');
      expect(playback.snapshot.playing, isTrue);
      final initialCommands = playback.commands.length;

      await wave.playOrStart();
      expect(playback.commands, hasLength(initialCommands));

      final playing = playback.snapshot;
      playback.emit(
        QueueSnapshot(
          fence: playing.fence,
          entries: playing.entries,
          effectiveOrder: playing.effectiveOrder,
          currentEntryId: playing.currentEntryId,
          processing: PlaybackProcessing.ready,
          lineage: playing.lineage,
        ),
      );
      await wave.playOrStart();
      expect(playback.commands.last, isA<Resume>());
      expect(playback.commands.whereType<ReplaceQueue>(), hasLength(1));
      expect(transport.requests, hasLength(1));
    },
  );

  for (final width in [320.0, 390.0, 430.0]) {
    for (final scale in [1.0, 2.0]) {
      testWidgets(
        'Wave draft cancelled without retune at $width scale $scale',
        (tester) async {
          tester.view.physicalSize = Size(width, 850);
          tester.view.devicePixelRatio = 1;
          addTearDown(tester.view.resetPhysicalSize);
          addTearDown(tester.view.resetDevicePixelRatio);
          final authority = CollectionAuthority(),
              playback = ReportingController();
          final transport = ControlledTransport()
            ..respond = (_) async =>
                ApiResponse(200, waveFeed(['a', 'b', 'c', 'd'], cursor: 1));
          final service = WaveContinuation(
            controller: playback,
            repository: RecommendationRepository(transport: transport),
            authority: authority,
          );
          final controller = WaveController(
            continuation: service,
            playback: playback,
            authority: authority,
            fence: collectionFence,
          );
          await tester.pumpWidget(
            MaterialApp(
              theme: SoundspanTheme.dark(),
              builder: (_, child) => MediaQuery(
                data: MediaQueryData(
                  size: Size(width, 850),
                  textScaler: TextScaler.linear(scale),
                ),
                child: child!,
              ),
              home: WaveScreen(controller: controller),
            ),
          );
          await tester.tap(find.byTooltip('Настроить волну'));
          await tester.pumpAndSettle();
          await tester.tap(find.text('Новое'));
          await tester.pump();
          Navigator.of(tester.element(find.text('Новое'))).pop();
          await tester.pumpAndSettle();
          expect(transport.requests, isEmpty);
          expect(playback.commands, isEmpty);
          expect(controller.selection.mode, WaveMode.forYou);
          expect(tester.takeException(), isNull);
          await tester.pumpWidget(const SizedBox());
          controller.dispose();
          await tester.runAsync(service.dispose);
        },
      );
    }
  }
  test(
    'rapid explicit Apply uses shared service latest direction and exact queue',
    () async {
      final authority = CollectionAuthority()..restoreLocally(),
          playback = ReportingController();
      final responses = <Completer<ApiResponse>>[];
      final transport = ControlledTransport()
        ..respond = (r) async {
          if (r.query['mood'] == null) {
            return ApiResponse(
              200,
              waveFeed(['initial', 'i2', 'i3', 'i4'], cursor: 1),
            );
          }
          final result = Completer<ApiResponse>();
          responses.add(result);
          return result.future;
        };
      final service = WaveContinuation(
        controller: playback,
        repository: RecommendationRepository(transport: transport),
        authority: authority,
      );
      final controller = WaveController(
        continuation: service,
        playback: playback,
        authority: authority,
        fence: collectionFence,
      );
      await controller.start();
      final slow = controller.apply(
        const WaveSelection(mode: WaveMode.newMusic, mood: WaveMood.calm),
      );
      await settle();
      final fast = controller.apply(
        const WaveSelection(
          mode: WaveMode.familiar,
          mood: WaveMood.energetic,
          language: WaveLanguage.ru,
        ),
      );
      await settle();
      responses[1].complete(
        ApiResponse(200, {
          ...waveFeed([], cursor: 2),
          'shelves': {
            'discovery': [],
            'quickPicks': [],
            'listenAgain': [
              waveDto('latest'),
              waveDto('l2'),
              waveDto('l3'),
              waveDto('l4'),
            ],
          },
        }),
      );
      await fast;
      responses[0].complete(
        ApiResponse(200, waveFeed(['stale', 's2', 's3', 's4'], cursor: 3)),
      );
      await slow;
      expect(playback.snapshot.currentEntry?.track.title, 'latest');
      expect(controller.upcoming.map((e) => e.track.title), ['l2', 'l3', 'l4']);
      expect(transport.requests.last.query['mode'], 'familiar');
      expect(transport.requests.last.query['language'], 'ru');
      await controller.togglePlayback();
      expect(playback.commands.last, isA<Pause>());
      controller.dispose();
      await service.dispose();
      await playback.dispose();
    },
  );

  testWidgets(
    'Apply and language controls reachable with large text; Escape cancels draft',
    (tester) async {
      tester.view.physicalSize = const Size(320, 640);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final authority = CollectionAuthority(), playback = ReportingController();
      final transport = ControlledTransport()
        ..respond = (_) async =>
            ApiResponse(200, waveFeed(['a', 'b', 'c', 'd'], cursor: 1));
      final service = WaveContinuation(
        controller: playback,
        repository: RecommendationRepository(transport: transport),
        authority: authority,
      );
      final controller = WaveController(
        continuation: service,
        playback: playback,
        authority: authority,
        fence: collectionFence,
      );
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          builder: (_, child) => MediaQuery(
            data: const MediaQueryData(
              size: Size(320, 640),
              textScaler: TextScaler.linear(2),
            ),
            child: child!,
          ),
          home: WaveScreen(controller: controller),
        ),
      );
      await tester.tap(find.byTooltip('Настроить волну'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Иностранный'));
      await tester.pump();
      await tester.tap(find.text('Иностранный'));
      await tester.pump();
      await tester.tap(find.text('Применить'));
      await tester.pumpAndSettle();
      expect(transport.requests.single.query['language'], 'foreign');
      expect(controller.selection.language, WaveLanguage.foreign);
      await tester.tap(find.byTooltip('Настроить волну'));
      await tester.pumpAndSettle();
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.text('Применить'), findsNothing);
      expect(transport.requests.length, 1);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      await tester.runAsync(service.dispose);
    },
  );
  testWidgets('old direction sheet cannot apply after selection A B A', (
    tester,
  ) async {
    final authority = CollectionAuthority(), playback = ReportingController();
    var page = 0;
    final transport = ControlledTransport()
      ..respond = (_) async {
        final id = '${++page}';
        return ApiResponse(200, {
          ...waveFeed([], cursor: page),
          'shelves': {
            'discovery': [
              waveDto('$id-a'),
              waveDto('$id-b'),
              waveDto('$id-c'),
              waveDto('$id-d'),
            ],
            'quickPicks': [],
            'listenAgain': [],
          },
        });
      };
    final service = WaveContinuation(
      controller: playback,
      repository: RecommendationRepository(transport: transport),
      authority: authority,
    );
    final controller = WaveController(
      continuation: service,
      playback: playback,
      authority: authority,
      fence: collectionFence,
    );
    await tester.runAsync(controller.start);
    await tester.pumpWidget(
      MaterialApp(
        theme: SoundspanTheme.dark(),
        home: WaveScreen(controller: controller),
      ),
    );
    await tester.tap(find.byTooltip('Настроить волну'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Новое'));
    await tester.pump();
    await tester.runAsync(
      () => controller.apply(const WaveSelection(mode: WaveMode.newMusic)),
    );
    await tester.runAsync(() => controller.apply(const WaveSelection()));
    await tester.pump();
    await tester.tap(find.text('Применить'));
    await tester.pumpAndSettle();
    expect(transport.requests.length, 3);
    expect(controller.selection.mode, WaveMode.forYou);
    await tester.pumpWidget(const SizedBox());
    controller.dispose();
    await tester.runAsync(service.dispose);
  });
  test(
    'explicit offline prevents Start and owner revoked never revives',
    () async {
      final authority = CollectionAuthority(), playback = ReportingController();
      final transport = ControlledTransport()
        ..respond = (_) async => ApiResponse(200, waveFeed(['a', 'b', 'c']));
      final service = WaveContinuation(
        controller: playback,
        repository: RecommendationRepository(transport: transport),
        authority: authority,
      );
      final controller = WaveController(
        continuation: service,
        playback: playback,
        authority: authority,
        fence: collectionFence,
        networkPolicy: const NetworkPolicy.offline(),
      );
      await controller.start();
      expect(transport.requests, isEmpty);
      expect(controller.failure?.code, 'offline_mode');
      authority.switchOwner();
      authority.active = collectionFence;
      authority.updates.add(authority.state);
      await controller.start();
      expect(transport.requests, isEmpty);
      expect(controller.isCurrent, isFalse);
      controller.dispose();
      await service.dispose();
    },
  );
}
