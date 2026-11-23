import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/app/app_destinations.dart';
import 'package:soundspan/app/app_router.dart';
import 'package:soundspan/app/app_shell.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/design_system/design_system.dart';

void activate(WidgetTester tester, SemanticsNode node) {
  tester.binding.rootPipelineOwner.visitChildren((owner) {
    owner.semanticsOwner?.performAction(node.id, SemanticsAction.tap);
  });
}

void main() {
  testWidgets('screen-reader tap selects each retained music destination', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(360, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final handle = tester.ensureSemantics();
    try {
      final router = AppRouter();
      addTearDown(router.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: AppShell(
            router: router,
            destinations: {
              for (final tab in AppTab.values)
                tab: (_) => const SizedBox.expand(),
            },
            routeBuilder: (_, _) => const SizedBox.shrink(),
          ),
        ),
      );
      await tester.pumpAndSettle();
      for (final tab in AppTab.values) {
        final node = tester.getSemantics(
          find.byWidgetPredicate(
            (widget) =>
                widget is Semantics &&
                widget.properties.label == tab.label &&
                widget.properties.button == true,
          ),
        );
        expect(
          node.getSemanticsData().hasAction(SemanticsAction.tap),
          isTrue,
          reason: '${tab.label} must be operable without a coordinate touch.',
        );
        activate(tester, node);
        await tester.pumpAndSettle();
        expect(router.currentTab, tab);
      }
    } finally {
      handle.dispose();
    }
  });
  for (final allowed in [true, false]) {
    for (final hasCallback in [true, false]) {
      testWidgets(
        'track semantic tap retains admission allowed=$allowed callback=$hasCallback',
        (tester) async {
          final handle = tester.ensureSemantics();
          try {
            var plays = 0;
            await tester.pumpWidget(
              MaterialApp(
                theme: SoundspanTheme.dark(),
                home: Scaffold(
                  body: TrackRow(
                    track: Track(
                      ref: const LibraryTrackRef('exact-recording'),
                      title: 'Песня',
                      artist: 'Исполнитель',
                      playbackAllowed: allowed,
                    ),
                    onPlay: hasCallback ? () => plays++ : null,
                  ),
                ),
              ),
            );
            await tester.pumpAndSettle();
            final target = find.byWidgetPredicate(
              (widget) =>
                  widget is Semantics &&
                  widget.properties.label == 'Воспроизвести Песня, Исполнитель',
            );
            final node = tester.getSemantics(target);
            expect(
              node.getSemanticsData().hasAction(SemanticsAction.tap),
              allowed && hasCallback,
            );
            activate(tester, node);
            await tester.pumpAndSettle();
            expect(plays, allowed && hasCallback ? 1 : 0);
            await tester.tap(
              find.byKey(const ValueKey('track-play-library:exact-recording')),
            );
            await tester.pumpAndSettle();
            expect(
              plays,
              allowed && hasCallback ? 2 : 0,
              reason: 'Semantic and pointer activation must each invoke the original callback once.',
            );
          } finally {
            handle.dispose();
          }
        },
      );
    }
  }
}
