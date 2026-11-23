import 'dart:async';

import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/storage/owner_store.dart';

/// Owner-keyed durable fixture survives controller disposal and fence renewal.
class ImportMemoryStore implements OwnerStore {
  final values = <String, Map<String, Object?>>{};
  bool failWrites = false;
  @override
  Future<T> transaction<T>(
    SessionFence fence,
    Future<T> Function(OwnerTransaction) operation,
  ) => operation(
    _Transaction(this, '${fence.owner.serverOrigin}|${fence.owner.userId}'),
  );
}

class _Transaction implements OwnerTransaction {
  _Transaction(this.store, this.owner);
  final ImportMemoryStore store;
  final String owner;
  String key(String ns, String id) => '$owner|$ns|$id';
  @override
  Future<Map<String, Object?>?> read(String ns, String id) async =>
      store.values[key(ns, id)];
  @override
  Future<void> write(String ns, String id, Map<String, Object?> value) async {
    if (store.failWrites) throw StateError('disk failure');
    store.values[key(ns, id)] = OwnerRecord(key: id, value: value).value;
  }

  @override
  Future<void> remove(String ns, String id) async {
    if (store.failWrites) throw StateError('disk failure');
    store.values.remove(key(ns, id));
  }

  @override
  Future<List<OwnerRecord>> list(
    String ns, {
    String? afterKey,
    int limit = 100,
  }) async => throw UnimplementedError();
}
