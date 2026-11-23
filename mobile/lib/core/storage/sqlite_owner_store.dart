import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:sqflite/sqflite.dart';

import '../model/app_failure.dart';
import '../model/owner_key.dart';
import 'owner_migrations.dart';
import 'owner_store.dart';
import 'sqlite_session_store.dart';

/// Uses the authoritative session store's handle, path, WAL and control row.
/// It does not open another database or cache admission decisions.
final class SqliteOwnerStore implements OwnerStore {
  SqliteOwnerStore(SqliteSessionStore sessions) : _sessions = sessions;
  final SqliteSessionStore _sessions;
  static final Object _transactionZone = Object();

  @override
  Future<T> transaction<T>(
    SessionFence fence,
    Future<T> Function(OwnerTransaction) operation,
  ) async {
    if (Zone.current[_transactionZone] == true) {
      throw StateError('Nested owner transaction');
    }
    return _sessions.guardedTransaction(fence, (sql) {
      final scoped = _SqliteOwnerTransaction(sql, fence);
      return runZoned(() async {
        try {
          final result = await operation(scoped);
          final unfinished = scoped._inFlight > 0;
          scoped._active = false;
          await scoped._drain();
          if (unfinished) {
            throw StateError('Owner callback must await every operation');
          }
          return result;
        } finally {
          scoped._active = false;
          await scoped._drain();
        }
      }, zoneValues: {_transactionZone: true});
    });
  }
}

final class _SqliteOwnerTransaction implements OwnerTransaction {
  _SqliteOwnerTransaction(this._sql, this._fence);
  final Transaction _sql;
  final SessionFence _fence;
  bool _active = true;
  int _inFlight = 0;
  Future<void> _tail = Future<void>.value();
  final Set<Future<void>> _pending = {};
  static const _chunkBytes = 256 * 1024;
  static const _pageBytes = 16 * 1024 * 1024;
  static const _scope = 'origin = ? AND user_id = ? AND namespace = ?';
  static const _table = OwnerMigrations.recordsTable;

  List<Object?> _scopeArgs(String namespace) => [
    _fence.owner.serverOrigin.toString(),
    _fence.owner.userId,
    namespace,
  ];

  void _ensureActive() {
    if (!_active) throw StateError('Owner transaction callback completed');
  }

  Future<T> _run<T>(Future<T> Function(Future<void> previous) operation) {
    if (!_active) {
      return Future<T>.error(
        StateError('Owner transaction callback completed'),
      );
    }
    _inFlight++;
    final previous = _tail;
    final future = () async {
      try {
        return await operation(previous);
      } finally {
        _inFlight--;
      }
    }();
    // Observe detached failures and drain accepted operations before rollback.
    final settled = future.then<void>(
      (_) {},
      onError: (Object _, StackTrace _) {},
    );
    _tail = settled;
    _pending.add(settled);
    unawaited(
      settled.then((_) {
        _pending.remove(settled);
      }),
    );
    return future;
  }

  Future<void> _drain() async => Future.wait(_pending.toList());

  Future<void> _admit() async {
    _ensureActive();
    if (!(await SqliteSessionStore.readIn(_sql)).admits(_fence)) {
      throw const AppFailure(
        code: 'session_revoked',
        message: 'Сессия завершена',
      );
    }
    _ensureActive();
  }

  void _validate(String namespace, [String? key]) {
    validateOwnerStoreName(namespace, maxBytes: 64);
    if (key != null) validateOwnerStoreName(key, maxBytes: 512);
  }

  @override
  Future<Map<String, Object?>?> read(String namespace, String key) => _run((
    previous,
  ) async {
    _validate(namespace, key);
    await previous;
    await _admit();
    final sizes = await _sql.rawQuery(
      'SELECT length(payload) AS bytes FROM $_table WHERE $_scope AND record_key = ?',
      [..._scopeArgs(namespace), key],
    );
    if (sizes.isEmpty) return null;
    return (await _readChunks(
      namespace,
      key,
      _payloadSize(sizes.single['bytes']),
    )).value;
  });

  @override
  Future<void> write(
    String namespace,
    String key,
    Map<String, Object?> value,
  ) => _run((previous) async {
    _validate(namespace, key);
    // Snapshot before the first await: caller mutation cannot alter this write.
    final record = OwnerRecord(key: key, value: value);
    final payload = utf8.encode(jsonEncode(record.value));
    await previous;
    await _admit();
    await _sql.insert(_table, {
      'origin': _fence.owner.serverOrigin.toString(),
      'user_id': _fence.owner.userId,
      'namespace': namespace,
      'record_key': key,
      'payload': payload,
    }, conflictAlgorithm: ConflictAlgorithm.replace);
  });

  @override
  Future<void> remove(String namespace, String key) => _run((previous) async {
    _validate(namespace, key);
    await previous;
    await _admit();
    await _sql.delete(
      _table,
      where: '$_scope AND record_key = ?',
      whereArgs: [..._scopeArgs(namespace), key],
    );
  });

  @override
  Future<List<OwnerRecord>> list(
    String namespace, {
    String? afterKey,
    int limit = 100,
  }) => _run((previous) async {
    _validate(namespace, afterKey);
    if (limit < 1 || limit > 1000) {
      throw ArgumentError('Owner page limit must be 1..1000');
    }
    await previous;
    await _admit();
    final after = afterKey == null ? '' : ' AND record_key > ?';
    final args = [..._scopeArgs(namespace), ?afterKey];
    final metadata = await _sql.rawQuery(
      'SELECT record_key, length(payload) AS bytes FROM $_table WHERE $_scope$after ORDER BY record_key LIMIT ?',
      [...args, limit],
    );
    final selected = <({String key, int size})>[];
    var pageBytes = 0;
    for (final row in metadata) {
      final size = _payloadSize(row['bytes']);
      if (pageBytes + size > _pageBytes) break;
      selected.add((key: row['record_key'] as String, size: size));
      pageBytes += size;
    }
    if (selected.isEmpty) return const <OwnerRecord>[];
    // Small records share one cursor query. No per-record IPC on common pages;
    // only oversized rows need substr, avoiding Android's cursor row limit.
    final small = await _sql.rawQuery(
      'SELECT record_key, payload FROM $_table WHERE $_scope$after AND record_key <= ? AND length(payload) <= ? ORDER BY record_key',
      [...args, selected.last.key, _chunkBytes],
    );
    final records = <String, OwnerRecord>{};
    for (final row in small) {
      final key = row['record_key'] as String;
      records[key] = _decode(key, row['payload'] as Uint8List);
    }
    final result = <OwnerRecord>[];
    for (final row in selected) {
      _ensureActive();
      result.add(
        records[row.key] ?? await _readChunks(namespace, row.key, row.size),
      );
    }
    return List<OwnerRecord>.unmodifiable(result);
  });

  int _payloadSize(Object? value) {
    if (value is! int || value < 2 || value > OwnerRecord.maxPayloadBytes) {
      throw const FormatException('Invalid owner payload length');
    }
    return value;
  }

  Future<OwnerRecord> _readChunks(
    String namespace,
    String key,
    int size,
  ) async {
    final bytes = BytesBuilder(copy: false);
    for (var offset = 0; offset < size; offset += _chunkBytes) {
      _ensureActive();
      final rows = await _sql.rawQuery(
        'SELECT substr(payload, ?, ?) AS chunk FROM $_table WHERE $_scope AND record_key = ?',
        [offset + 1, _chunkBytes, ..._scopeArgs(namespace), key],
      );
      if (rows.length != 1 || rows.single['chunk'] is! Uint8List) {
        throw const FormatException('Missing owner payload chunk');
      }
      final chunk = rows.single['chunk'] as Uint8List;
      final expected = size - offset < _chunkBytes
          ? size - offset
          : _chunkBytes;
      if (chunk.length != expected) {
        throw const FormatException('Truncated owner payload');
      }
      bytes.add(chunk);
    }
    _ensureActive();
    return _decode(key, bytes.takeBytes());
  }

  OwnerRecord _decode(String key, Uint8List bytes) {
    if (bytes.length > OwnerRecord.maxPayloadBytes) {
      throw const FormatException('Oversized owner payload');
    }
    final decoded = jsonDecode(utf8.decode(bytes));
    if (decoded is! Map<String, Object?>) {
      throw const FormatException('Expected owner JSON object');
    }
    return OwnerRecord(key: key, value: decoded);
  }
}
