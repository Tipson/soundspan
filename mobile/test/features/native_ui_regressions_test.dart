import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/app/app_destinations.dart';
import 'package:soundspan/app/app_visibility_controller.dart';
import 'package:soundspan/app/owner_services.dart';
import 'package:soundspan/app/owner_ui_session.dart';
import 'package:soundspan/app/owner_shell.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/features/playlists/playlist_detail_screen.dart';
import 'package:soundspan/artwork/artwork_loader.dart';
import 'package:soundspan/artwork/artwork_scope.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/design_system/theme.dart';
import 'package:soundspan/design_system/artwork.dart';
import 'package:soundspan/design_system/wave_artwork.dart';
import 'package:soundspan/features/home/home_controller.dart';
import 'package:soundspan/features/home/home_repository.dart';
import 'package:soundspan/features/home/home_models.dart';
import 'package:soundspan/features/home/home_screen.dart';
import 'package:soundspan/features/recommendations/recommendation_repository.dart';
import 'package:soundspan/features/wave/wave_controller.dart';
import 'package:soundspan/features/wave/wave_screen.dart';
import 'package:soundspan/playback/wave_continuation.dart';

import '../support/collection_fixtures.dart';
import '../support/wave_reporting_fixtures.dart';

class RecordingArtwork extends ChangeNotifier implements ArtworkLoader {
  @override
  final fence = collectionFence;
  @override
  bool get isCurrent => true;
  final requested = <TrackRef?>[];
  @override
  Future<File?> load({TrackRef? ref, Uri? hint, int edge = 512}) async {
    requested.add(ref);
    return null;
  }
}

void main() {
  testWidgets(
    'Owner playlist route mounts without notifying its building parent',
    (tester) async {
      final authority = CollectionAuthority(),
          visibility = AppVisibilityController();
      late Directory directory;
      late NativeOwnerServices native;
      late OwnerUiSession session;
      await tester.runAsync(() async {
        final base = await Directory(
          'D:/CodexData/temp/soundspan-ui-regressions',
        ).create(recursive: true);
        directory = Directory(
          await (await base.createTemp()).resolveSymbolicLinks(),
        );
        final store = ReportingStore();
        await store.transaction(
          collectionFence,
          (tx) =>
              tx.write('settings', 'network', {'version': 1, 'offline': true}),
        );
        native = await NativeOwnerServices.create(
          authority: authority,
          store: store,
          fence: collectionFence,
          playback: CollectionPlayback(QueueSnapshot(fence: collectionFence)),
          supportDirectory: directory,
          cancelDownloads: (_) async {},
        );
        session = await OwnerUiSession.create(
          owner: native,
          logout: authority.invalidate,
        );
      });
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          navigatorObservers: [visibility],
          home: OwnerShell(session: session, rootExposure: visibility),
        ),
      );
      await tester.pumpAndSettle();
      session.router.push(
        const AppDestination(AppRouteKind.playlist, id: 'p-evening'),
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(find.byType(PlaylistDetailScreen), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      await _drain(tester, session.close());
      await _drain(tester, native.close());
      visibility.dispose();
      await authority.updates.close();
      await tester.runAsync(() => directory.delete(recursive: true));
    },
  );
  testWidgets('Home Wave composition aligns with the content gutter', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final authority = CollectionAuthority();
    final controller = HomeController(
      repository: HomeRepository(
        transport: CollectionTransport((_, _) => const ApiResponse(200, {})),
        authority: authority,
        fence: collectionFence,
      ),
      request: HomeRequest(
        localHour: 10,
        timezoneOffsetMinutes: 180,
        autoPlaylists: false,
        discovery: false,
      ),
    );
    await tester.pumpWidget(
      MaterialApp(
        theme: SoundspanTheme.dark(),
        home: HomeScreen(
          controller: controller,
          autoLoad: false,
          onOpenWave: () {},
          onOpenMix: (_) {},
          onPlay: (_) {},
        ),
      ),
    );
    final title = find.text('Ваша волна');
    final hero = find.byKey(const ValueKey('home-wave-entry'));
    expect(tester.getTopLeft(hero).dx, 20);
    expect(tester.getSize(hero).width, 350);
    expect(tester.getTopLeft(title).dx, 36);
    await tester.pumpWidget(const SizedBox());
    controller.dispose();
    await authority.updates.close();
  });
  testWidgets(
    'Idle Wave uses its brand visual without an absent-track placeholder',
    (tester) async {
      final authority = CollectionAuthority(), playback = ReportingController();
      final continuation = WaveContinuation(
        controller: playback,
        repository: RecommendationRepository(transport: ControlledTransport()),
        authority: authority,
      );
      final controller = WaveController(
        continuation: continuation,
        playback: playback,
        authority: authority,
        fence: collectionFence,
      );
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: WaveScreen(controller: controller),
        ),
      );
      expect(find.byType(Artwork), findsNothing);
      expect(find.byType(WaveArtwork), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      await tester.runAsync(continuation.dispose);
      await playback.dispose();
      await authority.updates.close();
    },
  );
  testWidgets(
    'Wave hero resolves the current recording artwork after queue strips URI',
    (tester) async {
      final authority = CollectionAuthority(),
          playback = ReportingController(),
          loader = RecordingArtwork();
      final transport = ControlledTransport()
        ..respond = (_) async => ApiResponse(200, waveFeed(['01234567890']));
      final continuation = WaveContinuation(
        controller: playback,
        repository: RecommendationRepository(transport: transport),
        authority: authority,
      );
      final controller = WaveController(
        continuation: continuation,
        playback: playback,
        authority: authority,
        fence: collectionFence,
      );
      await controller.start();
      expect(playback.snapshot.currentEntry!.track.artwork, isNull);
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: ArtworkScope(
            loader: loader,
            child: WaveScreen(controller: controller),
          ),
        ),
      );
      await tester.pump();
      expect(
        loader.requested,
        contains(playback.snapshot.currentEntry!.track.ref),
      );
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      loader.dispose();
      await tester.runAsync(continuation.dispose);
      await playback.dispose();
      await authority.updates.close();
    },
  );
}

Future<void> _drain(WidgetTester tester, Future<void> closing) async {
  var done = false;
  Object? error;
  closing.then(
    (_) => done = true,
    onError: (Object e) {
      error = e;
      done = true;
    },
  );
  for (var i = 0; i < 100 && !done; i++) {
    await tester.pump();
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 10)),
    );
  }
  expect(done, isTrue);
  if (error != null) throw error!;
}
