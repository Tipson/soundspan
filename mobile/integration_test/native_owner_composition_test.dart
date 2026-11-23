import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:soundspan/app/app_composition.dart';
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
import 'package:soundspan/downloads/android_media_probe.dart';
import 'package:soundspan/downloads/download_checkpoint.dart';
import 'package:soundspan/downloads/download_models.dart';
import 'package:soundspan/downloads/download_repository.dart';
import 'package:soundspan/downloads/download_verifier.dart';
import 'package:soundspan/downloads/download_worker_entrypoint.dart';
import 'package:soundspan/downloads/private_media_paths.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/queue_snapshot_store.dart';
import 'package:soundspan/playback/service_playback_controller.dart';

import '../test/support/auth_fakes.dart' show MemoryVault;
import 'support/synthetic_audio.dart';

final fixtureOrigin = Uri.parse('https://native-owner-fixture.invalid');

@pragma('vm:entry-point')
Future<void> downloadWorkerMain() => runDownloadWorker();

/// Native host/relay and SQLite are real. Only synthetic authentication replies
/// replace the external server; no real account or credential is read.
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
    if (request.origin != fixtureOrigin) {
      throw StateError('Synthetic origin only');
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
        'user': {'id': 'native-composition'},
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
    'live native broker, SQLite offline boot, decoder seek and safe current deletion',
    (tester) async {
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(() async {
        final resources = await NativeAppResources.open(
          defaultOrigin: Uri.parse('https://wrong-default.invalid'),
        );
        AppComposition? app;
        try {
          await resources.auth.login(
            LoginInput(
              origin: fixtureOrigin,
              username: 'synthetic',
              password: 'synthetic',
            ),
          );
          final fence = resources.authority.requireFence();
          await resources.store.transaction(
            fence,
            (tx) => tx.write('settings', 'network', {
              'version': 1,
              'offline': true,
            }),
          );
          final paths = await PrivateMediaPaths.create(
            Directory('${resources.supportDirectory.path}/device-media'),
          );
          final repository = DownloadRepository(
            store: resources.store,
            authority: resources.authority,
            paths: paths,
            verifier: const DownloadVerifier(probe: AndroidMediaProbe()),
            beforeRemove: (_) async {},
          );
          const track = Track(
            ref: LibraryTrackRef('synthetic-native-ready'),
            title: 'Синтетическая запись',
            artist: 'Локальная проверка',
          );
          final job = await repository.enqueue(track, 'medium', fence);
          // Isolated fixture account may retain a previous verified test file.
          if (job.state != DownloadState.ready) {
            final claim = (await repository.claim(
              job.id,
              fence,
              job.generation,
            ))!;
            final file = await paths.file(
              fence.owner,
              job.id,
              claim.generation,
              claim.writer!,
              ready: true,
            );
            await file.writeAsBytes(
              syntheticWav(duration: const Duration(seconds: 15)),
              flush: true,
            );
            final verified = await repository.verifier.verify(file);
            await repository.updateClaim(
              claim,
              checkpoint: DownloadCheckpoint(
                generation: claim.generation,
                claim: claim.writer!,
                bytes: verified.bytes,
                sha256: verified.sha256,
              ),
              state: DownloadState.ready,
              release: true,
            );
          }
          final entries = [
            QueueEntry(
              entryId: 'native-occurrence-a',
              track: track,
              context: const PlayContext(surface: PlaySurface.library),
            ),
            QueueEntry(
              entryId: 'native-occurrence-b',
              track: track,
              context: const PlayContext(surface: PlaySurface.library),
            ),
          ];
          await QueueSnapshotStore(resources.store).save(
            QueueSnapshot(
              entries: entries,
              effectiveOrder: entries.map((e) => e.entryId),
              currentEntryId: entries.first.entryId,
              fence: fence,
              position: const Duration(seconds: 2),
            ),
            fence,
          );
          app = await AppComposition.create(resources.environment);
          expect(app.phase, AppPhase.ready);
          expect(
            resources.authority.requireFence(),
            fence,
            reason: 'A second restore changes the live epoch',
          );
          final owner = app.owner! as NativeOwnerServices;
          final playback = app.playback as ServicePlaybackController;
          expect(owner.policy.networkAllowed, isFalse);
          expect(playback.snapshot.entries, hasLength(2));
          expect(playback.snapshot.playingIntent, isFalse);
          expect(playback.snapshot.position, const Duration(seconds: 2));
          await playback.handler.play();
          await _wait(
            playback,
            (s) => s.audible && s.position >= const Duration(seconds: 2),
          );
          await playback.handler.seek(const Duration(seconds: 6));
          expect(
            playback.snapshot.position,
            greaterThanOrEqualTo(const Duration(seconds: 6)),
          );
          await playback.handler.pause();
          expect(playback.snapshot.playingIntent, isFalse);
          await playback.handler.play();
          await _wait(playback, (s) => s.audible);
          await owner.downloads.remove(job.id, fence);
          expect(playback.snapshot.entries.map((e) => e.entryId), [
            'native-occurrence-a',
            'native-occurrence-b',
          ]);
          expect(playback.snapshot.currentEntryId, 'native-occurrence-a');
          expect(playback.snapshot.playingIntent, isFalse);
          expect(playback.snapshot.processing, PlaybackProcessing.idle);
          expect(
            await owner.downloads.openReady(track.ref, 'medium', fence),
            isNull,
          );
          await owner.checkpoint.checkpoint();
          final saved = (await QueueSnapshotStore(resources.store)
              .load(fence))!;
          expect(saved.entries, hasLength(2));
          expect(
            saved.position,
            greaterThanOrEqualTo(const Duration(seconds: 6)),
          );
          debugPrint(
            'NATIVE_OWNER_PASS liveFenceUnchanged=1 pausedRestore=1 nativeProbe=1 localSeek=6 duplicateQueue=2 currentDeletePreserved=1',
          );
        } finally {
          if (app != null) {
            await app.close();
          } else {
            await resources.close();
          }
        }
      });
    },
    timeout: const Timeout(Duration(minutes: 2)),
  );
}

Future<void> _wait(
  PlaybackController playback,
  bool Function(QueueSnapshot) predicate,
) async {
  if (predicate(playback.snapshot)) return;
  await playback.snapshots
      .firstWhere(predicate)
      .timeout(const Duration(seconds: 20));
}
