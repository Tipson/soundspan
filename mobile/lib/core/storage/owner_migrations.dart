import 'package:sqflite/sqflite.dart';

/// Shared schema for every engine opening soundspan.sqlite. Session authority
/// lives in the existing session_control table; migrations never reset its epoch.
abstract final class OwnerMigrations {
  static const version = 2;
  static const recordsTable = 'owner_records';

  static Future<void> upgrade(DatabaseExecutor db, int from, int to) async {
    if (from < 2 && to >= 2) {
      await db.execute(
        'CREATE TABLE owner_records ('
        'origin TEXT NOT NULL, user_id TEXT NOT NULL, '
        'namespace TEXT NOT NULL, record_key TEXT NOT NULL, '
        'payload BLOB NOT NULL CHECK(typeof(payload)=\'blob\' AND length(payload) BETWEEN 2 AND 8388608), '
        'PRIMARY KEY(origin, user_id, namespace, record_key)) WITHOUT ROWID',
      );
    }
  }
}
