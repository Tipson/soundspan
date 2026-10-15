import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/storage/owner_store.dart';
import 'package:soundspan/core/storage/sqlite_owner_store.dart';
import 'package:soundspan/core/storage/sqlite_session_store.dart';
import 'package:sqflite/sqflite.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  final ownerA = OwnerKey(
    serverOrigin: Uri.parse('https://owner-fixture.invalid'),
    userId: ' opaque/ A\' ; DROP TABLE owner_records; -- ',
  );
  final ownerB = OwnerKey(serverOrigin: ownerA.serverOrigin, userId: 'B');
  final otherOrigin = OwnerKey(
    serverOrigin: Uri.parse('https://owner-fixture-b.invalid'),
    userId: ownerA.userId,
  );
  late String path;
  late SqliteSessionStore sessions;
  late SqliteOwnerStore owners;

  Future<SessionFence> enter(OwnerKey owner) async {
    final state = await sessions.advance(owner);
    return SessionFence(owner: owner, epoch: state.epoch);
  }

  final revoked = throwsA(
    isA<AppFailure>().having((e) => e.code, 'code', 'session_revoked'),
  );

  setUp(() async {
    path =
        '${(await getApplicationSupportDirectory()).path}/${SqliteSessionStore.fileName}';
    // Fixture application on the dedicated emulator; no server/account calls.
    await deleteDatabase(path);
    sessions = await SqliteSessionStore.open();
    owners = SqliteOwnerStore(sessions);
  });
  tearDown(() async {
    await sessions.close();
    await deleteDatabase(path);
  });

  testWidgets('real SQLite namespaces exact owner and origin; cold tombstone', (
    _,
  ) async {
    final a = await enter(ownerA);
    await owners.transaction(a, (tx) async {
      await tx.write('queue', 'same', {'position': 37});
      await tx.write('outbox', 'same', {'event': 'patch'});
    });
    final b = await enter(ownerB);
    expect(
      await owners.transaction(b, (tx) => tx.read('queue', 'same')),
      isNull,
    );
    await owners.transaction(
      b,
      (tx) => tx.write('queue', 'same', {'position': 99}),
    );
    final c = await enter(otherOrigin);
    expect(await owners.transaction(c, (tx) => tx.list('queue')), isEmpty);
    await expectLater(
      owners.transaction(a, (tx) => tx.read('queue', 'same')),
      revoked,
    );
    await sessions.advance(null);
    await sessions.close();
    sessions = await SqliteSessionStore.open();
    owners = SqliteOwnerStore(sessions);
    await expectLater(
      owners.transaction(c, (tx) => tx.read('queue', 'same')),
      revoked,
    );
    final freshA = await enter(ownerA);
    expect(freshA.epoch, greaterThan(a.epoch));
    expect(await owners.transaction(freshA, (tx) => tx.read('queue', 'same')), {
      'position': 37,
    });
    expect(
      await owners.transaction(freshA, (tx) => tx.read('outbox', 'same')),
      {'event': 'patch'},
    );
    await expectLater(
      owners.transaction(a, (tx) => tx.write('queue', 'same', {'position': 0})),
      revoked,
    );
  });

  testWidgets('rollback removes all writes and retains removed records', (
    _,
  ) async {
    final fence = await enter(ownerA);
    await owners.transaction(fence, (tx) => tx.write('queue', 'old', {'n': 1}));
    await expectLater(
      owners.transaction<void>(fence, (tx) async {
        await tx.remove('queue', 'old');
        await tx.write('queue', 'new', {'n': 2});
        throw StateError('abort fixture');
      }),
      throwsStateError,
    );
    expect(await owners.transaction(fence, (tx) => tx.read('queue', 'old')), {
      'n': 1,
    });
    expect(
      await owners.transaction(fence, (tx) => tx.read('queue', 'new')),
      isNull,
    );
  });

  testWidgets(
    'same owner epoch1 logout epoch3 never admits old captured fence',
    (_) async {
      final first = await enter(ownerA);
      expect(first.epoch, 1);
      await owners.transaction(first, (tx) async {
        final value = <String, Object?>{'position': 37};
        final write = tx.write('queue', 'snapshot', value);
        value['position'] = 99;
        await write;
      });
      expect((await sessions.advance(null)).epoch, 2);
      final fresh = await enter(ownerA);
      expect(fresh.epoch, 3);
      await expectLater(
        owners.transaction(first, (tx) => tx.read('queue', 'snapshot')),
        revoked,
      );
      await expectLater(
        owners.transaction(first, (tx) => tx.remove('queue', 'snapshot')),
        revoked,
      );
      expect(
        await owners.transaction(fresh, (tx) => tx.read('queue', 'snapshot')),
        {'position': 37},
      );
    },
  );

  testWidgets(
    'stable bounded after-key pages preserve exact keys and bind data',
    (_) async {
      final fence = await enter(ownerA);
      const keys = [' a ', "'; DELETE FROM session_control; --", 'a', 'b', 'я'];
      await owners.transaction(fence, (tx) async {
        for (final key in keys) {
          await tx.write('queue', key, {'key': key});
        }
      });
      final first = await owners.transaction(
        fence,
        (tx) => tx.list('queue', limit: 2),
      );
      final second = await owners.transaction(
        fence,
        (tx) => tx.list('queue', afterKey: first.last.key, limit: 2),
      );
      final third = await owners.transaction(
        fence,
        (tx) => tx.list('queue', afterKey: second.last.key, limit: 2),
      );
      expect([...first, ...second, ...third].map((e) => e.key), keys);
      expect(first.first.value, {'key': ' a '});
      expect(() => first.clear(), throwsUnsupportedError);
      await owners.transaction(fence, (tx) async {
        for (final invalid in ['', 'x' * 65]) {
          await expectLater(tx.read(invalid, 'key'), throwsArgumentError);
        }
        await expectLater(tx.list('queue', limit: 0), throwsArgumentError);
        await expectLater(tx.list('queue', limit: 1001), throwsArgumentError);
        await expectLater(tx.read('queue', ''), throwsArgumentError);
      });
    },
  );

  testWidgets(
    'completed callback and nested transactions fail without deadlock',
    (_) async {
      final fence = await enter(ownerA);
      late OwnerTransaction escaped;
      await owners.transaction(fence, (tx) async {
        escaped = tx;
        await expectLater(
          owners.transaction(fence, (_) async => 1),
          throwsStateError,
        );
        await tx.write('queue', 'ok', {'n': 1});
      });
      await expectLater(escaped.read('queue', 'ok'), throwsStateError);
      await expectLater(escaped.write('queue', 'late', {}), throwsStateError);
      Future<void>? detached;
      await expectLater(
        owners.transaction<void>(fence, (tx) async {
          detached = tx.write('queue', 'detached', {});
          // Register error handling before the callback completes.
          unawaited(detached!.then((_) {}, onError: (Object _) {}));
        }),
        throwsStateError,
      );
      await expectLater(detached!, throwsStateError);
      expect(
        await owners.transaction(fence, (tx) => tx.read('queue', 'detached')),
        isNull,
      );
    },
  );

  testWidgets(
    'two handles serialize writer then revoke; old fence cannot publish',
    (_) async {
      final fence = await enter(ownerA);
      final other = await SqliteSessionStore.open();
      try {
        final entered = Completer<void>();
        final release = Completer<void>();
        final writing = owners.transaction(fence, (tx) async {
          await tx.write('queue', 'before-revoke', {'n': 1});
          entered.complete();
          await release.future;
          await tx.write('queue', 'also-before', {'n': 2});
        });
        await entered.future;
        final revoking = other.advance(null);
        release.complete();
        await writing;
        await revoking;
        final secondStore = SqliteOwnerStore(other);
        await expectLater(
          secondStore.transaction(
            fence,
            (tx) => tx.read('queue', 'before-revoke'),
          ),
          revoked,
        );
        await expectLater(
          owners.transaction(
            fence,
            (tx) => tx.write('queue', 'after-revoke', {}),
          ),
          revoked,
        );
        final fresh = await enter(ownerA);
        expect(
          await secondStore.transaction(
            fresh,
            (tx) => tx.read('queue', 'before-revoke'),
          ),
          {'n': 1},
        );
        expect(
          await secondStore.transaction(
            fresh,
            (tx) => tx.read('queue', 'after-revoke'),
          ),
          isNull,
        );
      } finally {
        await other.close();
      }
    },
  );

  testWidgets(
    'concurrent awaited operations keep each list payload snapshot consistent',
    (_) async {
      final fence = await enter(ownerA);
      await owners.transaction(fence, (tx) => tx.write('queue', 'a', {'n': 1}));
      await owners.transaction(fence, (tx) async {
        final listing = tx.list('queue');
        final writing = tx.write('queue', 'a', {'data': 'x' * (512 * 1024)});
        final page = await listing;
        await writing;
        expect(page.single.value, {'n': 1});
        expect((await tx.read('queue', 'a'))!['data'], hasLength(512 * 1024));
      });
    },
  );

  testWidgets(
    'busy begin retries before callback only and leaves connection reusable',
    (_) async {
      final fence = await enter(ownerA);
      final other = await SqliteSessionStore.open();
      final release = Completer<void>();
      final entered = Completer<void>();
      var calls = 0;
      final writer = owners.transaction(fence, (tx) async {
        await tx.write('queue', 'held', {'n': 1});
        entered.complete();
        await release.future;
      });
      await entered.future;
      try {
        final pending = SqliteOwnerStore(other).transaction(fence, (tx) async {
          calls++;
          await tx.write('queue', 'after-wait', {'n': 2});
        });
        unawaited(pending.then((_) {}, onError: (Object _) {}));
        // Let the second handle attempt BEGIN while the writer still owns SQLite.
        await Future<void>.delayed(const Duration(milliseconds: 100));
        release.complete();
        await writer;
        await pending;
        expect(calls, 1);
        expect(await other.read().then((s) => s.admits(fence)), isTrue);
      } finally {
        if (!release.isCompleted) release.complete();
        await writer;
        await other.close();
      }
    },
  );

  testWidgets('busy begin has a bounded wait then the same handle works', (
    _,
  ) async {
    final fence = await enter(ownerA);
    final other = await SqliteSessionStore.open();
    final release = Completer<void>();
    final entered = Completer<void>();
    final writer = owners.transaction(fence, (tx) async {
      await tx.write('queue', 'held', {});
      entered.complete();
      await release.future;
    });
    await entered.future;
    try {
      var calls = 0;
      late DatabaseException blocked;
      final elapsed = Stopwatch()..start();
      await expectLater(
        other.guardedTransaction(fence, (_) async {
          calls++;
        }),
        throwsA(
          isA<DatabaseException>().having(
            (error) {
              blocked = error;
              return error.getResultCode();
            },
            'SQLITE_BUSY',
            5,
          ),
        ),
      );
      elapsed.stop();
      expect(calls, 0);
      expect(elapsed.elapsedMilliseconds, inInclusiveRange(4500, 7500));
      release.complete();
      await writer;
      // Reuse the real native BEGIN failure as a callback failure. Its SQL
      // details still say BEGIN; entered-callback protection must forbid replay.
      await expectLater(
        other.guardedTransaction<void>(fence, (_) async {
          calls++;
          throw blocked;
        }),
        throwsA(same(blocked)),
      );
      expect(calls, 1);
      await SqliteOwnerStore(other)
          .transaction(fence, (tx) => tx.write('queue', 'reused', {'n': 3}));
      expect(
        await owners.transaction(fence, (tx) => tx.read('queue', 'reused')),
        {'n': 3},
      );
    } finally {
      if (!release.isCompleted) release.complete();
      await writer;
      await other.close();
    }
  });

  testWidgets('nonbusy SQL callback errors are never replayed', (_) async {
    final fence = await enter(ownerA);
    var calls = 0;
    await expectLater(
      sessions.guardedTransaction(fence, (tx) async {
        calls++;
        await tx.rawQuery('SELECT * FROM missing_owner_fixture');
      }),
      throwsA(
        isA<DatabaseException>().having(
          (e) => e.isNoSuchTableError(),
          'missing table',
          true,
        ),
      ),
    );
    expect(calls, 1);
    expect(await sessions.read().then((s) => s.admits(fence)), isTrue);
  });

  testWidgets(
    'version1 migration preserves original durable control and epoch',
    (_) async {
      await sessions.close();
      await deleteDatabase(path);
      final old = await openDatabase(
        path,
        singleInstance: false,
        version: 1,
        onCreate: (db, _) async {
          await db.execute(
            'CREATE TABLE session_control (id INTEGER PRIMARY KEY CHECK (id=1), epoch INTEGER NOT NULL CHECK(epoch>=0), origin TEXT, user_id TEXT, tombstone INTEGER NOT NULL CHECK(tombstone IN (0,1)), CHECK((tombstone=1 AND origin IS NULL AND user_id IS NULL) OR (tombstone=0 AND origin IS NOT NULL AND user_id IS NOT NULL)))',
          );
          await db.insert('session_control', {
            'id': 1,
            'epoch': 41,
            'origin': ownerA.serverOrigin.toString(),
            'user_id': ownerA.userId,
            'tombstone': 0,
          });
        },
      );
      await old.close();
      sessions = await SqliteSessionStore.open();
      owners = SqliteOwnerStore(sessions);
      final preserved = await sessions.read();
      expect(preserved.owner, ownerA);
      expect(preserved.epoch, 41);
      expect(preserved.tombstone, isFalse);
      expect(await sessions.database.getVersion(), 2);
      final fence = SessionFence(owner: ownerA, epoch: 41);
      await owners.transaction(
        fence,
        (tx) => tx.write('queue', 'migrated', {'position': 37}),
      );
      expect((await sessions.advance(null)).epoch, 42);
      await expectLater(
        owners.transaction(fence, (tx) => tx.read('queue', 'migrated')),
        revoked,
      );
    },
  );

  testWidgets(
    'large UTF8 records roundtrip beyond Android cursor window with byte bounded pages',
    (_) async {
      final fence = await enter(ownerA);
      final payload = {'data': 'я' * (3 * 1024 * 1024), 'position': 37};
      await owners.transaction(fence, (tx) async {
        for (final key in ['a', 'b', 'c']) {
          await tx.write('queue', key, payload);
        }
      });
      final first = await owners.transaction(fence, (tx) => tx.list('queue'));
      expect(first.map((e) => e.key), ['a', 'b']);
      expect(first.first.value, payload);
      expect(() => first.first.value.clear(), throwsUnsupportedError);
      final last = await owners.transaction(
        fence,
        (tx) => tx.list('queue', afterKey: first.last.key),
      );
      expect(last.map((e) => e.key), ['c']);
      expect(last.single.value, payload);
    },
  );
}
