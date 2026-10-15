import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/session/credential_vault.dart';
import 'package:soundspan/core/session/local_session_authority.dart';
import 'package:soundspan/core/session/session_broker_entrypoint.dart';
import 'package:soundspan/core/storage/owner_migrations.dart';
import 'package:soundspan/core/storage/sqlite_owner_store.dart';
import 'package:soundspan/core/storage/sqlite_session_store.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/queue_coordinator.dart';
import 'package:soundspan/playback/queue_snapshot_store.dart';
import 'package:sqflite/sqflite.dart';

import '../test/support/auth_fakes.dart' show MemoryVault;

@pragma('vm:entry-point')
Future<void> sessionBrokerMain() => runSessionBroker();

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  final owner = OwnerKey(
    serverOrigin: Uri.parse('https://queue-fixture.invalid'),
    userId: 'queue-A',
  );
  final otherOwner = OwnerKey(
    serverOrigin: owner.serverOrigin,
    userId: 'queue-B',
  );
  late SqliteSessionStore sessions;
  late QueueSnapshotStore checkpoints;
  late String path;

  Future<SessionFence> enter(OwnerKey owner) async {
    final persisted = await sessions.advance(owner);
    return SessionFence(owner: owner, epoch: persisted.epoch);
  }

  setUp(() async {
    path =
        '${(await getApplicationSupportDirectory()).path}/${SqliteSessionStore.fileName}';
    // Dedicated test installation on the reserved emulator, never user data.
    await deleteDatabase(path);
    sessions = await SqliteSessionStore.open();
    checkpoints = QueueSnapshotStore(SqliteOwnerStore(sessions));
  });
  tearDown(() async {
    await sessions.close();
    await deleteDatabase(path);
  });

  testWidgets(
    'SQLite reopen restores exact queue and coordinator waits for explicit resume',
    (tester) async {
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(() async {
        final vault = MemoryVault();
        LocalSessionAuthority authority() => LocalSessionAuthority(
          vault: vault,
          fenceStore: sessions,
          refreshTokens: (_, _) => throw StateError('fixture must not refresh'),
        );
        final firstAuthority = authority();
        await firstAuthority.establish(
          owner,
          const TokenPair(
            accessToken: 'fixture-access',
            refreshToken: 'fixture-refresh',
          ),
        );
        final fence = firstAuthority.requireFence();
        await checkpoints.save(_snapshot(fence), fence);
        await sessions.close();
        sessions = await SqliteSessionStore.open();
        checkpoints = QueueSnapshotStore(SqliteOwnerStore(sessions));
        final restoredAuthority = authority();
        await restoredAuthority.restore(owner.serverOrigin);
        final engine = _SpyEngine();
        final resolved = <String>[];
        final queue = QueueCoordinator(
          authority: restoredAuthority,
          engine: engine,
          prepare: (item, _) async {
            resolved.add(item.entryId);
            return PreparedAudio(
              uri: Uri.parse('http://127.0.0.1/controlled-fixture'),
              revoke: () async {},
            );
          },
        );
        try {
          final lineage = queue.snapshot.lineage;
          final restored = (await checkpoints.load(
            restoredAuthority.requireFence(),
          ))!;
          await queue.dispatch(
            RestoreQueue(
              restored,
              fence: restoredAuthority.requireFence(),
              expectedLineage: lineage,
            ),
          );
          expect(queue.snapshot.entries.map((e) => e.entryId), ['a', 'b', 'c']);
          expect(
            queue.snapshot.entries[0].track.ref,
            queue.snapshot.entries[1].track.ref,
          );
          expect(queue.snapshot.effectiveOrder, ['c', 'b', 'a']);
          expect(queue.snapshot.currentEntryId, 'b');
          expect(queue.snapshot.position, const Duration(seconds: 37));
          expect(queue.snapshot.shuffle, isTrue);
          expect(queue.snapshot.repeat, QueueRepeat.one);
          expect(
            queue.snapshot.currentEntry!.context.recommendationSessionId,
            'context-session',
          );
          expect(queue.snapshot.playingIntent, isFalse);
          expect(queue.snapshot.audible, isFalse);
          expect(queue.snapshot.processing, PlaybackProcessing.idle);
          expect(resolved, isEmpty);
          expect(engine.loads, 0);
          expect(engine.plays, 0);
          await queue.dispatch(const Resume());
          expect(resolved, ['b']);
          expect(engine.loads, 1);
          expect(engine.plays, 1);
          expect(engine.position, const Duration(seconds: 37));
          expect(engine.volume, 0.37);
          debugPrint(
            'T06_SQLITE_REOPEN_PASS current=b position=37 order=c,b,a autoplay=0 resumeSeek=37',
          );
        } finally {
          await queue.dispose();
        }
      });
    },
  );

  testWidgets(
    'SQLite owner isolation and same-owner ABA reject original writes',
    (tester) async {
      await tester.runAsync(() async {
        final first = await enter(owner);
        await checkpoints.save(_snapshot(first), first);
        final other = await enter(otherOwner);
        expect(await checkpoints.load(other), isNull);
        await checkpoints.clear(other);
        await sessions.advance(null);
        final again = await enter(owner);
        expect(again.epoch, greaterThan(first.epoch));
        await expectLater(
          checkpoints.save(_snapshot(first), first),
          throwsA(
            isA<AppFailure>().having((e) => e.code, 'code', 'session_revoked'),
          ),
        );
        await expectLater(checkpoints.clear(first), throwsA(isA<AppFailure>()));
        final restored = (await checkpoints.load(again))!;
        expect(restored.fence, again);
        expect(restored.position, const Duration(seconds: 37));
        debugPrint(
          'T06_SQLITE_ABA_PASS ownerIsolation=1 staleWrites=0 position=37',
        );
      });
    },
  );

  testWidgets(
    'SQLite corrupt JSON and future queue schema recover without deletion',
    (tester) async {
      await tester.runAsync(() async {
        final fence = await enter(owner);
        final owners = SqliteOwnerStore(sessions);
        await owners.transaction(
          fence,
          (tx) => tx.write('queue', 'snapshot', {'version': 999}),
        );
        expect(await checkpoints.load(fence), isNull);
        expect(
          await owners.transaction(fence, (tx) => tx.read('queue', 'snapshot')),
          {'version': 999},
        );
        await sessions.database.update(OwnerMigrations.recordsTable, {
          'payload': Uint8List.fromList([0x5b, 0x21]),
        });
        expect(await checkpoints.load(fence), isNull);
        final rows = await sessions.database.query(
          OwnerMigrations.recordsTable,
        );
        expect(rows, hasLength(1));
        Object? deep = 0;
        for (var i = 0; i < 40; i++) {
          deep = [deep];
        }
        await sessions.database.update(OwnerMigrations.recordsTable, {
          'payload': Uint8List.fromList(
            utf8.encode(jsonEncode({'nested': deep})),
          ),
        });
        expect(await checkpoints.load(fence), isNull);
        expect(
          await sessions.database.query(OwnerMigrations.recordsTable),
          hasLength(1),
        );
        await checkpoints.save(_snapshot(fence), fence);
        expect((await checkpoints.load(fence))!.currentEntryId, 'b');
        debugPrint(
          'T06_SQLITE_CORRUPTION_PASS null=1 erased=0 recoverableSave=1',
        );
      });
    },
  );
}

QueueSnapshot _snapshot(SessionFence fence) => QueueSnapshot(
  entries: ['a', 'b', 'c'].map(
    (id) => QueueEntry(
      entryId: id,
      track: const Track(
        ref: LibraryTrackRef('duplicate-recording'),
        title: 'Synthetic',
        artist: 'Fixture',
      ),
      context: const PlayContext(
        surface: PlaySurface.wave,
        waveMode: WaveMode.familiar,
        recommendationGenerationId: 'context-generation',
        recommendationSessionId: 'context-session',
      ),
    ),
  ),
  effectiveOrder: ['c', 'b', 'a'],
  currentEntryId: 'b',
  fence: fence,
  position: const Duration(seconds: 37),
  duration: const Duration(minutes: 3),
  shuffle: true,
  repeat: QueueRepeat.one,
  volume: 0.37,
  playingIntent: true,
  audible: true,
  processing: PlaybackProcessing.ready,
);

/// Only the audio/device boundary is replaced; actual SQLite, codec, authority,
/// store sequencing and QueueCoordinator execute in the installed test app.
final class _SpyEngine implements PlaybackEngine {
  final controller = StreamController<EngineEvent>.broadcast();
  int loads = 0;
  int plays = 0;
  Duration position = Duration.zero;
  double volume = 1;
  @override
  Stream<EngineEvent> get events => controller.stream;
  @override
  Future<void> load(Uri uri, int generation) async {
    loads++;
  }

  @override
  Future<void> play() async {
    plays++;
  }

  @override
  Future<void> pause() async {}
  @override
  Future<void> stop() async {}
  @override
  Future<void> seek(Duration position) async {
    this.position = position;
  }

  @override
  Future<void> setVolume(double volume) async {
    this.volume = volume;
  }

  @override
  Future<void> dispose() => controller.close();
}
