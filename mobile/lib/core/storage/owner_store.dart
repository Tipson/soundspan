import 'dart:convert';

import '../model/owner_key.dart';

/// Durable owner data admitted against the original persisted session fence.
/// Callbacks must await all operations and must not perform network/long file IO.
/// Tokens, signed URLs and media leases belong in their dedicated stores, never
/// in these JSON records. This is a caller contract, not a token-string filter.
abstract interface class OwnerStore {
  Future<T> transaction<T>(
    SessionFence fence,
    Future<T> Function(OwnerTransaction tx) operation,
  );
}

/// Valid only until its callback completes. There is no unscoped SQL interface.
/// Namespace and key are exact strings; neither is trimmed or case folded.
abstract interface class OwnerTransaction {
  Future<Map<String, Object?>?> read(String namespace, String key);
  Future<void> write(String namespace, String key, Map<String, Object?> value);
  Future<void> remove(String namespace, String key);

  /// Binary key order, strictly after [afterKey]. Pages may be shorter than
  /// [limit] because their combined encoded payload is bounded to 16 MiB.
  /// Continue with the last returned key until an empty page is returned.
  Future<List<OwnerRecord>> list(
    String namespace, {
    String? afterKey,
    int limit = 100,
  });
}

/// Detached, recursively immutable JSON object and its exact opaque key.
final class OwnerRecord {
  factory OwnerRecord({
    required String key,
    required Map<String, Object?> value,
  }) {
    validateOwnerStoreName(key, maxBytes: 512);
    final frozen = _freezeJson(
      value,
      0,
      Set<Object>.identity(),
      _JsonBudget(),
    ) as Map<String, Object?>;
    return OwnerRecord._(key, frozen);
  }
  const OwnerRecord._(this.key, this.value);

  static const maxPayloadBytes = 8 * 1024 * 1024;
  final String key;
  final Map<String, Object?> value;
}

/// Shared byte bounds for code-owned namespaces and opaque record keys.
/// Values are always bound SQL parameters; these are never SQL identifiers.
void validateOwnerStoreName(String value, {required int maxBytes}) {
  if (value.isEmpty ||
      value.length > maxBytes ||
      utf8.encode(value).length > maxBytes) {
    throw ArgumentError('Owner namespace or key exceeds bound');
  }
}

final class _JsonBudget {
  int remaining = OwnerRecord.maxPayloadBytes;
  void consume(int bytes) {
    remaining -= bytes;
    if (remaining < 0) {
      throw ArgumentError('Owner record exceeds payload bound');
    }
  }
}

Object? _freezeJson(
  Object? value,
  int depth,
  Set<Object> visiting,
  _JsonBudget budget,
) {
  if (depth > 32) throw ArgumentError('Owner JSON exceeds nesting bound');
  if (value == null || value is bool || value is int) {
    budget.consume(jsonEncode(value).length);
    return value;
  }
  if (value is double) {
    if (!value.isFinite) {
      throw ArgumentError('Owner JSON requires finite numbers');
    }
    budget.consume(jsonEncode(value).length);
    return value;
  }
  if (value is String) {
    if (value.length > OwnerRecord.maxPayloadBytes) {
      throw ArgumentError('Owner JSON string exceeds bound');
    }
    budget.consume(utf8.encode(jsonEncode(value)).length);
    return value;
  }
  if (value is! Map && value is! List) {
    throw ArgumentError('Owner data must contain JSON values only');
  }
  if (!visiting.add(value)) throw ArgumentError('Cyclic owner JSON');
  try {
    if (value is List) {
      if (value.length > OwnerRecord.maxPayloadBytes ~/ 2) {
        throw ArgumentError('Owner JSON collection exceeds bound');
      }
      budget.consume(2 + (value.isEmpty ? 0 : value.length - 1));
      return List<Object?>.unmodifiable(
        value.map((item) => _freezeJson(item, depth + 1, visiting, budget)),
      );
    }
    final object = value as Map;
    if (object.length > OwnerRecord.maxPayloadBytes ~/ 4) {
      throw ArgumentError('Owner JSON collection exceeds bound');
    }
    budget.consume(2 + (object.isEmpty ? 0 : object.length - 1));
    final result = <String, Object?>{};
    for (final entry in object.entries) {
      final key = entry.key;
      if (key is! String || key.length > OwnerRecord.maxPayloadBytes) {
        throw ArgumentError('Owner JSON requires bounded string keys');
      }
      budget.consume(utf8.encode(jsonEncode(key)).length + 1);
      result[key] = _freezeJson(entry.value, depth + 1, visiting, budget);
    }
    return Map<String, Object?>.unmodifiable(result);
  } finally {
    visiting.remove(value);
  }
}
