import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/design_system/theme.dart';
import 'package:soundspan/features/likes/preference_controller.dart';
import 'package:soundspan/features/playlists/playlist_controller.dart';
import 'package:soundspan/features/playlists/playlist_detail_screen.dart';
import 'package:soundspan/features/player/player_controller.dart';
import 'package:soundspan/features/player/queue_screen.dart';

import '../support/collection_fixtures.dart';
import 'playlist_journey_test.dart' as fixture;
import 'playlist_smart_shuffle_test.dart' as smart_fixture;

void main() {
  testWidgets('queue visibly marks discoveries without changing occurrences', (
    tester,
  ) async {
    final h = smart_fixture.Harness();
    addTearDown(h.close);
    await h.open();
    await h.smart.toggle();
    h.engine.emit(position: const Duration(seconds: 1));
    final preferences = PreferenceController(
      transport: h.transport,
      authority: h.authority,
      fence: collectionFence,
    );
    addTearDown(preferences.dispose);
    final player = PlayerController(
      playback: h.queue,
      authority: h.authority,
      fence: collectionFence,
      preferences: preferences,
    );
    addTearDown(player.dispose);
    final order = h.queue.snapshot.effectiveOrder;
    await tester.pumpWidget(
      MaterialApp(
        theme: SoundspanTheme.dark(),
        home: QueueScreen(controller: player),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Находка'), findsAtLeastNWidgets(1));
    expect(h.queue.snapshot.effectiveOrder, order);
    expect(tester.takeException(), isNull);
  });
  testWidgets(
    '320dp large-text action starts the real finite queue and ordinary Play overrides it',
    (tester) async {
      tester.view.physicalSize = const Size(320, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final h = smart_fixture.Harness();
      addTearDown(h.close);
      await h.open();
      final preferences = PreferenceController(
        transport: h.transport,
        authority: h.authority,
        fence: collectionFence,
      );
      addTearDown(preferences.dispose);
      var normalPlays = 0;
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: const TextScaler.linear(1.8)),
            child: child!,
          ),
          home: PlaylistDetailScreen(
            controller: h.playlists,
            preferences: preferences,
            smartShuffle: h.smart,
            onPlay: (_) async {
              normalPlays++;
            },
            autoLoad: false,
          ),
        ),
      );
      await tester.tap(find.byTooltip('Действия с плейлистом'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('С находками'));
      await tester.tap(find.text('С находками'));
      await tester.pumpAndSettle();
      expect(h.smart.active, true);
      expect(h.queue.snapshot.entries, hasLength(9));
      h.engine.emit(position: const Duration(seconds: 1));
      await tester.pump();
      expect(tester.takeException(), isNull);
      await tester.tap(find.byTooltip('Действия с плейлистом'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Выключить находки'));
      await tester.tap(find.text('Выключить находки'));
      await tester.pumpAndSettle();
      expect(h.smart.active, false);
      expect(h.queue.snapshot.entries, hasLength(7));
      await tester.ensureVisible(find.text('Слушать'));
      await tester.tap(find.text('Слушать'));
      await tester.pumpAndSettle();
      expect(normalPlays, 1);
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'reused route property cancels preparation before late pool publication',
    (tester) async {
      final h = smart_fixture.Harness();
      addTearDown(h.close);
      await h.open();
      final preferences = PreferenceController(
        transport: h.transport,
        authority: h.authority,
        fence: collectionFence,
      );
      addTearDown(preferences.dispose);
      Widget screen(String id) => MaterialApp(
        theme: SoundspanTheme.dark(),
        home: PlaylistDetailScreen(
          playlistId: id,
          controller: h.playlists,
          preferences: preferences,
          smartShuffle: h.smart,
          onPlay: (_) async {},
          autoLoad: false,
        ),
      );
      await tester.pumpWidget(screen('p'));
      h.poolGate = Completer<ApiResponse>();
      await tester.tap(find.byTooltip('Действия с плейлистом'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('С находками'));
      await tester.pumpAndSettle();
      expect(h.smart.busy, true);
      await tester.pumpWidget(screen('other'));
      await tester.pump();
      h.poolGate!.complete(h.poolResponse());
      await tester.pumpAndSettle();
      expect(h.queue.snapshot.entries, isEmpty);
    },
  );
  testWidgets(
    'Back leaves sheet untouched; cancel rejects a delayed radio reply',
    (tester) async {
      final h = smart_fixture.Harness();
      addTearDown(h.close);
      await h.open();
      final preferences = PreferenceController(
        transport: h.transport,
        authority: h.authority,
        fence: collectionFence,
      );
      addTearDown(preferences.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: PlaylistDetailScreen(
            controller: h.playlists,
            preferences: preferences,
            smartShuffle: h.smart,
            onPlay: (_) async {},
            autoLoad: false,
          ),
        ),
      );
      await tester.tap(find.byTooltip('Действия с плейлистом'));
      await tester.pumpAndSettle();
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(
        h.transport.requests.where(
          (request) => request.path == '/api/library/radio',
        ),
        isEmpty,
      );
      h.poolGate = Completer<ApiResponse>();
      await tester.tap(find.byTooltip('Действия с плейлистом'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('С находками'));
      await tester.pumpAndSettle();
      expect(h.smart.busy, true);
      expect(h.queue.snapshot.entries, isEmpty);
      await tester.tap(find.byTooltip('Действия с плейлистом'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Отменить подготовку находок'));
      await tester.pumpAndSettle();
      h.poolGate!.complete(h.poolResponse());
      await tester.pumpAndSettle();
      expect(h.smart.busy, false);
      expect(h.queue.snapshot.entries, isEmpty);
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets('owned playlist exposes opt-in inside secondary actions', (
    tester,
  ) async {
    final authority = CollectionAuthority();
    final transport = CollectionTransport(
      (_, _) => ApiResponse(200, fixture.detail([fixture.item(1)])),
    );
    final playlists = PlaylistController(
      repository: fixture.repository(authority, transport),
    );
    final preferences = PreferenceController(
      transport: transport,
      authority: authority,
      fence: collectionFence,
    );
    addTearDown(playlists.dispose);
    addTearDown(preferences.dispose);
    await playlists.open('p');
    await tester.pumpWidget(
      MaterialApp(
        theme: SoundspanTheme.dark(),
        home: PlaylistDetailScreen(
          controller: playlists,
          preferences: preferences,
          onPlay: (_) async {},
          autoLoad: false,
        ),
      ),
    );
    expect(find.text('С находками'), findsNothing);
    await tester.tap(find.byTooltip('Действия с плейлистом'));
    await tester.pumpAndSettle();
    expect(find.text('С находками'), findsOneWidget);
  });
}
