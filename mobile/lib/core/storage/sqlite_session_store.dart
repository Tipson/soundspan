import 'package:path_provider/path_provider.dart';
import 'package:sqflite/sqflite.dart';

import '../model/app_failure.dart';
import '../model/owner_key.dart';
import '../session/persisted_session_store.dart';
import 'owner_migrations.dart';

/// All owner stores/engines MUST use this database and session_control row.
/// Each engine owns its own handle; SQLite transactions enforce cross-engine
/// ordering. Never perform network/file preparation inside guardedTransaction.
final class SqliteSessionStore implements PersistedSessionStore {
  SqliteSessionStore(this.database);
  final Database database;
  static const fileName = 'soundspan.sqlite';
  static const controlTable = 'session_control';
  static Future<SqliteSessionStore> open() async {
    final directory = await getApplicationSupportDirectory();
    final database = await openDatabase(
      '${directory.path}/$fileName',
      singleInstance: false,
      version: OwnerMigrations.version,
      onConfigure: (db) async {
        await db.rawQuery('PRAGMA journal_mode=WAL');
        // sqflite Android shares one native worker between engine handles.
        // A blocking busy handler would starve the current writer's COMMIT.
        await db.rawQuery('PRAGMA busy_timeout=0');
      },
      onCreate: (db, version) async {
        await db.execute(
          'CREATE TABLE session_control (id INTEGER PRIMARY KEY CHECK (id=1), epoch INTEGER NOT NULL CHECK(epoch>=0), origin TEXT, user_id TEXT, tombstone INTEGER NOT NULL CHECK(tombstone IN (0,1)), CHECK((tombstone=1 AND origin IS NULL AND user_id IS NULL) OR (tombstone=0 AND origin IS NOT NULL AND user_id IS NOT NULL)))',
        );
        await db.insert(controlTable, {'id': 1, 'epoch': 0, 'tombstone': 1});
        await OwnerMigrations.upgrade(db, 1, version);
      },
      onUpgrade: OwnerMigrations.upgrade,
    );
    return SqliteSessionStore(database);
  }

  static Future<PersistedSession> readIn(DatabaseExecutor tx) async {
    final rows = await tx.query(controlTable, where: 'id = ?', whereArgs: [1]);
    if (rows.length != 1) throw StateError('Missing session control');
    final row = rows.single;
    return PersistedSession(
      epoch: row['epoch'] as int,
      tombstone: row['tombstone'] == 1,
      owner: row['origin'] == null
          ? null
          : OwnerKey(
              serverOrigin: Uri.parse(row['origin'] as String),
              userId: row['user_id'] as String,
            ),
    );
  }

  @override
  Future<PersistedSession> read() => readIn(database);
  @override
  Future<PersistedSession> advance(OwnerKey? owner) => _transaction((tx) async {
    final previous = await readIn(tx);
    if (previous.epoch >= 9223372036854775806) {
      throw StateError('Session epoch exhausted');
    }
    await tx.update(
      controlTable,
      {
        'epoch': previous.epoch + 1,
        'origin': owner?.serverOrigin.toString(),
        'user_id': owner?.userId,
        'tombstone': owner == null ? 1 : 0,
      },
      where: 'id = ?',
      whereArgs: [1],
    );
    return readIn(tx);
  });
  Future<T> guardedTransaction<T>(
    SessionFence fence,
    Future<T> Function(Transaction) operation,
  ) => _transaction((tx) async {
    if (!(await readIn(tx)).admits(fence)) {
      throw const AppFailure(
        code: 'session_revoked',
        message: 'Сессия завершена',
      );
    }
    return operation(tx);
  });

  Future<T> _transaction<T>(Future<T> Function(Transaction) operation) async {
    final clock = Stopwatch()..start();
    const timeout = Duration(seconds: 5);
    while (true) {
      var entered = false;
      try {
        return await database.transaction((tx) {
          entered = true;
          return operation(tx);
        });
      } on DatabaseException catch (error) {
        final details = error.result;
        // Only an unambiguous failed BEGIN may retry. Native sqflite resets its
        // transaction ID on this failure; no SQLite transaction has started.
        // Callback/COMMIT/ROLLBACK errors are never replayed.
        final failedBegin =
            !entered &&
            error.getResultCode() == 5 &&
            details is Map &&
            details['sql'] == 'BEGIN IMMEDIATE' &&
            details['arguments'] is List &&
            (details['arguments'] as List).isEmpty;
        if (!failedBegin || clock.elapsed >= timeout) rethrow;
        final remaining = timeout - clock.elapsed;
        await Future<void>.delayed(
          remaining < const Duration(milliseconds: 20)
              ? remaining
              : const Duration(milliseconds: 20),
        );
      }
    }
  }

  Future<void> close() => database.close();
}
