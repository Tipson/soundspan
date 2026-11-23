// Test-only APK target. The release target remains lib/main.dart.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:soundspan/app/app_composition.dart';
import 'package:soundspan/app/app_environment.dart';
import 'package:soundspan/app/native_app_resources.dart';
import 'package:soundspan/app/owner_services.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/dart_api_transport.dart';
import 'package:soundspan/core/session/auth_models.dart';
import 'package:soundspan/core/session/auth_repository.dart';
import 'package:soundspan/core/session/local_session_authority.dart';
import 'package:soundspan/core/session/secure_storage_credential_vault.dart';
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

import 'support/download_test_tls.dart';
import 'support/synthetic_audio.dart';

const _bridge = MethodChannel('soundspan/cold_owner_probe');
final _origin = Uri.parse('https://localhost:58931');
final _process = _open(); // Lazy, first widget build, matching production main.
int _audioGraphs = 0, _ownerGraphs = 0, _mainCalls = 0;
int _preparedCount = 0;
final _prepared = Completer<void>();
AppComposition? _app;
Object? _originalHandler, _originalOwner;
String _mode = 'unconfigured';

SecurityContext _trust() =>
    SecurityContext(withTrustedRoots: false)
      ..setTrustedCertificatesBytes(utf8.encode(testCertificate));

@pragma('vm:entry-point')
Future<void> downloadWorkerMain() => runDownloadWorker();

@pragma('vm:entry-point')
Future<void> sessionBrokerMain() async {
  WidgetsFlutterBinding.ensureInitialized();
  final store = await SqliteSessionStore.open();
  final client = _LoopbackJson();
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

class _LoopbackJson implements JsonHttpClient {
  final _client = DartJsonHttpClient(securityContext: _trust());
  @override
  Future<ApiResponse> send(ApiRequest request, {String? accessToken}) {
    if (request.origin != _origin) throw StateError('Synthetic localhost only');
    return _client.send(request, accessToken: accessToken);
  }
}

void main() {
  _mainCalls++;
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const _ProbeApp());
}

class _ProbeApp extends StatelessWidget {
  const _ProbeApp();
  @override
  Widget build(BuildContext context) => FutureBuilder<void>(
    future: _process,
    builder: (context, snapshot) => MaterialApp(
      home: Scaffold(
        body: Center(
          child: Text(
            snapshot.hasError
                ? 'Cold probe failed'
                : 'Synthetic cold owner probe',
          ),
        ),
      ),
    ),
  );
}

void _require(bool condition, String reason) {
  if (!condition) throw StateError(reason);
}

Future<void> _report(
  String stage, [
  Map<String, Object?> data = const {},
]) async {
  await _bridge.invokeMethod<void>('report', {
    'stage': stage,
    'mode': _mode,
    ...data,
  });
}

Future<Map<String, Object?>> _state() async {
  final native = await _bridge.invokeMapMethod<String, Object?>('nativeState');
  final app = _app;
  final playback = app?.playback as ServicePlaybackController?;
  final s = playback?.snapshot;
  return {
    ...?native,
    'mainCalls': _mainCalls,
    'audioGraphs': _audioGraphs,
    'ownerGraphs': _ownerGraphs,
    'preparedCount': _preparedCount,
    'phase': app?.phase.name,
    'sameHandler': playback == null
        ? null
        : identical(playback.handler, _originalHandler),
    'sameOwner': app == null ? null : identical(app.owner, _originalOwner),
    'epoch': app?.owner?.fence.epoch,
    'queue': s?.entries.map((e) => e.entryId).toList(),
    'current': s?.currentEntryId,
    'playing': s?.playingIntent,
    'decoderAdvancing': s?.audible,
    'positionMs': s?.position.inMilliseconds,
    'processing': s?.processing.name,
    'failure': s?.failure?.code,
  };
}

Future<void> _open() async {
  try {
    final configuration = (await _bridge.invokeMapMethod<String, Object?>(
      'configuration',
    ))!;
    _mode = configuration['mode']! as String;
    _require(
      configuration['activityCount'] == 0,
      'Activity existed before Dart bootstrap',
    );
    _require(_mainCalls == 1, 'Multiple default entrypoints');
    await _report('HEADLESS_FIRST_BUILD', configuration);
    _bridge.setMethodCallHandler((call) async {
      if (call.method == 'inspect') return _state();
      if (call.method == 'activityAttached') {
        final arguments = call.arguments as Map;
        _require(
          arguments['sameEngine'] == true,
          'Activity attached a different engine',
        );
        final state = await _state();
        _require(
          state['sameHandler'] == true && state['sameOwner'] == true,
          'Activity replaced owner or handler',
        );
        _require(
          _audioGraphs == 1 && _ownerGraphs == 1 && _mainCalls == 1,
          'Duplicate graph on attachment',
        );
        await _report('ATTACH_PASS', state);
        return state;
      }
      throw MissingPluginException();
    });
    if (_mode == 'seed') {
      await _seed();
      return;
    }
    _require(_mode == 'cold' || _mode == 'queued', 'Invalid mode');
    final resources = await NativeAppResources.open(defaultOrigin: _origin);
    final persisted = await resources.sessions.read();
    _require(
      persisted.owner?.userId == 'cold-synthetic' &&
          persisted.owner?.serverOrigin == _origin,
      'Missing synthetic persisted owner',
    );
    _require(
      resources.authority.state.fence == null,
      'Broker was already warm',
    );
    if (_mode == 'queued') {
      // Only controls arrival order in this test target. No product mutation:
      // the native MediaSession callback must already be in the pinned queue.
      final deadline = DateTime.now().add(const Duration(seconds: 5));
      Map<String, Object?> state;
      while (true) {
        state = await _state();
        if ((state['pendingMethods'] as List).contains('play')) break;
        _require(
          DateTime.now().isBefore(deadline),
          'Native play never entered the pending queue',
        );
        await Future<void>.delayed(const Duration(milliseconds: 25));
      }
      await _report('PENDING_NATIVE_PLAY_OBSERVED', state);
    }
    final native = resources.environment;
    final app = await AppComposition.create(
      AppEnvironment(
        authority: native.authority,
        auth: native.auth,
        origin: native.origin,
        createPlayback: (prepare) {
          _audioGraphs++;
          return native.createPlayback((entry, fence) async {
            final audio = await prepare(entry, fence);
            _preparedCount++;
            await _report('NATIVE_PREPARE_RESOLVED', {
              'entry': entry.entryId,
              'epoch': fence.epoch,
              'uriScheme': audio.uri.scheme,
              'preparedCount': _preparedCount,
            });
            if (!_prepared.isCompleted) _prepared.complete();
            return audio;
          });
        },
        createOwner: (fence, playback) {
          _ownerGraphs++;
          return native.createOwner(fence, playback);
        },
        release: native.release,
        processReady: native.processReady,
      ),
    );
    _app = app;
    _require(
      app.phase == AppPhase.ready,
      'Cold composition failed: ${app.failure?.code}',
    );
    final owner = app.owner! as NativeOwnerServices;
    final playback = app.playback as ServicePlaybackController;
    _originalHandler = playback.handler;
    _originalOwner = owner;
    _require(
      owner.fence.epoch == persisted.epoch,
      'Cold restore changed epoch',
    );
    _require(
      !owner.policy.networkAllowed,
      'Offline preference did not restore',
    );
    _require(playback.snapshot.entries.length == 2, 'Queue did not restore');
    _require(
      playback.snapshot.currentEntryId == 'cold-occurrence-a',
      'Current occurrence changed',
    );
    if (_mode == 'cold') {
      _require(
        playback.snapshot.position == const Duration(seconds: 2),
        'Position did not restore',
      );
      _require(!playback.snapshot.playingIntent, 'Restore auto-played');
    }
    final state = await _state();
    _require(
      state['activityCount'] == 0,
      'Activity attached during cold bootstrap',
    );
    _require(
      state['brokerStarts'] == 1 && state['clients'] == 1,
      'Duplicate broker/client',
    );
    _require(_audioGraphs == 1 && _ownerGraphs == 1, 'Duplicate graph');
    await _report(
      _mode == 'cold' ? 'PAUSED_RESTORE_PASS' : 'QUEUED_OWNER_RESTORED',
      state,
    );
    var reportedClock = false;
    playback.snapshots.listen((snapshot) {
      if (!reportedClock &&
          snapshot.audible &&
          snapshot.position > const Duration(seconds: 3)) {
        reportedClock = true;
        unawaited(_state().then((s) => _report('NATIVE_MEDIA_CLOCK_PASS', s)));
      }
    });
    if (_mode == 'queued') {
      // The shell-broadcast trigger may legitimately lack Android's foreground
      // service exemption. Admission through the real owner prepare is the
      // oracle; audibility/clock is separately tested after Activity attachment.
      await _prepared.future.timeout(const Duration(seconds: 5));
      final state = await _state();
      await _report('EARLY_COMMAND_RESULT', state);
      _require(
        _preparedCount == 1,
        'Native play queued before AudioService.configure did not prepare its restored owner exactly once',
      );
      await _report('EARLY_COMMAND_ADMISSION_PASS', state);
    }
  } catch (error, stack) {
    await _report('FAIL', {'error': '$error', 'stack': '$stack'});
    rethrow;
  }
}

Future<void> _seed() async {
  final server = await HttpServer.bindSecure(
    InternetAddress.loopbackIPv4,
    _origin.port,
    SecurityContext()
      ..useCertificateChainBytes(utf8.encode(testCertificate))
      ..usePrivateKeyBytes(utf8.encode(testPrivateKey)),
  );
  final requests = <String>[];
  server.listen((request) async {
    requests.add(request.uri.path);
    final raw = await utf8.decoder.bind(request).join();
    Object data;
    if (request.uri.path == '/api/auth/config') {
      data = {
        'localLoginEnabled': true,
        'oidcEnabled': false,
        'oidcProviderName': '',
      };
    } else if (request.uri.path == '/api/auth/login') {
      final body = jsonDecode(raw) as Map;
      _require(
        body['username'] == 'synthetic' && body['password'] == 'synthetic-only',
        'Wrong fixture login',
      );
      data = {
        'token': 'synthetic-cold-access',
        'refreshToken': 'synthetic-cold-refresh',
        'user': {'id': 'cold-synthetic'},
      };
    } else {
      request.response.statusCode = 500;
      data = {'error': 'Unexpected fixture route'};
    }
    request.response.headers.contentType = ContentType.json;
    request.response.write(jsonEncode(data));
    await request.response.close();
  });
  final resources = await NativeAppResources.open(defaultOrigin: _origin);
  try {
    final previous = (await resources.sessions.read()).owner;
    _require(
      previous == null ||
          (previous.serverOrigin.host == 'localhost' &&
              const {
                't24-synthetic',
                'cold-synthetic',
              }.contains(previous.userId)),
      'Refusing to replace non-fixture owner',
    );
    await resources.auth.login(
      LoginInput(
        origin: _origin,
        username: 'synthetic',
        password: 'synthetic-only',
      ),
    );
    final fence = resources.authority.requireFence();
    await resources.rememberOrigin(_origin);
    await resources.store.transaction(
      fence,
      (tx) => tx.write('settings', 'network', {'version': 1, 'offline': true}),
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
      ref: LibraryTrackRef('cold-synthetic-wav'),
      title: 'Synthetic cold WAV',
      artist: 'Acceptance fixture',
    );
    final job = await repository.enqueue(track, 'medium', fence);
    if (job.state != DownloadState.ready) {
      final claim = (await repository.claim(job.id, fence, job.generation))!;
      final file = await paths.file(
        fence.owner,
        job.id,
        claim.generation,
        claim.writer!,
        ready: true,
      );
      await file.writeAsBytes(
        syntheticWav(duration: const Duration(seconds: 90)),
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
      for (final id in ['cold-occurrence-a', 'cold-occurrence-b'])
        QueueEntry(
          entryId: id,
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
    _require(
      requests.length == 2 && requests.contains('/api/auth/login'),
      'Real TLS auth did not execute',
    );
    await _report('SEED_PASS', {
      'epoch': fence.epoch,
      'origin': _origin.toString(),
      'tlsRequests': requests,
      'queueEntries': 2,
      'nativeVerifiedWav': true,
      'audioGraphs': _audioGraphs,
    });
  } finally {
    await resources.close();
    await server.close(force: true);
  }
}
