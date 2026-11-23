import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderImage;
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:soundspan/app/app_composition.dart';
import 'package:soundspan/app/app_environment.dart';
import 'package:soundspan/app/app_destinations.dart';
import 'package:soundspan/app/native_app_resources.dart';
import 'package:soundspan/app/native_documents.dart';
import 'package:soundspan/app/owner_avatar_uploader.dart';
import 'package:soundspan/app/owner_feature_scope.dart';
import 'package:soundspan/app/owner_services.dart';
import 'package:soundspan/app/owner_shell.dart';
import 'package:soundspan/app/owner_ui_session.dart';
import 'package:soundspan/app/soundspan_app.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/mapping/liked_track_mapper.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/features/likes/likes_models.dart';
import 'package:soundspan/core/network/dart_api_transport.dart';
import 'package:soundspan/core/session/auth_repository.dart';
import 'package:soundspan/core/session/local_session_authority.dart';
import 'package:soundspan/core/session/secure_storage_credential_vault.dart';
import 'package:soundspan/core/session/session_broker_entrypoint.dart';
import 'package:soundspan/core/session/session_broker_rpc_server.dart';
import 'package:soundspan/core/storage/sqlite_session_store.dart';
import 'package:soundspan/downloads/automatic_download_control.dart';
import 'package:soundspan/downloads/download_worker_entrypoint.dart';
import 'package:soundspan/downloads/download_coordinator.dart';
import 'package:soundspan/downloads/download_models.dart';
import 'package:soundspan/downloads/protected_media_fetcher.dart';
import 'package:soundspan/playback/playback_resolver.dart';
import 'package:soundspan/features/player/mini_player.dart';
import 'package:soundspan/features/search/search_screen.dart';
import 'package:soundspan/features/home/home_screen.dart';
import 'package:soundspan/features/home/mix_screen.dart';
import 'package:soundspan/features/history/history_screen.dart';
import 'package:soundspan/features/artist/artist_screen.dart';
import 'package:soundspan/features/album/album_screen.dart';
import 'package:soundspan/features/search/catalog_models.dart';
import 'package:soundspan/playback/wave_selection.dart';
import 'package:soundspan/features/imports/import_job_screen.dart';
import 'package:soundspan/features/playlists/playlist_detail_screen.dart';
import 'package:soundspan/features/wave/wave_screen.dart';
import 'package:soundspan/playback/playback_controller.dart';

import 'support/whole_app_fixture.dart';
import 'support/native_frame_rendezvous.dart';
import 'support/native_geometry.dart';

@pragma('vm:entry-point')
Future<void> downloadWorkerMain() => runDownloadWorker();

/// Production broker dependencies with a private localhost-only test CA.
@pragma('vm:entry-point')
Future<void> sessionBrokerMain() async {
  WidgetsFlutterBinding.ensureInitialized();
  final sessions = await SqliteSessionStore.open();
  final client = _LoopbackJson();
  final authority = LocalSessionAuthority(
    vault: SecureStorageCredentialVault(),
    fenceStore: sessions,
    refreshTokens: (origin, token) =>
        LocalAuthRepository.refresh(client, origin, token),
  );
  await serveSessionBroker(
    SessionBrokerRpcServer(
      authority: authority,
      restoreCapturedFence: authority.restoreCapturedFence,
      auth: LocalAuthRepository(authority: authority, client: client),
    ),
  );
}

class _LoopbackJson implements JsonHttpClient {
  final _client = DartJsonHttpClient(securityContext: WholeAppFixture.trust());
  @override
  Future<ApiResponse> send(ApiRequest request, {String? accessToken}) {
    if (request.origin.scheme != 'https' ||
        request.origin.host != 'localhost' ||
        request.origin.userInfo.isNotEmpty) {
      throw StateError('Test broker permits verified localhost only');
    }
    return _client.send(request, accessToken: accessToken);
  }
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('installed whole app: real broker SQLite TLS player and UI', (
    tester,
  ) async {
    final fixture = await WholeAppFixture.open();
    final frames = await NativeFrameRendezvous.open();
    NativeAppResources? resources;
    AppComposition? app;
    OwnerUiSession? session;
    final frameworkErrors = <String>[];
    final originalErrorHandler = FlutterError.onError;
    FlutterError.onError = (details) {
      frameworkErrors.add('${details.exception}\n${details.stack}');
      debugPrint(
        'T24 ORIGINAL FLUTTER ERROR ${details.exception}\n${details.stack}',
      );
      originalErrorHandler?.call(details);
    };
    var audioGraphs = 0, ownerGraphs = 0;
    final acceptedControls = <String>[];
    final downloadTelemetry = <Map<String, Object?>>[];
    Future<void> settle([int ticks = 10]) async {
      for (var i = 0; i < ticks; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      final error = tester.takeException();
      if (error != null) throw error;
    }

    Future<void> until(
      bool Function() condition,
      String reason, {
      Duration timeout = const Duration(seconds: 25),
    }) async {
      final timer = Stopwatch()..start();
      while (!condition() && timer.elapsed < timeout) {
        await settle(1);
      }
      expect(condition(), isTrue, reason: reason);
    }

    Future<T> pumping<T>(
      String stage,
      Future<T> Function() operation, {
      Duration timeout = const Duration(seconds: 25),
    }) async {
      debugPrint('T24 BEGIN $stage');
      var done = false;
      T? result;
      Object? failure;
      operation().then(
        (value) {
          result = value;
          done = true;
        },
        onError: (Object error) {
          failure = error;
          done = true;
        },
      );
      await until(() => done, stage, timeout: timeout);
      debugPrint('T24 END $stage');
      if (failure != null) throw failure!;
      return result as T;
    }

    Future<void> capture(String name) async {
      await settle();
      final view = tester.view;
      final context = find.byType(SoundspanApp).evaluate().first;
      final homeActions = <String, Object?>{};
      if (name.startsWith('matrix-home-')) {
        final viewport =
            Offset.zero & (view.physicalSize / view.devicePixelRatio);
        for (final label in ['История прослушивания', 'Настройки']) {
          final action = find.byTooltip(label);
          expect(action, findsOneWidget);
          expect(
            action.hitTestable(),
            findsOneWidget,
            reason: '$name must retain reachable $label',
          );
          final rect = tester.getRect(action);
          expect(
            containsControlRect(viewport, rect),
            isTrue,
            reason: '$name $label control=$rect viewport=$viewport',
          );
          homeActions[label] = {
            'left': rect.left,
            'top': rect.top,
            'right': rect.right,
            'bottom': rect.bottom,
            'hitTestable': true,
            'viewport': {
              'left': viewport.left,
              'top': viewport.top,
              'right': viewport.right,
              'bottom': viewport.bottom,
            },
          };
        }
      }
      await frames.frame(name, {
        'physicalWidth': view.physicalSize.width,
        'physicalHeight': view.physicalSize.height,
        'devicePixelRatio': view.devicePixelRatio,
        'textScaleAt16': MediaQuery.maybeOf(context)?.textScaler.scale(16),
        'viewInsetsBottom': view.viewInsets.bottom,
        'syntheticAccount': true,
        'playbackFailure': app?.playback.snapshot.failure?.code,
        'playerFailure': session?.player.failure?.code,
        'preferenceFailure': session?.player.preference.failure?.code,
        'unexpectedRequests': fixture.unexpected.toList(),
        if (homeActions.isNotEmpty) 'homeActions': homeActions,
      });
    }

    Future<void> tap(Finder finder) async {
      expect(finder, findsAtLeastNWidgets(1));
      await tester.ensureVisible(finder.first);
      // Scrolling marks layout dirty; native hit testing must use the new frame.
      await settle();
      expect(finder.first.hitTestable(), findsOneWidget);
      await tester.tap(finder.first.hitTestable());
      await settle();
    }

    Future<void> back() async {
      await frames.back();
      await settle();
    }

    Future<void> top(Type screen) async {
      final scroll = find
          .descendant(
            of: find.byType(screen),
            matching: find.byType(Scrollable),
          )
          .first;
      tester.state<ScrollableState>(scroll).position.jumpTo(0);
      await settle();
    }

    try {
      await frames.device();
      resources = await NativeAppResources.open(defaultOrigin: fixture.origin);
      final persisted = await resources.sessions.read();
      // Never erase a real account to make an integration test pass.
      final previous = persisted.owner;
      if (previous != null) {
        expect(
          previous.serverOrigin.host == 'localhost' ||
              previous.serverOrigin.host.endsWith('.invalid'),
          isTrue,
          reason: 'Refusing to replace non-synthetic emulator account',
        );
        binding.reportData = {
          'previousSyntheticOrigin': previous.serverOrigin.toString(),
          'previousSyntheticUser': previous.userId,
        };
        await resources.auth.logout();
      }
      final liveResources = resources;
      final native = liveResources.environment;
      final trust = WholeAppFixture.trust();
      app = await AppComposition.create(
        AppEnvironment(
          authority: liveResources.authority,
          auth: resources.auth,
          origin: fixture.origin,
          createPlayback: (prepare) {
            audioGraphs++;
            return native.createPlayback(prepare);
          },
          createOwner: (fence, playback) async {
            ownerGraphs++;
            await liveResources.store.transaction(
              fence,
              (tx) => tx.write(
                AutomaticDownloadControl.namespace,
                AutomaticDownloadControl.key,
                AutomaticDownloadControl.encode(true),
              ),
            );
            final owner = await NativeOwnerServices.create(
              authority: liveResources.authority,
              store: liveResources.store,
              fence: fence,
              playback: playback,
              supportDirectory: liveResources.supportDirectory,
              securityContext: trust,
            );
            final avatar = OwnerAvatarUploader(
              authority: liveResources.authority,
              fence: fence,
              networkPolicy: owner.policy,
              securityContext: trust,
            );
            final ui = await OwnerUiSession.create(
              owner: owner,
              logout: liveResources.auth.logout,
              avatarUploader: avatar,
            );
            ui.lifetime.add(avatar.close);
            session = ui;
            return OwnerFeatureScope<OwnerUiSession>(
              native: owner,
              session: ui,
              closeFeatures: ui.close,
            );
          },
          release: native.release,
          processReady: native.processReady,
        ),
      );
      expect(app.phase, AppPhase.signedOut);
      await tester.pumpWidget(
        SoundspanApp(
          composition: app,
          onOriginSelected: resources.rememberOrigin,
          ownerBuilder: (context, scope, exposure) {
            final owner = scope as OwnerFeatureScope<OwnerUiSession>;
            return OwnerShell(
              key: ValueKey(owner.fence),
              session: owner.session,
              rootExposure: exposure,
              pickAvatar: () => NativeDocuments().pickAvatar(
                isCurrent: () => owner.session.isCurrent,
              ),
            );
          },
        ),
      );
      await until(
        () => find.byType(TextField).evaluate().length >= 2,
        'Real login fields',
      );
      await capture('01-login-390');
      await tester.enterText(find.byType(TextField).at(0), 'synthetic');
      await tester.enterText(find.byType(TextField).at(1), 'synthetic-only');
      await tap(find.text('Войти').last);
      await until(
        () => app!.phase == AppPhase.ready,
        'Actual broker login creates owner',
      );
      await until(
        () => session!.home.state.feed.mixes.isNotEmpty,
        'Actual TLS Home DTOs',
      );
      expect(session!.automation.paused, isTrue);
      expect(audioGraphs, 1);
      expect(ownerGraphs, 1);
      // Seed one phone file through the actual TLS/SQLite/hash/native-probe
      // pipeline. This is fixture preparation, not a WorkManager button claim.
      Future<void> seedPhoneFile() async {
        final owner = session!.owner;
        final job = await pumping(
          'seed enqueue',
          () => owner.downloads.enqueue(
            const LikedTrackMapper().map(fixture.track(0)),
            'original',
            owner.fence,
          ),
        );
        final download = DownloadCoordinator(
          repository: owner.downloads,
          resolverForQuality: (quality) => PlaybackResolver(
            transport: owner.transport,
            authority: owner.authority,
            quality: quality,
          ),
          fetcher: ProtectedMediaFetcher(
            authority: owner.authority,
            securityContext: trust,
          ),
          networkPolicy: owner.policy,
        );
        Future<void>? observation;
        final started = Stopwatch()..start();
        final monitor = Timer.periodic(const Duration(seconds: 1), (_) {
          if (observation != null) return;
          observation = owner.downloads
              .status(job.id, owner.fence)
              .then((state) {
                final row = <String, Object?>{
                  'ms': started.elapsedMilliseconds,
                  'state': state?.state.name,
                  'bytes': state?.bytes,
                  'total': state?.totalBytes,
                  'error': state?.errorCode,
                };
                downloadTelemetry.add(row);
                debugPrint('T24 DOWNLOAD $row');
              })
              .catchError((Object e) {
                debugPrint('T24 DOWNLOAD STATUS $e');
              })
              .whenComplete(() => observation = null);
        });
        try {
          expect(
            await pumping(
              'seed actual transfer',
              () => download.run(job.id, owner.fence, job.generation),
              timeout: const Duration(seconds: 120),
            ),
            DownloadRunResult.ready,
          );
        } finally {
          monitor.cancel();
          await observation;
          await pumping('seed close', download.close);
        }
        await session!.downloads.refresh();
        expect(session!.downloads.jobs.single.state, DownloadState.ready);
        acceptedControls.add(
          'Actual TLS download/hash/native media probe committed ready phone file',
        );
      }

      await until(() {
        final images = find.descendant(
          of: find.byType(HomeScreen),
          matching: find.byType(RawImage),
        );
        return images
                .evaluate()
                .where((e) => (e.renderObject as RenderImage).image != null)
                .length >=
            3;
      }, 'Home hero and initial mix artwork decoded and painted');
      await capture('02-home-390');
      final liveApp = app;
      Future<void> supplementary() async {
        final app = liveApp;
        await tester.scrollUntilVisible(
          find.text('Ваш инди'),
          250,
          scrollable: find.byType(Scrollable).first,
        );
        await settle();
        final horizontal = find
            .descendant(
              of: find.byType(HomeScreen),
              matching: find.byWidgetPredicate(
                (w) =>
                    w is Scrollable &&
                    (w.axisDirection == AxisDirection.right ||
                        w.axisDirection == AxisDirection.left),
              ),
            )
            .first;
        // The title may be visible while the shelf center is behind AppBar.
        // Place the whole shelf into the body before starting a real gesture.
        await tester.ensureVisible(horizontal);
        await settle();
        expect(horizontal.hitTestable(), findsOneWidget);
        final shelf = tester.state<ScrollableState>(horizontal);
        final beforeOffset = shelf.position.pixels;
        await tester.drag(horizontal, const Offset(-190, 0));
        await settle();
        expect(shelf.position.pixels, greaterThan(beforeOffset));
        final beforeMix = app.playback.snapshot.currentEntryId;
        await tap(find.text('Тихая электроника'));
        expect(find.byType(MixScreen), findsOneWidget);
        expect(app.playback.snapshot.currentEntryId, beforeMix);
        await tap(find.text('Слушать'));
        await until(
          () =>
              app.playback.snapshot.entries.length == 40 &&
              app.playback.snapshot.audible,
          'Mix40 actual native playback',
        );
        await capture('supp-01-mix-playing');
        await back();
        await tap(find.byTooltip('История прослушивания'));
        await until(
          () =>
              tester
                  .widget<HistoryScreen>(find.byType(HistoryScreen))
                  .controller
                  .page !=
              null,
          'Actual history loaded',
        );
        await capture('supp-02-history');
        await back();
        await tap(find.text('Волна').last);
        await tap(find.text('Начать волну'));
        await until(
          () => session!.wave.ownsCurrentWave && app.playback.snapshot.audible,
          'Wave replaces mix',
        );
        await tap(find.text('Пауза'));
        expect(app.playback.snapshot.playingIntent, isFalse);
        await tap(find.text('Продолжить'));
        await until(
          () => app.playback.snapshot.audible,
          'Wave resumes actual decoder',
        );
        final oldLineage = app.playback.snapshot.lineage;
        await tap(find.byTooltip('Настроить волну').first);
        await tap(find.text('Новое'));
        await tap(find.text('Спокойно'));
        await tap(find.text('Русский'));
        await tap(find.text('Применить'));
        await until(
          () =>
              app.playback.snapshot.lineage != oldLineage &&
              session!.wave.selection.mode == WaveMode.newMusic,
          'Confirmed retune replaces queue',
        );
        expect(session!.wave.selection.language, WaveLanguage.ru);
        await capture('supp-03-wave-retuned');
        await tap(find.byType(MiniPlayer));
        final previous = app.playback.snapshot.currentEntryId;
        await tap(find.byTooltip('Следующий трек'));
        await until(
          () => app.playback.snapshot.currentEntryId != previous,
          'Native next',
        );
        await tap(find.byTooltip('Перемешать'));
        expect(app.playback.snapshot.shuffle, isTrue);
        await tap(find.byTooltip('Повтор выключен'));
        expect(app.playback.snapshot.repeat, QueueRepeat.all);
        await frames.device(width: 320, scale: 2);
        await tester.ensureVisible(find.text('Не нравится'));
        await settle();
        expect(find.text('Не нравится').hitTestable(), findsOneWidget);
        await capture('supp-03b-player-feedback-320-2x');
        await frames.device();
        await tap(find.byTooltip('Свернуть плеер'));
        await tap(find.text('Поиск').last);
        await tester.enterText(
          find.descendant(
            of: find.byType(SearchScreen),
            matching: find.byType(TextField),
          ),
          'Тихие города',
        );
        await settle(15);
        if (tester.view.viewInsets.bottom > 0) await back();
        final artistTile = find
            .byWidgetPredicate(
              (w) =>
                  w is CatalogEntityTile &&
                  w.entity.ref.kind == CatalogEntityKind.artist,
            )
            .first;
        await tap(artistTile);
        await until(
          () =>
              tester
                  .widget<ArtistScreen>(find.byType(ArtistScreen))
                  .controller
                  .state
                  .detail !=
              null,
          'Artist actual source identity',
        );
        final artistController = tester
            .widget<ArtistScreen>(find.byType(ArtistScreen))
            .controller;
        await capture('supp-04-artist');
        final firstAlbum = artistController.state.detail!.albums.first.ref;
        final albumTile = find.byWidgetPredicate(
          (w) =>
              w is CatalogEntityTile &&
              w.entity.ref.identityKey == firstAlbum.identityKey,
        );
        await tester.scrollUntilVisible(
          albumTile,
          250,
          scrollable: find.descendant(
            of: find.byType(ArtistScreen),
            matching: find.byType(Scrollable),
          ),
        );
        await tap(albumTile);
        await until(
          () =>
              tester
                  .widget<AlbumScreen>(find.byType(AlbumScreen))
                  .controller
                  .state
                  .detail !=
              null,
          'Album nested detail',
        );
        expect(
          identical(
            artistController,
            tester.widget<AlbumScreen>(find.byType(AlbumScreen)).controller,
          ),
          isFalse,
        );
        await capture('supp-05-album');
        await tap(find.text('Слушать').first);
        await until(
          () => app.playback.snapshot.entries.length == 12,
          'Album plays exact12 tracks',
        );
        await back();
        expect(
          identical(
            artistController,
            tester.widget<ArtistScreen>(find.byType(ArtistScreen)).controller,
          ),
          isTrue,
        );
        await back();
        expect(find.byType(SearchScreen), findsOneWidget);
        // Returning from detail restores the retained search field's focus.
        // Android Back dismisses its IME before the root navigation is shown.
        if (tester.view.viewInsets.bottom > 0) await back();
        await until(
          () => tester.view.viewInsets.bottom == 0,
          'Search IME dismissed before root navigation',
        );
        expect(find.byType(SearchScreen), findsOneWidget);
        await tap(find.text('Главная').last);
        await frames.device(width: 320, scale: 2);
        await until(
          () =>
              tester.view.physicalSize.width / tester.view.devicePixelRatio ==
                  320 &&
              MediaQuery.textScalerOf(tester.element(find.byType(OwnerShell)))
                      .scale(16) ==
                  32 &&
              find.text('Разделы: Главная').hitTestable().evaluate().length ==
                  1,
          'Native viewport and large-text navigation have rebuilt',
        );
        await tap(find.text('Разделы: Главная'));
        await tap(find.text('Поиск').last);
        final compactSearch = find.descendant(
          of: find.byType(SearchScreen),
          matching: find.byType(TextField),
        );
        await tap(compactSearch);
        await tester.enterText(compactSearch, 'Тихие города');
        await until(
          () => tester.view.viewInsets.bottom > 0,
          'Actual Android search IME at320dp and2x text',
        );
        expect(compactSearch.hitTestable(), findsOneWidget);
        await capture('supp-05b-search-ime-320-2x');
        await back();
        await until(
          () => tester.view.viewInsets.bottom == 0,
          'Compact search IME dismissed before section switch',
        );
        await tap(find.text('Разделы: Поиск'));
        await tap(find.text('Главная').last);
        await frames.device();
        await tap(find.byTooltip('Настройки'));
        await tap(find.text('Воспроизведение').first);
        await tap(find.text('Высокое · 320 кбит/с'));
        await until(
          () => session!.owner.quality.value == 'high',
          'Quality persisted by native owner',
        );
        await tap(find.text('Оригинальное'));
        await until(
          () => session!.owner.quality.value == 'original',
          'Quality restored explicitly',
        );
        await back();
        await tap(find.text('Выйти из аккаунта'));
        await until(
          () => app.phase == AppPhase.signedOut,
          'Real broker logout revokes owner',
        );
        expect(
          (await pumping(
            'logout persisted fence',
            liveResources.sessions.read,
          )).owner,
          isNull,
        );
        await capture('supp-06-logged-out');
        expect(audioGraphs, 1);
        expect(ownerGraphs, 1);
        expect(fixture.unexpected, isEmpty);
        acceptedControls.add(
          'Home horizontal touch/mix40; Wave pause/resume/retune; next/shuffle/repeat; artist→album isolated route controllers and album12 playback; history; quality persist; actual broker logout',
        );
        return;
      }

      if (const bool.fromEnvironment('T24_SUPPLEMENT_ONLY')) {
        await supplementary();
        return;
      }
      if (const bool.fromEnvironment('T24_ROUTE_DIAG')) {
        await tap(find.text('Медиатека').last);
        await until(
          () => session!.library.state.collection.playlists.isNotEmpty,
          'Library loaded',
        );
        await tap(find.text('Вечер без спешки'));
        await capture('diag-playlist');
        return;
      }
      await tester.drag(find.byType(Scrollable).first, const Offset(0, -440));
      await settle();
      await capture('03-home-shelves-390');
      await tap(find.text('Волна').last);
      await capture('04-wave-idle-390');
      await tap(find.text('Начать волну').first);
      await until(
        () => app!.playback.snapshot.audible,
        'Actual native decoder reports playing',
      );
      await capture('05-wave-playing-390');
      await top(WaveScreen);
      await capture('05a-wave-playing-top-390');
      await tap(find.byTooltip('Настроить волну').first);
      await capture('06-wave-direction-390');
      await back();
      await tap(find.byType(MiniPlayer));
      await capture('07-full-player-390');
      expect(app.playback.snapshot.failure, isNull);
      expect(session!.player.failure, isNull);
      expect(session!.player.preference.failure, isNull);
      await tap(find.byTooltip('Открыть очередь'));
      await capture('07a-queue-390');
      await back();
      await tap(find.text('Текст').first);
      await capture('07b-lyrics-390');
      await back();
      await tap(find.text('Похожее').first);
      await capture('07c-related-390');
      await back();
      final preferred = app.playback.snapshot.currentEntry!;
      await tap(find.text('Нравится'));
      await until(
        () =>
            session!.preferences.current(preferred.track.ref).signal ==
                PreferenceSignal.like &&
            !session!.preferences.current(preferred.track.ref).pending,
        'Confirmed player like',
      );
      expect(
        fixture
            .preferences['yt:${(preferred.track.ref as YoutubeTrackRef).videoId}'],
        'thumbs_up',
      );
      await tap(find.text('Не нравится'));
      await until(
        () => app!.playback.snapshot.currentEntryId != preferred.entryId,
        'Wave dislike advances the same service queue',
      );
      await tap(find.text('В волну'));
      await tap(find.text('Отмена'));
      final beforeRadio = app.playback.snapshot.lineage;
      await tap(find.text('В волну'));
      await tap(find.text('Запустить'));
      await tap(find.text('Собрать радио'));
      await until(
        () => find.text('Слушать').evaluate().isNotEmpty,
        'Actual radio result',
      );
      await capture('07d-radio-390');
      await tap(find.text('Слушать'));
      await until(
        () => app!.playback.snapshot.lineage != beforeRadio,
        'Radio replaces one service queue',
      );
      await back();
      acceptedControls.add(
        'Full player queue/lyrics/related, confirmed like/dislike, radio Cancel and explicit generate/play; Android Back returned',
      );
      await app.playback.dispatch(const Pause());
      await tap(find.byTooltip('Свернуть плеер'));
      await tap(find.text('Поиск').last);
      final search = find.descendant(
        of: find.byType(SearchScreen),
        matching: find.byType(TextField),
      );
      await tester.enterText(search, 'После дождя');
      await settle(15);
      await capture('08-search-ime-390');
      await back();
      await capture('09-search-results-390');
      await tap(find.text('Медиатека').last);
      await until(
        () => session!.library.state.collection.playlists.isNotEmpty,
        'Library HTTP response',
      );
      await capture('10-library-390');
      await tap(find.text('Вечер без спешки'));
      await capture('11-playlist-390');
      await back();
      await tester.scrollUntilVisible(
        find.text('Дорога к морю'),
        250,
        scrollable: find.byType(Scrollable).first,
      );
      await tap(find.text('Дорога к морю'));
      await until(
        () =>
            tester
                .widget<PlaylistDetailScreen>(find.byType(PlaylistDetailScreen))
                .controller
                .state
                .detail
                ?.items
                .length ==
            100,
        'Large playlist first100 loaded',
      );
      final large = tester
          .widget<PlaylistDetailScreen>(find.byType(PlaylistDetailScreen))
          .controller;
      expect(large.state.failure, isNull);
      expect(large.state.detail!.total, 101);
      await capture('11a-large-playlist-390');
      final playlistRows = find.byWidgetPredicate(
        (w) =>
            w.key is ValueKey<String> &&
            (w.key! as ValueKey<String>).value.startsWith('playlist-row-'),
      );
      expect(playlistRows.evaluate().length, greaterThan(0));
      expect(
        playlistRows.evaluate().length,
        lessThan(30),
        reason: '101 tracks must not mount all rows',
      );
      await tester.scrollUntilVisible(
        find.text('Загрузить ещё'),
        500,
        maxScrolls: 40,
      );
      await tap(find.text('Загрузить ещё'));
      await until(
        () => large.state.detail?.items.length == 101,
        'Second page appended exact101 items',
      );
      expect(large.state.detail!.complete, isTrue);
      expect(playlistRows.evaluate().length, inExclusiveRange(0, 30));
      await capture('11b-large-playlist-page2-390');
      acceptedControls.add(
        '101-track playlist loaded100+1 pages, mounts1..29 actual playlist rows and retains exact item identity',
      );
      await back();
      await tap(find.text('Любимое').first);
      await capture('12-liked-390');
      await back();
      await tap(find.text('Загрузки').last);
      await capture('13-downloads-390');
      await tap(find.text('Главная').last);
      await tap(find.byTooltip('Настройки'));
      await capture('14-settings-390');
      await tap(find.text('Профиль').first);
      await tester.enterText(
        find.byType(TextField).first,
        'Synthetic Listener Updated',
      );
      await tap(find.text('Сохранить имя'));
      await until(
        () => fixture.settings['displayName'] == 'Synthetic Listener Updated',
        'Confirmed profile PATCH',
      );
      if (tester.view.viewInsets.bottom > 0) await back();
      await capture('15-profile-390');
      await back();
      await tap(find.text('Музыкальные вкусы').first);
      await capture('15a-tastes-390');
      await back();
      await tap(find.text('Воспроизведение').first);
      await capture('16-playback-settings-390');
      await back();
      await tap(find.text('Офлайн и загрузки').first);
      await capture('17-offline-settings-390');
      await tap(find.text('Офлайн-режим'));
      await until(
        () => session!.owner.policy.offline,
        'Explicit offline enabled',
      );
      await capture('17b-offline-enabled-390');
      await tap(find.text('Офлайн-режим'));
      await until(
        () => !session!.owner.policy.offline,
        'Explicit offline disabled',
      );
      await back();
      await tap(find.text('Аккаунт и безопасность').first);
      await capture('17a-account-390');
      await back();
      await tap(find.text('Входящие').first);
      await capture('18-inbox-390');
      await tap(find.text('Отметить прочитанным').first);
      await until(
        () => fixture.notifications.first['read'] == true,
        'Inbox read acknowledgement',
      );
      await back();
      await tap(find.text('Мои ссылки').first);
      await capture('19-shares-390');
      await back();
      await back();
      unawaited(
        session!.router.push(const AppDestination(AppRouteKind.importPlaylist)),
      );
      await settle();
      await capture('20-import-390');
      await tester.scrollUntilVisible(
        find.text('Тестовый импорт · готово'),
        250,
        scrollable: find.byType(Scrollable).first,
      );
      await tap(find.text('Тестовый импорт · готово'));
      expect(find.byType(ImportJobScreen), findsOneWidget);
      await capture('20a-import-job-390');
      await back();
      await back();
      await app.playback.dispatch(const Pause());
      for (final width in [320, 390, 430]) {
        for (final scale in [1.0, 2.0]) {
          await frames.device(width: width, scale: scale);
          await top(HomeScreen);
          await capture('matrix-home-$width-${scale.toInt()}x');
          await tap(find.byType(MiniPlayer));
          await capture('matrix-player-$width-${scale.toInt()}x');
          await tap(find.byTooltip('Свернуть плеер'));
        }
      }
      await frames.device(width: 844, height: 390);
      await top(HomeScreen);
      await capture('matrix-home-landscape');
      await tap(find.byType(MiniPlayer));
      await capture('matrix-player-landscape');
      await tap(find.byTooltip('Свернуть плеер'));
      await frames.device(width: 320, scale: 2, reduced: true);
      await top(HomeScreen);
      await capture('matrix-home-320-2x-reduced');
      await frames.device();
      await seedPhoneFile();
      await tap(find.text('Загрузки').last);
      await capture('21-phone-file-ready-390');
      await tap(find.byTooltip('Действия с треком «После дождя»'));
      await tap(find.text('Удалить с устройства'));
      await capture('21a-remove-confirmation-390');
      await tap(find.text('Оставить'));
      expect(session!.downloads.jobs.single.state, DownloadState.ready);
      await tap(find.byTooltip('Действия с треком «После дождя»'));
      await tap(find.text('Удалить с устройства'));
      await tap(find.text('Удалить'));
      await until(
        () => session!.downloads.jobs.isEmpty,
        'Confirmed phone-only removal',
      );
      acceptedControls.add(
        'Ready phone file Cancel retains it, explicit Delete removes it',
      );
      expect(fixture.unexpected, isEmpty);
      binding.reportData = {
        ...?binding.reportData,
        'requests': fixture.requests,
        'unexpected': fixture.unexpected,
        'audioGraphs': audioGraphs,
        'ownerGraphs': ownerGraphs,
        'owner': 't24-synthetic',
        'tls': 'localhost test CA, standard verification',
        'nativeStore': resources.sessions.database.path,
      };
      await tap(find.text('Главная').last);
      await supplementary();
    } finally {
      binding.reportData = {
        ...?binding.reportData,
        'requests': fixture.requests,
        'unexpected': fixture.unexpected,
        'frameworkErrors': frameworkErrors,
        'acceptedControls': acceptedControls,
        'downloadTelemetry': downloadTelemetry,
      };
      FlutterError.onError = originalErrorHandler;
      await tester.pumpWidget(const SizedBox.shrink());
      await app?.close();
      await frames.close();
      await fixture.close();
    }
  }, timeout: const Timeout(Duration(minutes: 20)));
}
