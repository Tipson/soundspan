import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:audio_service/audio_service.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/session/auth_models.dart';
import 'package:soundspan/core/session/auth_repository.dart';
import 'package:soundspan/core/session/broker_client.dart';
import 'package:soundspan/core/session/local_session_authority.dart';
import 'package:soundspan/core/session/native_auth_repository_proxy.dart';
import 'package:soundspan/core/session/native_session_authority_proxy.dart';
import 'package:soundspan/core/session/secure_storage_credential_vault.dart';
import 'package:soundspan/core/session/session_broker_entrypoint.dart';
import 'package:soundspan/core/session/session_broker_protocol.dart';
import 'package:soundspan/core/session/session_broker_rpc_server.dart';
import 'package:soundspan/core/storage/sqlite_owner_store.dart';
import 'package:soundspan/core/storage/sqlite_session_store.dart';
import 'package:soundspan/downloads/android_media_probe.dart';
import 'package:soundspan/downloads/download_models.dart';
import 'package:soundspan/downloads/download_repository.dart';
import 'package:soundspan/downloads/download_verifier.dart';
import 'package:soundspan/downloads/download_worker_bridge.dart';
import 'package:soundspan/downloads/download_worker_entrypoint.dart';
import 'package:soundspan/downloads/private_media_paths.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/soundspan_audio_handler.dart';

import 'support/download_test_tls.dart';
import 'support/synthetic_audio.dart';

final _origin = Uri.parse('https://localhost:18888');

@pragma('vm:entry-point')
Future<void> downloadWorkerMain() => runDownloadWorker(
  testSecurityContext: SecurityContext(withTrustedRoots: false)
    ..setTrustedCertificatesBytes(utf8.encode(testCertificate)),
);

@pragma('vm:entry-point')
Future<void> sessionBrokerMain() async {
  WidgetsFlutterBinding.ensureInitialized();
  final store = await SqliteSessionStore.open();
  final client = _AuthFixture();
  final authority = LocalSessionAuthority(
    vault: SecureStorageCredentialVault(),
    fenceStore: store,
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

final class _AuthFixture implements JsonHttpClient {
  int refreshes = 0;
  @override
  Future<ApiResponse> send(ApiRequest request, {String? accessToken}) async {
    if (request.origin != _origin) throw StateError('Fixture only');
    if (request.path == '/api/auth/refresh') {
      await Future<void>.delayed(const Duration(milliseconds: 250));
      return ApiResponse(200, {
        'token': 'test-access-${++refreshes}',
        'refreshToken': 'test-refresh-$refreshes',
      });
    }
    return switch (request.path) {
      '/api/auth/login' => const ApiResponse(200, {
        'token': 'test-access',
        'refreshToken': 'test-refresh',
        'user': {'id': 'download-fixture'},
      }),
      '/api/auth/config' => const ApiResponse(200, {
        'localLoginEnabled': true,
        'oidcEnabled': false,
        'oidcProviderName': '',
      }),
      _ => throw StateError('Unexpected fixture route'),
    };
  }
}

Future<void> _until(
  Future<bool> Function() condition, {
  int seconds = 45,
}) async {
  final clock = Stopwatch()..start();
  while (!await condition()) {
    if (clock.elapsed.inSeconds > seconds) {
      throw StateError('Fixture deadline exceeded');
    }
    await Future<void>.delayed(const Duration(milliseconds: 150));
  }
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'WorkManager transfer with real broker SQLite decoder HOME and audio stop',
    (tester) async {
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(() async {
        const bridge = DownloadWorkerBridge();
        var ui = await NativeSessionAuthorityProxy.attach(
          BrokerClient(MethodChannelBrokerTransport()),
          ClientRole.ui,
        );
        var auth = NativeAuthRepositoryProxy(ui.client);
        await auth.login(
          LoginInput(origin: _origin, username: 'fixture', password: 'fixture'),
        );
        final fence = ui.requireFence();
        final sessions = await SqliteSessionStore.open();
        final owners = SqliteOwnerStore(sessions);
        await owners.transaction(
          fence,
          (tx) =>
              tx.write('settings', 'network', {'version': 1, 'offline': false}),
        );
        final canonicalSupport = await (await getApplicationSupportDirectory())
            .resolveSymbolicLinks();
        final root = Directory('$canonicalSupport/device-media');
        final paths = await PrivateMediaPaths.create(root);
        DownloadRepository makeRepository() => DownloadRepository(
          store: owners,
          authority: ui,
          paths: paths,
          verifier: const DownloadVerifier(probe: AndroidMediaProbe()),
          beforeRemove: (_) async {},
        );
        var repository = makeRepository();
        final bytes = syntheticWav(duration: const Duration(seconds: 10));
        final valid = File('${root.path}/fixture.wav');
        await valid.writeAsBytes(bytes);
        expect(
          (await const AndroidMediaProbe().probe(valid)).duration,
          const Duration(seconds: 10),
        );
        for (final malformed in [
          utf8.encode('<html>not audio</html>'),
          bytes.sublist(0, 100),
        ]) {
          final invalid = File('${root.path}/invalid.part');
          await invalid.writeAsBytes(malformed);
          await expectLater(
            const AndroidMediaProbe().probe(invalid),
            throwsA(anything),
          );
          await invalid.delete();
        }
        final outside = File(
          '${(await getApplicationSupportDirectory()).path}/outside.wav',
        );
        await outside.writeAsBytes(bytes);
        await expectLater(
          const AndroidMediaProbe().probe(outside),
          throwsA(anything),
        );
        await outside.delete();
        final credentials = <String>{};
        var requests = 0;
        final tls = SecurityContext()
          ..useCertificateChainBytes(utf8.encode(testCertificate))
          ..usePrivateKeyBytes(utf8.encode(testPrivateKey));
        final server = await HttpServer.bindSecure(
          InternetAddress.loopbackIPv4,
          18888,
          tls,
        );
        server.listen((request) async {
          try {
            requests++;
            final credential = request.headers.value('authorization') ?? '';
            credentials.add(credential);
            if (credential == 'Bearer test-access') {
              await Future<void>.delayed(const Duration(milliseconds: 300));
              request.response.statusCode = 401;
              await request.response.close();
              return;
            }
            if (credential != 'Bearer test-access-1') {
              request.response.statusCode = 403;
              await request.response.close();
              return;
            }
            if (request.uri.path.contains('holdoff')) {
              request.response.statusCode = 429;
              request.response.headers.set('retry-after', '120');
              await request.response.close();
              return;
            }
            request.response.headers.contentType = ContentType('audio', 'wav');
            request.response.headers.set('etag', '"native-fixture"');
            request.response.contentLength = bytes.length;
            for (var at = 0; at < bytes.length; at += 8192) {
              final end = at + 8192 < bytes.length ? at + 8192 : bytes.length;
              request.response.add(bytes.sublist(at, end));
              await request.response.flush();
              await Future<void>.delayed(const Duration(milliseconds: 150));
            }
            await request.response.close();
          } catch (_) {
            request.response.close().ignore();
          }
        });
        SoundspanAudioHandler? audio;
        try {
          audio = await SoundspanAudioHandler.create(
            authority: ui,
            prepare: (_, captured) async {
              await ui.assertCurrent(captured);
              return PreparedAudio(uri: valid.uri, revoke: () async {});
            },
          );
          final system = await AudioService.init(
            builder: () => audio!,
            config: const AudioServiceConfig(
              androidNotificationChannelId: 'ru.agentik007.soundspan.playback',
              androidNotificationChannelName: 'Soundspan',
            ),
          );
          final entries = audio.controller.createEntries([
            const Track(
              ref: LibraryTrackRef('local-audio'),
              title: 'Fixture',
              artist: 'Fixture',
            ),
          ], const PlayContext(surface: PlaySurface.library));
          await audio.controller.dispatch(ReplaceQueue(entries, fence: fence));
          final first = await repository.enqueue(
            const Track(
              ref: LibraryTrackRef('worker-one'),
              title: 'One',
              artist: 'Fixture',
            ),
            'original',
            fence,
          );
          final second = await repository.enqueue(
            const Track(
              ref: LibraryTrackRef('worker-two'),
              title: 'Two',
              artist: 'Fixture',
            ),
            'original',
            fence,
          );
          final work = await bridge.schedule(first.id, fence, first.generation);
          expect(
            await bridge.schedule(first.id, fence, first.generation),
            work,
          );
          await bridge.schedule(second.id, fence, second.generation);
          await _until(() async => requests >= 4);
          await system.stop();
          await audio.dispose();
          audio = null;
          await ui.close();
          final retained = await const MethodChannel(
            'soundspan/session_probe_harness',
          ).invokeMapMethod<String, Object?>('stats');
          expect(retained!['clients'], greaterThanOrEqualTo(1));
          debugPrint('T08_HOME_READY audioStopped=true requests=$requests');
          await Future<void>.delayed(const Duration(seconds: 2));
          ui = await NativeSessionAuthorityProxy.attach(
            BrokerClient(MethodChannelBrokerTransport()),
            ClientRole.ui,
            expectedFence: fence,
          );
          // Release captured UI role and reattach unrestricted UI for later logout/login.
          await ui.close();
          ui = await NativeSessionAuthorityProxy.attach(
            BrokerClient(MethodChannelBrokerTransport()),
            ClientRole.ui,
          );
          auth = NativeAuthRepositoryProxy(ui.client);
          repository = makeRepository();
          await _until(
            () async =>
                (await repository.status(first.id, fence))?.state ==
                DownloadState.ready,
          );
          await _until(
            () async =>
                (await repository.status(second.id, fence))?.state ==
                DownloadState.ready,
          );
          final file = await repository.openReady(
            first.track.ref,
            first.quality,
            fence,
          );
          expect(file, isNotNull);
          expect(await file!.readAsBytes(), bytes);
          expect(credentials, {'Bearer test-access', 'Bearer test-access-1'});
          await _until(() async => await bridge.status(work) == 'SUCCEEDED');
          expect(
            (await const AndroidMediaProbe().probe(file)).duration,
            const Duration(seconds: 10),
          );
          // Android forbids starting a fresh dataSync FGS from a background UI
          // after the admitted workers finish. The native driver resumes the
          // Activity here before testing a new user-initiated cancellation.
          debugPrint('T08_FOREGROUND_REQUIRED');
          await Future<void>.delayed(const Duration(seconds: 3));
          final cancelled = await repository.enqueue(
            const Track(
              ref: LibraryTrackRef('cancel-worker'),
              title: 'Cancel',
              artist: 'Fixture',
            ),
            'original',
            fence,
          );
          final cancelledWork = await bridge.schedule(
            cancelled.id,
            fence,
            cancelled.generation,
          );
          await _until(
            () async =>
                (await repository.status(cancelled.id, fence))!.bytes > 0,
          );
          await bridge.cancelJob(cancelled.id, fence, cancelled.generation);
          await _until(
            () async => await bridge.status(cancelledWork) == 'CANCELLED',
          );
          await _until(
            () async =>
                (await repository.status(cancelled.id, fence))?.writer == null,
          );
          final stoppedJob = (await repository.status(cancelled.id, fence))!;
          expect(stoppedJob.state, DownloadState.paused);
          final checkpoint = stoppedJob.checkpoint!;
          final stoppedFile = await paths.file(
            fence.owner,
            stoppedJob.id,
            checkpoint.generation,
            checkpoint.claim,
          );
          final stoppedBytes = await stoppedFile.length();
          await Future<void>.delayed(const Duration(seconds: 2));
          expect(await stoppedFile.length(), stoppedBytes);
          expect(
            (await repository.status(cancelled.id, fence))!.bytes,
            stoppedJob.bytes,
          );
          final released = await const MethodChannel(
            'soundspan/session_probe_harness',
          ).invokeMapMethod<String, Object?>('stats');
          expect(released!['clients'], 1);
          await repository.cancel(cancelled.id, fence);
          final holdoff = await repository.enqueue(
            const Track(
              ref: LibraryTrackRef('holdoff'),
              title: 'Holdoff',
              artist: 'Fixture',
            ),
            'original',
            fence,
          );
          final heldWork = await bridge.schedule(
            holdoff.id,
            fence,
            holdoff.generation,
          );
          await _until(
            () async =>
                (await repository.status(holdoff.id, fence))!.retryNotBefore >
                    0 &&
                await bridge.status(heldWork) == 'ENQUEUED',
          );
          final due = (await repository.status(
            holdoff.id,
            fence,
          ))!.retryNotBefore;
          final info = await bridge.info(heldWork);
          expect(info!['nextRunMillis'] as int, greaterThanOrEqualTo(due));
          final requestsAtHoldoff = requests;
          expect(
            await bridge.schedule(holdoff.id, fence, holdoff.generation),
            heldWork,
          );
          await Future<void>.delayed(const Duration(seconds: 1));
          expect(requests, requestsAtHoldoff);
          await bridge.cancelJob(holdoff.id, fence, holdoff.generation);
          final noRequests = requests;
          await auth.logout();
          await auth.login(
            LoginInput(
              origin: _origin,
              username: 'fixture',
              password: 'fixture',
            ),
          );
          final fresh = ui.requireFence();
          expect(fresh.epoch, greaterThan(fence.epoch));
          final staleWork = await bridge.schedule(
            first.id,
            fence,
            first.generation,
          );
          await _until(
            () async => const {
              'SUCCEEDED',
              'FAILED',
            }.contains(await bridge.status(staleWork)),
          );
          expect(requests, noRequests);
          debugPrint(
            'T08_NATIVE_PASS decode=true duplicate=true sharedRefresh=1 home=true audioStop=true cancel=true staleNoHttp=true offlineFile=true holdoff=true',
          );
        } finally {
          await bridge.cancel(fence.owner);
          await audio?.dispose();
          await sessions.close();
          await ui.close();
          await server.close(force: true);
          if (await valid.exists()) await valid.delete();
        }
      });
    },
  );
}
