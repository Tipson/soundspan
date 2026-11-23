// Standalone debug integration target. Preserve its app data between SIGKILL
// and reopening; it has no production entrypoint, server account or trust bypass.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:just_audio/just_audio.dart';
import 'package:path_provider/path_provider.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/session/auth_models.dart';
import 'package:soundspan/core/session/broker_client.dart';
import 'package:soundspan/core/session/native_auth_repository_proxy.dart';
import 'package:soundspan/core/session/native_session_authority_proxy.dart';
import 'package:soundspan/core/session/session_broker_protocol.dart';
import 'package:soundspan/core/storage/sqlite_owner_store.dart';
import 'package:soundspan/core/storage/sqlite_session_store.dart';
import 'package:soundspan/downloads/android_media_probe.dart';
import 'package:soundspan/downloads/download_models.dart';
import 'package:soundspan/downloads/download_repository.dart';
import 'package:soundspan/downloads/download_verifier.dart';
import 'package:soundspan/downloads/download_worker_bridge.dart';
import 'package:soundspan/downloads/private_media_paths.dart';

import 'background_download_test.dart' as fixture;
import 'support/download_test_tls.dart';
import 'support/synthetic_audio.dart';

@pragma('vm:entry-point')
Future<void> downloadWorkerMain() => fixture.downloadWorkerMain();
@pragma('vm:entry-point')
Future<void> sessionBrokerMain() => fixture.sessionBrokerMain();

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(
    const Directionality(
      textDirection: TextDirection.ltr,
      child: Center(child: Text('T08 process recovery fixture')),
    ),
  );
  unawaited(
    _run().catchError((Object error, StackTrace stack) {
      debugPrint('T08_RECOVERY_FAIL ${error.runtimeType}\n$stack');
    }),
  );
}

void _require(bool condition, String code) {
  if (!condition) throw StateError(code);
}

Future<void> _until(Future<bool> Function() ready, {int seconds = 150}) async {
  final timer = Stopwatch()..start();
  while (!await ready()) {
    if (timer.elapsed.inSeconds > seconds) throw StateError('recovery_timeout');
    await Future<void>.delayed(const Duration(milliseconds: 150));
  }
}

Future<void> _run() async {
  const bridge = DownloadWorkerBridge();
  final origin = Uri.parse('https://localhost:18888');
  final support = await (await getApplicationSupportDirectory())
      .resolveSymbolicLinks();
  final marker = File('$support/t08-recovery.json');
  final captured = await marker.exists()
      ? DownloadWorkRequest.decode(jsonDecode(await marker.readAsString()))
      : null;
  final ui = await NativeSessionAuthorityProxy.attach(
    BrokerClient(MethodChannelBrokerTransport()),
    ClientRole.ui,
    expectedFence: captured?.originalFence,
  );
  if (captured == null) {
    await NativeAuthRepositoryProxy(ui.client).login(
      LoginInput(origin: origin, username: 'fixture', password: 'fixture'),
    );
  }
  final fence = ui.requireFence();
  final sessions = await SqliteSessionStore.open();
  final owners = SqliteOwnerStore(sessions);
  final paths = await PrivateMediaPaths.create(
    Directory('$support/device-media'),
  );
  final repository = DownloadRepository(
    store: owners,
    authority: ui,
    paths: paths,
    verifier: const DownloadVerifier(probe: AndroidMediaProbe()),
    beforeRemove: (_) async {},
  );
  final bytes = syntheticWav(duration: const Duration(seconds: 30));
  final starts = <int>[];
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
      _require(
        request.headers.value('authorization') == 'Bearer test-access',
        'fixture_authorization',
      );
      var start = 0;
      final range = request.headers.value('range');
      if (range != null) {
        final match = RegExp(r'^bytes=(\d+)-$').firstMatch(range);
        _require(
          match != null &&
              request.headers.value('if-range') == '"recovery-wav"',
          'fixture_range',
        );
        start = int.parse(match![1]!);
        request.response.statusCode = 206;
        request.response.headers.set(
          'content-range',
          'bytes $start-${bytes.length - 1}/${bytes.length}',
        );
      }
      starts.add(start);
      request.response.headers.contentType = ContentType('audio', 'wav');
      request.response.headers.set('etag', '"recovery-wav"');
      request.response.contentLength = bytes.length - start;
      for (var at = start; at < bytes.length; at += 1024) {
        final end = at + 1024 < bytes.length ? at + 1024 : bytes.length;
        request.response.add(bytes.sublist(at, end));
        await request.response.flush();
        await Future<void>.delayed(const Duration(milliseconds: 20));
      }
      await request.response.close();
    } catch (_) {
      request.response.close().ignore();
    }
  });
  if (captured == null) {
    await owners.transaction(
      fence,
      (tx) => tx.write('settings', 'network', {'version': 1, 'offline': false}),
    );
    final job = await repository.enqueue(
      const Track(
        ref: LibraryTrackRef('process-recovery'),
        title: 'Recovery',
        artist: 'Fixture',
      ),
      'original',
      fence,
    );
    await bridge.schedule(job.id, job.originalFence, job.generation);
    await _until(
      () async => (await repository.status(job.id, fence))!.bytes >= 32768,
    );
    await marker.writeAsString(
      jsonEncode(
        DownloadWorkRequest(job.id, job.originalFence, job.generation).encode(),
      ),
      flush: true,
    );
    debugPrint(
      'T08_KILL_READY checkpoint=${(await repository.status(job.id, fence))!.bytes}',
    );
    await Completer<void>().future;
  } else {
    final old = (await repository.status(captured.downloadId, fence))!;
    _require(
      old.originalFence == captured.originalFence &&
          old.generation == captured.generation &&
          old.bytes > 0 &&
          old.state != DownloadState.ready,
      'captured_checkpoint',
    );
    final persistedBytes = old.bytes;
    debugPrint(
      'T08_REOPEN checkpoint=$persistedBytes epoch=${fence.epoch} generation=${old.generation}',
    );
    await bridge.schedule(
      captured.downloadId,
      captured.originalFence,
      captured.generation,
    );
    await _until(
      () async =>
          (await repository.status(captured.downloadId, fence))!.state ==
          DownloadState.ready,
    );
    final ready = (await repository.status(captured.downloadId, fence))!;
    _require(
      ready.originalFence == captured.originalFence &&
          ready.generation == captured.generation,
      'identity_changed',
    );
    _require(
      starts.any((offset) => offset >= persistedBytes),
      'missing_range_resume',
    );
    final file = await repository.openReady(
      ready.track.ref,
      ready.quality,
      fence,
    );
    _require(file != null && await file.length() == bytes.length, 'ready_file');
    await server.close(force: true);
    final player = AudioPlayer();
    try {
      final duration = await player.setFilePath(file!.path);
      _require(
        duration != null && duration.inSeconds == 30,
        'offline_duration',
      );
      await player.seek(const Duration(seconds: 2));
      unawaited(player.play());
      await _until(
        () async => player.position.inMilliseconds >= 2300,
        seconds: 10,
      );
      await player.stop();
    } finally {
      await player.dispose();
    }
    debugPrint(
      'T08_RECOVERY_PASS sameFence=true sameGeneration=true rangeOffset=${starts.last} bytes=${ready.bytes} offlineSeek=true',
    );
    await repository.remove(ready.id, fence);
    await marker.delete();
    await sessions.close();
    await ui.close();
  }
}
