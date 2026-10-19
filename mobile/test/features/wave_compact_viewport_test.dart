import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/app/app_destinations.dart';
import 'package:soundspan/app/app_router.dart';
import 'package:soundspan/app/app_shell.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/design_system/design_system.dart';
import 'package:soundspan/features/recommendations/recommendation_repository.dart';
import 'package:soundspan/features/wave/wave_controller.dart';
import 'package:soundspan/features/wave/wave_screen.dart';
import 'package:soundspan/playback/playback_command.dart';
import 'package:soundspan/playback/queue_snapshot.dart';
import 'package:soundspan/playback/wave_continuation.dart';

import '../support/collection_fixtures.dart';
import '../support/wave_reporting_fixtures.dart';

void main() {
  for (final width in [320.0, 360.0]) {
    for (final scale in [1.0, 1.3]) {
      for (final mode in ['new', 'playing', 'paused']) {
        final active = mode != 'new';
        testWidgets(
          'Wave primary action fits footer viewport width=$width text=$scale mode=$mode',
          (tester) async {
            tester.view.physicalSize = Size(width, 640);
            tester.view.devicePixelRatio = 1;
            addTearDown(tester.view.resetPhysicalSize);
            addTearDown(tester.view.resetDevicePixelRatio);
            final authority = CollectionAuthority();
            final playback = ReportingController();
            final transport = ControlledTransport()
              ..respond = (_) async => ApiResponse(200, {
                ...waveFeed([], cursor: 1),
                'shelves': {
                  'listenAgain': [],
                  'quickPicks': [],
                  'discovery': [
                    {
                      ...waveDto('first'),
                      'title': 'Очень длинное название текущей музыкальной записи с дополнительной версией и именем приглашённого исполнителя',
                    },
                    waveDto('second'),
                    waveDto('third'),
                    waveDto('fourth'),
                  ],
                },
              });
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
            if (active) await controller.start();
            if (mode == 'paused') {
              final queue = playback.snapshot;
              playback.emit(
                QueueSnapshot(
                  fence: queue.fence,
                  entries: queue.entries,
                  effectiveOrder: queue.effectiveOrder,
                  currentEntryId: queue.currentEntryId,
                  lineage: queue.lineage,
                  generation: queue.generation,
                  playingIntent: false,
                ),
              );
            }
            final router = AppRouter(initialTab: AppTab.wave);
            await tester.pumpWidget(
              MaterialApp(
                theme: SoundspanTheme.dark(),
                builder: (_, child) => MediaQuery(
                  data: MediaQueryData(
                    size: Size(width, 640),
                    padding: const EdgeInsets.only(top: 24, bottom: 24),
                    viewPadding: const EdgeInsets.only(top: 24, bottom: 24),
                    textScaler: TextScaler.linear(scale),
                  ),
                  child: child!,
                ),
                home: AppShell(
                  router: router,
                  miniPlayer: active ? const SizedBox(height: 72) : null,
                  destinations: {
                    for (final tab in AppTab.values)
                      tab: (_) => tab == AppTab.wave
                          ? WaveScreen(controller: controller)
                          : const SizedBox.shrink(),
                  },
                  routeBuilder: (_, _) => const SizedBox.shrink(),
                ),
              ),
            );
            await tester.pumpAndSettle();
            final primary = find.ancestor(
              of: find.text(
                !active
                    ? 'Начать волну'
                    : mode == 'paused'
                    ? 'Продолжить'
                    : 'Пауза',
              ),
              matching: find.byType(FilledButton),
            );
            final viewport = tester.getRect(find.byType(CustomScrollView));
            final action = tester.getRect(primary);
            expect(action.top, greaterThanOrEqualTo(viewport.top));
            expect(
              action.bottom,
              lessThanOrEqualTo(viewport.bottom),
              reason: 'The complete primary target must be above the footer',
            );
            expect(primary.hitTestable(), findsOneWidget);
            final requestsBefore = transport.requests.length;
            await tester.tap(primary);
            await tester.pumpAndSettle();
            if (active) {
              expect(
                playback.commands.last,
                mode == 'paused' ? isA<Resume>() : isA<Pause>(),
              );
              expect(transport.requests.length, requestsBefore);
            } else {
              expect(transport.requests.length, requestsBefore + 1);
              expect(playback.commands.last, isA<ReplaceQueue>());
            }
            expect(find.text('Настроить волну'), findsNothing);
            await tester.tap(find.byTooltip('Настроить волну'));
            await tester.pumpAndSettle();
            expect(find.text('Применить'), findsOneWidget);
            await tester.tap(find.byTooltip('Закрыть без изменений'));
            await tester.pumpAndSettle();
            expect(
              transport.requests.length,
              active ? requestsBefore : requestsBefore + 1,
            );
            expect(tester.takeException(), isNull);
            await tester.pumpWidget(const SizedBox.shrink());
            router.dispose();
            controller.dispose();
            await tester.runAsync(service.dispose);
            await playback.dispose();
            await authority.updates.close();
          },
        );
      }
    }
  }
}
