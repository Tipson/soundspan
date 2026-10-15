import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:soundspan/app/app_composition.dart';
import 'package:soundspan/app/app_environment.dart';
import 'package:soundspan/app/native_app_resources.dart';
import 'package:soundspan/app/owner_services.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/session/auth_models.dart';
import 'package:soundspan/core/session/auth_repository.dart';
import 'package:soundspan/core/session/local_session_authority.dart';
import 'package:soundspan/core/session/session_broker_entrypoint.dart';
import 'package:soundspan/core/session/session_broker_rpc_server.dart';
import 'package:soundspan/core/storage/sqlite_session_store.dart';
import 'package:soundspan/downloads/download_worker_entrypoint.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/service_playback_controller.dart';
import 'package:soundspan/playback/wave_continuation.dart';

import '../test/artwork/artwork_repository_test.dart' show png;
import '../test/support/auth_fakes.dart' show MemoryVault;
import '../test/support/media_fixtures.dart'
    show recordingRef, recordingPath, leasePath, renewedLeasePath;
import '../test/support/wave_reporting_fixtures.dart' show waveFeed;
import 'support/download_test_tls.dart';
import 'support/synthetic_audio.dart';

@pragma('vm:entry-point')
Future<void> downloadWorkerMain() => runDownloadWorker();

@pragma('vm:entry-point')
Future<void> sessionBrokerMain() async {
  WidgetsFlutterBinding.ensureInitialized();
  final sessions = await SqliteSessionStore.open();
  await sessions.advance(null);
  final client = _FixtureAuth();
  final authority = LocalSessionAuthority(
    vault: MemoryVault(),
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

class _FixtureAuth implements JsonHttpClient {
  @override
  Future<ApiResponse> send(ApiRequest request, {String? accessToken}) async {
    if (request.origin.host != 'localhost') {
      throw StateError('Loopback fixture only');
    }
    return switch (request.path) {
      '/api/auth/config' => const ApiResponse(200, {
        'localLoginEnabled': true,
        'oidcEnabled': false,
        'oidcProviderName': '',
      }),
      '/api/auth/login' => const ApiResponse(200, {
        'token': 'synthetic-access',
        'refreshToken': 'synthetic-refresh',
        'user': {'id': 'native-tls-composition'},
      }),
      '/api/auth/refresh' => const ApiResponse(200, {
        'token': 'synthetic-fresh',
        'refreshToken': 'synthetic-refresh-2',
      }),
      _ => throw StateError('Unexpected auth route'),
    };
  }
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'native composition protected TLS renewal, notification artwork and Wave without UI',
    (tester) async {
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(() async {
        final tls = SecurityContext()
          ..useCertificateChainBytes(utf8.encode(testCertificate))
          ..usePrivateKeyBytes(utf8.encode(testPrivateKey));
        final trust = SecurityContext(withTrustedRoots: false)
          ..setTrustedCertificatesBytes(utf8.encode(testCertificate));
        final server = await HttpServer.bindSecure(
          InternetAddress.loopbackIPv4,
          0,
          tls,
        );
        final origin = Uri.parse('https://localhost:${server.port}');
        final audio = syntheticWav(duration: const Duration(seconds: 30));
        final cover = await png();
        var expired = 0,
            unauthorized = 0,
            refreshed = 0,
            ranges = 0,
            waves = 0,
            plays = 0;
        final failures = <Object>[];
        final requests = <Future<void>>{};
        Future<void> respond(HttpRequest request) async {
          try {
            final path = request.uri.path;
            expect(
              request.headers.value('authorization'),
              startsWith('Bearer synthetic-'),
            );
            Future<void> json(Object body) async {
              request.response.headers.contentType = ContentType.json;
              request.response.write(jsonEncode(body));
              await request.response.close();
            }

            if (path == '/api/music-sources/resolve') {
              await request.drain<void>();
              return await json({
                'playback': {
                  'provider': 'yandex',
                  'leaseId': 'a' * 48,
                  'streamPath': leasePath,
                },
              });
            }
            if (path == leasePath) {
              expired++;
              request.response.statusCode = 410;
              await request.response.close();
              return;
            }
            if (path == recordingPath) {
              request.response.statusCode = 307;
              request.response.headers.set('location', renewedLeasePath);
              await request.response.close();
              return;
            }
            if (path == renewedLeasePath &&
                request.headers.value('authorization') ==
                    'Bearer synthetic-access') {
              unauthorized++;
              request.response.statusCode = 401;
              await request.response.close();
              return;
            }
            if (path == '/api/system/features') {
              return await json({
                'discovery': true,
                'autoPlaylists': false,
                'federation': false,
                'audius': false,
              });
            }
            if (path.startsWith('/api/library/cover-art')) {
              request.response.headers.contentType = ContentType(
                'image',
                'png',
              );
              request.response.add(cover);
              await request.response.close();
              return;
            }
            if (path == '/api/personalized/home') {
              waves++;
              return await json(
                waveFeed([
                  for (var i = 0; i < 4; i++)
                    'wave${waves.toString().padLeft(6, '0')}$i',
                ], cursor: waves),
              );
            }
            if (path.startsWith('/api/plays')) {
              plays++;
              await request.drain<void>();
              return await json({'id': 'synthetic-play-$plays'});
            }
            if (path.endsWith('/stream') ||
                path.startsWith('/api/youtube/stream/') ||
                path.startsWith('/api/ytmusic/stream/')) {
              if (request.headers.value('authorization') ==
                  'Bearer synthetic-fresh') {
                refreshed++;
              }
              final range = request.headers.value('range');
              var start = 0, end = audio.length - 1;
              if (range != null) {
                ranges++;
                final match = RegExp(r'^bytes=(\d+)-(\d*)$').firstMatch(range)!;
                start = int.parse(match[1]!);
                if (match[2]!.isNotEmpty) end = int.parse(match[2]!);
                request.response.statusCode = 206;
                request.response.headers.set(
                  'content-range',
                  'bytes $start-$end/${audio.length}',
                );
              }
              request.response.headers.set('content-type', 'audio/wav');
              request.response.headers.set('accept-ranges', 'bytes');
              request.response.headers.set('etag', '"synthetic-wav"');
              request.response.contentLength = end - start + 1;
              if (request.method != 'HEAD') {
                request.response.add(audio.sublist(start, end + 1));
              }
              await request.response.close();
              return;
            }
            throw StateError('Unexpected fixture route $path');
          } on SocketException {
            // Replacing the native source intentionally disconnects its range.
          } catch (error) {
            failures.add(error);
            await request.response.close();
          }
        }

        server.listen((request) {
          final operation = respond(request);
          requests.add(operation);
          unawaited(operation.whenComplete(() => requests.remove(operation)));
        });
        final resources = await NativeAppResources.open(defaultOrigin: origin);
        AppComposition? app;
        try {
          await resources.auth.login(
            LoginInput(
              origin: origin,
              username: 'synthetic',
              password: 'synthetic',
            ),
          );
          final fence = resources.authority.requireFence();
          app = await AppComposition.create(
            AppEnvironment(
              authority: resources.authority,
              auth: resources.auth,
              origin: origin,
              createPlayback: resources.environment.createPlayback,
              processReady: resources.environment.processReady,
              createOwner: (original, playback) => NativeOwnerServices.create(
                authority: resources.authority,
                store: resources.store,
                fence: original,
                playback: playback,
                supportDirectory: resources.supportDirectory,
                securityContext: trust,
              ),
              release: resources.close,
            ),
          );
          expect(app.phase, AppPhase.ready);
          expect(resources.authority.requireFence(), fence);
          final owner = app.owner! as NativeOwnerServices;
          final playback = app.playback as ServicePlaybackController;
          await owner.capabilities.refresh();
          expect(owner.capabilities.state.value!.discovery, isTrue);
          final entries = playback.createEntries([
            Track(
              ref: recordingRef,
              title: 'Synthetic exact recording',
              artist: 'Fixture',
              artwork: Uri.parse('native:cover'),
            ),
            const Track(
              ref: LibraryTrackRef('native-next'),
              title: 'Next synthetic',
              artist: 'Fixture',
            ),
          ], const PlayContext(surface: PlaySurface.library));
          await playback.dispatch(ReplaceQueue(entries, fence: fence));
          await _wait(() => playback.snapshot.audible);
          await _wait(
            () => playback.handler.mediaItem.value?.artUri?.scheme == 'file',
          );
          expect(playback.handler.mediaItem.value!.id, entries.first.entryId);
          expect(expired, greaterThan(0));
          expect(unauthorized, 1);
          expect(refreshed, greaterThan(0));
          await playback.handler.seek(const Duration(seconds: 10));
          await _wait(
            () => playback.snapshot.position >= const Duration(seconds: 10),
          );
          await playback.handler.skipToNext();
          await _wait(
            () =>
                playback.snapshot.currentEntryId == entries.last.entryId &&
                playback.snapshot.audible,
          );
          // No Home/Player widget is mounted. The same service graph owns refill.
          await owner.wave.start(const WaveSelection(), fence);
          await _wait(
            () =>
                playback.snapshot.audible &&
                playback.snapshot.entries.length == 4,
          );
          await playback.handler.skipToNext();
          await _wait(
            () => waves >= 2 && playback.snapshot.entries.length >= 8,
          );
          expect(
            ranges,
            greaterThan(0),
            reason: 'Ranges originate from the native decoder',
          );
          expect(failures, isEmpty);
          debugPrint(
            'NATIVE_OWNER_TLS_PASS expired=$expired unauthorized=$unauthorized refreshed=$refreshed ranges=$ranges wavePages=$waves localNotificationArt=1 serviceNext=1 UIWidgets=0',
          );
        } finally {
          if (app != null) {
            await app.close();
          } else {
            await resources.close();
          }
          await server.close(force: true);
          await Future.wait(requests.toList());
        }
      });
    },
    timeout: const Timeout(Duration(minutes: 2)),
  );
}

Future<void> _wait(bool Function() condition) async {
  final deadline = DateTime.now().add(const Duration(seconds: 20));
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) {
      throw TimeoutException('Native fixture condition');
    }
    await Future<void>.delayed(const Duration(milliseconds: 25));
  }
}
