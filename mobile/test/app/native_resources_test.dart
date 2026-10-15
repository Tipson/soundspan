import 'dart:convert';
import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/app/bootstrap_preferences.dart';
import 'package:soundspan/app/server_capabilities.dart';
import 'package:soundspan/app/owner_services.dart';
import 'package:soundspan/app/native_app_resources.dart';
import 'package:soundspan/playback/queue_coordinator.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/queue_snapshot_store.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/storage/owner_store.dart';
import 'package:soundspan/core/session/session_authority.dart';
import 'package:soundspan/downloads/download_models.dart';
import 'package:soundspan/downloads/download_checkpoint.dart';
import 'package:crypto/crypto.dart';

import '../support/collection_fixtures.dart';
import '../support/wave_reporting_fixtures.dart';
import '../support/fake_tls_server.dart';
import '../support/media_fixtures.dart';

void main() {
  late Directory root;
  setUp(() async {
    final base = await Directory('D:/CodexData/temp/soundspan-native-owner')
        .create(recursive: true);
    root = Directory(await (await base.createTemp()).resolveSymbolicLinks());
  });
  tearDown(() async => root.delete(recursive: true));

  test(
    'bootstrap origin is normalized and concurrent writes retain last intent',
    () async {
      final prefs = BootstrapPreferences(root);
      await Future.wait([
        prefs.saveOrigin(Uri.parse('https://FIRST.example:443/')),
        prefs.saveOrigin(Uri.parse('https://second.example:8443')),
      ]);
      expect(
        await prefs.readOrigin(),
        Uri.parse('https://second.example:8443'),
      );
      final data = jsonDecode(
        await File('${root.path}/bootstrap.json').readAsString(),
      );
      expect(data, {'version': 1, 'origin': 'https://second.example:8443'});
    },
  );

  test('bootstrap rejects corrupt values and never overwrites unexpected directory', () async {
    final prefs = BootstrapPreferences(root);
    final target = File('${root.path}/bootstrap.json');
    await target.writeAsString(
      '{"version":1,"origin":"https://a.example","token":"secret"}',
    );
    expect(await prefs.readOrigin(), isNull);
    await target.delete();
    await Directory(target.path).create();
    await expectLater(
      prefs.saveOrigin(collectionOrigin),
      throwsA(isA<FileSystemException>()),
    );
    expect(await Directory(target.path).exists(), isTrue);
  });

  test('capabilities filter actual server response and survive offline reconstruction', () async {
    final store = ReportingStore();
    final authority = CollectionAuthority();
    final transport = CollectionTransport((request, fence) {
      expect(request.path, '/api/system/features');
      expect(request.authenticated, isTrue);
      expect(fence, collectionFence);
      return const ApiResponse(200, {
        'discovery': false,
        'autoPlaylists': true,
        'federation': false,
        'audius': true,
        'loudnessTargetLufs': -18,
        'irrelevant': 'must not persist',
      });
    });
    final repository = ServerCapabilitiesRepository(
      transport: transport,
      store: store,
      authority: authority,
      fence: collectionFence,
      policy: const NetworkPolicy.online(),
    );
    await repository.refresh();
    expect(repository.state.value!.autoPlaylists, isTrue);
    expect(repository.state.value!.discovery, isFalse);
    expect(jsonEncode(store.records), isNot(contains('irrelevant')));
    final offline = ServerCapabilitiesRepository(
      transport: transport,
      store: store,
      authority: authority,
      fence: collectionFence,
      policy: const NetworkPolicy.offline(),
    );
    await offline.restore();
    await offline.refresh();
    expect(offline.state.value!.audius, isTrue);
    expect(transport.requests, hasLength(1));
    await repository.close();
    await offline.close();
  });

  test('malformed capabilities cannot enable features', () async {
    final repository = ServerCapabilitiesRepository(
      transport: CollectionTransport(
        (_, _) => const ApiResponse(200, {
          'discovery': 'true',
          'autoPlaylists': true,
          'federation': true,
        }),
      ),
      store: ReportingStore(),
      authority: CollectionAuthority(),
      fence: collectionFence,
      policy: const NetworkPolicy.online(),
    );
    await repository.refresh();
    expect(repository.state.value, isNull);
    await repository.close();
  });

  test('owner restores explicit offline before features and flushes paused duplicate queue', () async {
    final authority = CollectionAuthority();
    final store = ReportingStore();
    await store.transaction(
      collectionFence,
      (tx) => tx.write('settings', 'network', {'version': 1, 'offline': true}),
    );
    final queue = QueueCoordinator(
      authority: authority,
      engine: ReportingEngine(),
      prepare: (_, _) => throw StateError('No autoplay'),
    );
    final entries = queue.createEntries([
      collectionTrack(1),
      collectionTrack(1),
    ], const PlayContext(surface: PlaySurface.library));
    await queue.dispatch(
      RestoreQueue(
        QueueSnapshot(
          entries: entries,
          effectiveOrder: entries.map((e) => e.entryId),
          currentEntryId: entries.first.entryId,
          fence: collectionFence,
          position: const Duration(seconds: 7),
        ),
        fence: collectionFence,
        expectedLineage: queue.snapshot.lineage,
      ),
    );
    var cancellations = 0;
    final owner = await NativeOwnerServices.create(
      authority: authority,
      store: store,
      fence: collectionFence,
      playback: queue,
      supportDirectory: root,
      cancelDownloads: (_) async {
        cancellations++;
      },
    );
    expect(owner.policy.offline, isTrue);
    expect(cancellations, 1);
    await owner.close();
    expect(
      cancellations,
      1,
      reason: 'Normal process close preserves worker jobs',
    );
    expect(queue.snapshot.entries, hasLength(2));
    final saved = await QueueSnapshotStore(store).load(collectionFence);
    expect(saved!.position, const Duration(seconds: 7));
    expect(saved.entries.map((e) => e.entryId).toSet(), hasLength(2));
    await queue.dispose();
  });

  test(
    'owner quality reaches actual TLS source and offline revokes issued handle',
    () async {
      final qualities = <String?>[];
      var reads = 0;
      final server = await FakeTlsServer.start((request) async {
        reads++;
        qualities.add(request.uri.queryParameters['quality']);
        expect(request.headers.value('authorization'), 'Bearer initial');
        await sendAudio(request);
      });
      final authority = await mediaAuthority(server.origin);
      final fence = authority.requireFence();
      final queue = QueueCoordinator(
        authority: authority,
        engine: ReportingEngine(),
        prepare: (_, _) => throw StateError('No queue play in socket test'),
      );
      final owner = await NativeOwnerServices.create(
        authority: authority,
        store: ReportingStore(),
        fence: fence,
        playback: queue,
        supportDirectory: root,
        securityContext: server.clientContext,
        cancelDownloads: (_) async {},
      );
      final client = HttpClient();
      try {
        await owner.setQuality('low');
        final prepared = await owner.prepare(
          QueueEntry(
            entryId: 'tls-occurrence',
            track: const Track(
              ref: LibraryTrackRef('synthetic'),
              title: 'Synthetic',
              artist: 'Fixture',
            ),
            context: const PlayContext(surface: PlaySurface.library),
          ),
          fence,
        );
        final response = await (await client.getUrl(prepared.uri)).close();
        expect(await response.expand((b) => b).toList(), audioBytes);
        expect(qualities, ['low']);
        await owner.policy.setOffline(true);
        final rejected = await (await client.getUrl(prepared.uri)).close();
        expect(rejected.statusCode, 404);
        await rejected.drain<void>();
        expect(reads, 1);
        await prepared.revoke();
      } finally {
        client.close(force: true);
        await owner.close();
        await queue.dispose();
        await server.close();
      }
    },
  );

  test('owner close drains offline cancellation before same-owner epoch replacement', () async {
    final authority = CollectionAuthority();
    final gate = Completer<void>();
    final started = Completer<void>();
    final queue = QueueCoordinator(
      authority: authority,
      engine: ReportingEngine(),
      prepare: (_, _) => throw StateError('No autoplay'),
    );
    final owner = await NativeOwnerServices.create(
      authority: authority,
      store: ReportingStore(),
      fence: collectionFence,
      playback: queue,
      supportDirectory: root,
      cancelDownloads: (_) {
        if (!started.isCompleted) started.complete();
        return gate.future;
      },
    );
    final offline = owner.policy.setOffline(true);
    final observedOffline = offline.then<void>((_) {}, onError: (Object _) {});
    await started.future;
    authority.active = SessionFence(owner: collectionOwner, epoch: 3);
    authority.updates.add(authority.state);
    var closed = false;
    final closing = owner.close().then((_) {
      closed = true;
    });
    await Future<void>.delayed(Duration.zero);
    expect(closed, isFalse);
    gate.complete();
    await observedOffline;
    await closing;
    expect(closed, isTrue);
    await expectLater(
      owner.store.transaction(
        collectionFence,
        (tx) => tx.read('settings', 'network'),
      ),
      throwsA(isA<AppFailure>()),
    );
    await queue.dispose();
  });

  test(
    'deleted ready generation cannot escape a delayed prepare into decoder',
    () async {
      final authority = CollectionAuthority();
      final store = _HeldReadyStore();
      final queue = QueueCoordinator(
        authority: authority,
        engine: ReportingEngine(),
        prepare: (_, _) => throw StateError('No autoplay'),
      );
      final owner = await NativeOwnerServices.create(
        authority: authority,
        store: store,
        fence: collectionFence,
        playback: queue,
        supportDirectory: root,
        cancelDownloads: (_) async {},
      );
      final track = collectionTrack(1);
      final job = await owner.downloads.enqueue(
        track,
        'original',
        collectionFence,
      );
      final claim = (await owner.downloads.claim(
        job.id,
        collectionFence,
        job.generation,
      ))!;
      final file = await owner.downloads.paths.file(
        collectionOwner,
        job.id,
        claim.generation,
        claim.writer!,
        ready: true,
      );
      await file.writeAsBytes(audioBytes);
      await owner.downloads.updateClaim(
        claim,
        state: DownloadState.ready,
        release: true,
        checkpoint: DownloadCheckpoint(
          generation: claim.generation,
          claim: claim.writer!,
          bytes: audioBytes.length,
          sha256: sha256.convert(audioBytes).toString(),
        ),
      );
      store.remaining = 2;
      final pending = owner.prepare(
        QueueEntry(
          entryId: 'delayed',
          track: track,
          context: const PlayContext(surface: PlaySurface.library),
        ),
        collectionFence,
      );
      final rejected = expectLater(pending, throwsA(isA<AppFailure>()));
      await store.started.future;
      await owner.downloads.remove(job.id, collectionFence);
      store.gate.complete();
      await rejected;
      expect(await file.exists(), isFalse);
      await owner.close();
      await queue.dispose();
    },
  );

  test('owner store cannot borrow a replacement same-owner fence', () async {
    final authority = CollectionAuthority();
    final queue = QueueCoordinator(
      authority: authority,
      engine: ReportingEngine(),
      prepare: (_, _) => throw StateError('No autoplay'),
    );
    final owner = await NativeOwnerServices.create(
      authority: authority,
      store: ReportingStore(),
      fence: collectionFence,
      playback: queue,
      supportDirectory: root,
      cancelDownloads: (_) async {},
    );
    final next = SessionFence(owner: collectionOwner, epoch: 3);
    await expectLater(
      owner.store.transaction(
        next,
        (tx) => tx.write('settings', 'borrowed', {'accepted': true}),
      ),
      throwsA(isA<AppFailure>()),
    );
    await owner.close();
    await queue.dispose();
  });

  test(
    'offline intent revokes gateway before durable broker admission finishes',
    () async {
      var reads = 0;
      final server = await FakeTlsServer.start((request) async {
        reads++;
        await sendAudio(request);
      });
      final authority = _HeldOfflineAuthority()
        ..active = SessionFence(
          owner: OwnerKey(serverOrigin: server.origin, userId: 'offline-race'),
          epoch: 1,
        );
      final fence = authority.requireFence();
      final queue = QueueCoordinator(
        authority: authority,
        engine: ReportingEngine(),
        prepare: (_, _) => throw StateError('Unused'),
      );
      final owner = await NativeOwnerServices.create(
        authority: authority,
        store: ReportingStore(),
        fence: fence,
        playback: queue,
        supportDirectory: root,
        securityContext: server.clientContext,
        cancelDownloads: (_) async {},
      );
      final client = HttpClient();
      final prepared = await owner.prepare(
        QueueEntry(
          entryId: 'offline-race',
          track: collectionTrack(1),
          context: const PlayContext(surface: PlaySurface.library),
        ),
        fence,
      );
      final gate = Completer<void>();
      authority.gate = gate;
      final offline = owner.policy.setOffline(true);
      await authority.started.future;
      try {
        final response = await (await client.getUrl(prepared.uri)).close();
        await response.drain<void>();
        expect(response.statusCode, 404);
        expect(reads, 0);
      } finally {
        gate.complete();
        await offline;
        await prepared.revoke();
        client.close(force: true);
        await owner.close();
        await queue.dispose();
        await server.close();
      }
    },
  );

  test(
    'process entry transport rejects authenticated requests before HTTP',
    () async {
      final inner = CollectionTransport((_, _) => const ApiResponse(200, {}));
      final public = PublicEntryTransport(inner);
      await expectLater(
        public.send(
          ApiRequest(
            origin: collectionOrigin,
            method: ApiMethod.get,
            path: '/api/system/features',
          ),
          fence: collectionFence,
        ),
        throwsA(
          isA<AppFailure>().having((e) => e.code, 'code', 'invalid_api_target'),
        ),
      );
      expect(inner.requests, isEmpty);
      await public.send(
        ApiRequest(
          origin: collectionOrigin,
          method: ApiMethod.post,
          path: '/api/auth/register',
          authenticated: false,
          body: {'username': 'synthetic'},
        ),
      );
      expect(inner.requests.single.path, '/api/auth/register');
    },
  );

  test(
    'close immediately seals public owner writes while final checkpoint drains',
    () async {
      final authority = CollectionAuthority();
      final rawStore = ReportingStore();
      final queue = QueueCoordinator(
        authority: authority,
        engine: ReportingEngine(),
        prepare: (_, _) => throw StateError('Unused'),
      );
      final owner = await NativeOwnerServices.create(
        authority: authority,
        store: rawStore,
        fence: collectionFence,
        playback: queue,
        supportDirectory: root,
        cancelDownloads: (_) async {},
      );
      final closing = owner.close();
      await expectLater(
        owner.store.transaction(
          collectionFence,
          (tx) => tx.write('settings', 'late-write', {'accepted': true}),
        ),
        throwsA(isA<AppFailure>()),
      );
      await closing;
      expect(
        await QueueSnapshotStore(rawStore).load(collectionFence),
        isNotNull,
      );
      await queue.dispose();
    },
  );
  test(
    'refused removal leaves its ready file available for later playback',
    () async {
      final authority = CollectionAuthority();
      final preparing = Completer<void>();
      final source = Completer<PreparedAudio>();
      final queue = QueueCoordinator(
        authority: authority,
        engine: ReportingEngine(),
        prepare: (_, _) {
          preparing.complete();
          return source.future;
        },
      );
      final owner = await NativeOwnerServices.create(
        authority: authority,
        store: ReportingStore(),
        fence: collectionFence,
        playback: queue,
        supportDirectory: root,
        cancelDownloads: (_) async {},
      );
      final track = collectionTrack(1);
      final entry = QueueEntry(
        entryId: 'busy',
        track: track,
        context: const PlayContext(surface: PlaySurface.library),
      );
      final job = await owner.downloads.enqueue(
        track,
        'original',
        collectionFence,
      );
      final claim = (await owner.downloads.claim(
        job.id,
        collectionFence,
        job.generation,
      ))!;
      final file = await owner.downloads.paths.file(
        collectionOwner,
        job.id,
        claim.generation,
        claim.writer!,
        ready: true,
      );
      await file.writeAsBytes(audioBytes);
      await owner.downloads.updateClaim(
        claim,
        state: DownloadState.ready,
        release: true,
        checkpoint: DownloadCheckpoint(
          generation: claim.generation,
          claim: claim.writer!,
          bytes: audioBytes.length,
          sha256: sha256.convert(audioBytes).toString(),
        ),
      );
      final playing = queue.dispatch(
        ReplaceQueue([entry], fence: collectionFence),
      );
      await preparing.future;
      await expectLater(
        owner.downloads.remove(job.id, collectionFence),
        throwsA(isA<AppFailure>()),
      );
      source.complete(PreparedAudio(uri: file.uri, revoke: () async {}));
      await playing;
      try {
        final prepared = await owner.prepare(entry, collectionFence);
        expect(prepared.uri, file.uri);
        await prepared.revoke();
        expect(await file.exists(), isTrue);
      } finally {
        await owner.close();
        await queue.dispose();
      }
    },
  );

  test(
    'offline then online cannot revive an admitted old network prepare',
    () async {
      final authority = _HeldOfflineAuthority();
      final queue = QueueCoordinator(
        authority: authority,
        engine: ReportingEngine(),
        prepare: (_, _) => throw StateError('Unused'),
      );
      final owner = await NativeOwnerServices.create(
        authority: authority,
        store: ReportingStore(),
        fence: collectionFence,
        playback: queue,
        supportDirectory: root,
        cancelDownloads: (_) async {},
      );
      final gate = Completer<void>();
      authority.gate = gate;
      final pending = owner.prepare(
        QueueEntry(
          entryId: 'old-network',
          track: collectionTrack(1),
          context: const PlayContext(surface: PlaySurface.library),
        ),
        collectionFence,
      );
      await authority.started.future;
      await owner.policy.setOffline(true);
      await owner.policy.setOffline(false);
      final rejected = expectLater(pending, throwsA(isA<AppFailure>()));
      gate.complete();
      try {
        await rejected;
      } finally {
        await owner.close();
        await queue.dispose();
      }
    },
  );
}

class _HeldOfflineAuthority extends CollectionAuthority {
  Completer<void>? gate;
  final started = Completer<void>();
  @override
  Future<void> assertCurrent(SessionFence fence) async {
    final held = gate;
    gate = null;
    if (held != null) {
      started.complete();
      await held.future;
    }
    await super.assertCurrent(fence);
  }

  @override
  Future<AccessGrant> grantAccess(SessionFence fence, Uri exactOrigin) async =>
      AccessGrant(
        authStamp: AuthStamp(fence: fence, tokenRevision: 1),
        accessToken: 'synthetic',
      );
}

class _HeldReadyStore extends ReportingStore {
  int remaining = 0;
  final started = Completer<void>();
  final gate = Completer<void>();
  @override
  Future<T> transaction<T>(
    SessionFence fence,
    Future<T> Function(OwnerTransaction) operation,
  ) async {
    final result = await super.transaction(fence, operation);
    if (result is DeviceDownload &&
        result.state == DownloadState.ready &&
        remaining > 0 &&
        --remaining == 0) {
      started.complete();
      await gate.future;
    }
    return result;
  }
}
