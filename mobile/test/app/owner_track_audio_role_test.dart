import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/app/owner_services.dart';
import 'package:soundspan/app/owner_ui_session.dart';
import 'package:soundspan/downloads/device_process_scope.dart';
import 'package:soundspan/playback/playback_controller.dart';

import '../support/collection_fixtures.dart';
import '../support/fake_tls_server.dart';
import '../support/media_fixtures.dart';
import '../support/wave_reporting_fixtures.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  // Exercise the verified loopback TLS transport outside widget tests.
  HttpOverrides.global = null;

  test('startup warms the role without holding a track menu open', () async {
    final requested = Completer<void>();
    final profile = Completer<String?>();
    var reads = 0;
    final session = await _session(() {
      reads++;
      if (!requested.isCompleted) requested.complete();
      return profile.future;
    });
    addTearDown(() {
      if (!profile.isCompleted) profile.complete('admin');
    });

    session.start();
    await requested.future.timeout(const Duration(seconds: 3));
    final fence = session.fence;
    final track = collectionTrack(1);
    expect(await session.canManageTrackAudio(track, fence), isFalse);

    profile.complete('admin');
    expect(await session.canManageTrackAudio(track, fence), isTrue);
    expect(
      await session.canManageTrackAudio(collectionTrack(2), fence),
      isTrue,
    );
    expect(reads, 1);

    await session.owner.policy.setOffline(true);
    expect(await session.canManageTrackAudio(track, fence), isFalse);
    expect(reads, 1);
  });

  test('a transient role failure can be retried on the next action', () async {
    var reads = 0;
    final session = await _session(() async => ++reads == 1 ? null : 'admin');
    final fence = session.fence;
    final track = collectionTrack(1);

    expect(await session.canManageTrackAudio(track, fence), isFalse);
    expect(await session.canManageTrackAudio(track, fence), isTrue);
    expect(reads, 2);
  });

  test('a confirmed listener role stays hidden and is reused', () async {
    var reads = 0;
    final session = await _session(() async {
      reads++;
      return 'user';
    });
    final fence = session.fence;

    expect(
      await session.canManageTrackAudio(collectionTrack(1), fence),
      isFalse,
    );
    expect(
      await session.canManageTrackAudio(collectionTrack(2), fence),
      isFalse,
    );
    expect(reads, 1);
  });
}

Future<OwnerUiSession> _session(Future<String?> Function() role) async {
  final server = await FakeTlsServer.start((request) async {
    final response = request.response;
    if (request.uri.path != '/api/auth/me') {
      response.statusCode = 404;
    } else {
      final value = await role();
      if (value == null) {
        response.statusCode = 503;
      } else {
        response.headers.contentType = ContentType.json;
        response.write(
          jsonEncode({
            'id': 'media-user',
            'username': 'listener',
            'role': value,
          }),
        );
      }
    }
    await response.close();
  });
  addTearDown(server.close);
  final authority = await mediaAuthority(server.origin);
  addTearDown(authority.invalidate);
  final fence = authority.requireFence();
  final root = await Directory.systemTemp.createTemp('soundspan-audio-role-');
  addTearDown(() => root.delete(recursive: true));
  final owner = await NativeOwnerServices.create(
    authority: authority,
    store: ReportingStore(),
    fence: fence,
    playback: CollectionPlayback(QueueSnapshot(fence: fence)),
    supportDirectory: Directory(await root.resolveSymbolicLinks()),
    cancelDownloads: (_) async {},
    securityContext: server.clientContext,
    processScope: const DeviceProcessScope.unknown(),
  );
  addTearDown(owner.close);
  final session = await OwnerUiSession.create(
    owner: owner,
    logout: () async {},
  );
  addTearDown(session.close);
  return session;
}
