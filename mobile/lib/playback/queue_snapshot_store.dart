import 'dart:convert';

import '../core/model/owner_key.dart';
import '../core/storage/music_codec.dart';
import '../core/storage/owner_store.dart';
import 'queue_snapshot.dart';
import 'recommendation_queue_policy.dart';

/// One service-owned writer, called directly by the ordered snapshot observer.
/// Captures JSON before the first await and serializes save/load/clear in call
/// order. UI/worker engines must not create competing queue writers. A caller
/// must not delay a snapshot asynchronously before calling save: position,
/// generation and lineage cannot order two seeks within the same playback run.
/// OwnerStore performs authoritative admission for the original captured fence.
final class QueueSnapshotStore {
  QueueSnapshotStore(this._owners);
  final OwnerStore _owners;
  Future<void> _tail = Future<void>.value();
  static const schemaVersion = 1;
  static const maxEntries = 2000;
  static const maxPayloadBytes = 4 * 1024 * 1024;
  static const _namespace = 'queue';
  static const _key = 'snapshot';
  static const _policyKey = 'recommendation-policy';

  /// Checkpoints portable metadata only. Failure never claims a durable save.
  Future<void> save(QueueSnapshot snapshot, SessionFence fence) {
    final Map<String, Object?> payload;
    final Map<String, Object?>? policy;
    try {
      if (snapshot.fence != null && snapshot.fence != fence) {
        throw ArgumentError('Queue snapshot belongs to another session');
      }
      if (snapshot.entries.length > maxEntries ||
          snapshot.effectiveOrder.length > maxEntries) {
        _invalid();
      }
      payload = {
        'version': schemaVersion,
        'entries': snapshot.entries.map(MusicCodec.encodeQueueEntry).toList(),
        'effectiveOrder': snapshot.effectiveOrder.toList(),
        'currentEntryId': snapshot.currentEntryId,
        'positionUs': snapshot.position.inMicroseconds,
        'durationUs': snapshot.duration?.inMicroseconds,
        'shuffle': snapshot.shuffle,
        'repeat': snapshot.repeat.name,
        'volume': snapshot.volume,
      };
      _decode(payload, fence);
      policy = RecommendationQueuePolicy.encode(snapshot);
    } catch (error, stack) {
      return Future<void>.error(error, stack);
    }
    return _ordered(
      () => _owners.transaction(fence, (tx) async {
        await tx.write(_namespace, _key, payload);
        if (policy == null) {
          await tx.remove(_namespace, _policyKey);
        } else {
          await tx.write(_namespace, _policyKey, policy);
        }
      }),
    );
  }

  /// Corrupt/unknown schemas are recoverable null without erasing owner data.
  /// Session revocation and actual storage errors retain their original type.
  Future<QueueSnapshot?> load(SessionFence fence) => _ordered(() async {
    return _owners.transaction(fence, (tx) async {
      final Map<String, Object?>? payload;
      try {
        payload = await tx.read(_namespace, _key);
      } on FormatException {
        return null;
      } on ArgumentError {
        // Namespace/key are valid code-owned constants. OwnerStore's JSON
        // freezer can reject corrupt payload depth/size with ArgumentError.
        // Confine this catch to reading; admission errors still propagate.
        return null;
      }
      if (payload == null) return null;
      Object? policy;
      try {
        policy = await tx.read(_namespace, _policyKey);
      } on FormatException {
        policy = const {'invalid': true};
      } on ArgumentError {
        policy = const {'invalid': true};
      }
      try {
        return _decode(payload, fence, policy);
      } on FormatException {
        return null;
      }
    });
  });

  Future<void> clear(SessionFence fence) => _ordered(
    () => _owners.transaction(fence, (tx) async {
      await tx.remove(_namespace, _key);
      await tx.remove(_namespace, _policyKey);
    }),
  );

  Future<T> _ordered<T>(Future<T> Function() operation) {
    final next = _tail.then((_) => operation());
    // Observe errors only on the internal ordering tail. The returned future
    // still reports its failure to the caller and subsequent calls can proceed.
    _tail = next.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return next;
  }

  QueueSnapshot _decode(
    Map<String, Object?> row,
    SessionFence fence, [
    Object? policyRow,
  ]) {
    const keys = {
      'version',
      'entries',
      'effectiveOrder',
      'currentEntryId',
      'positionUs',
      'durationUs',
      'shuffle',
      'repeat',
      'volume',
    };
    if (row.length != keys.length ||
        row.keys.any((key) => !keys.contains(key)) ||
        row['version'] is! int ||
        row['version'] != schemaVersion) {
      _invalid();
    }
    final rawEntries = row['entries'];
    final rawOrder = row['effectiveOrder'];
    if (rawEntries is! List ||
        rawEntries.length > maxEntries ||
        rawOrder is! List ||
        rawOrder.length > maxEntries) {
      _invalid();
    }
    // Bound leaves before JSON encoding so oversized scalar/nesting input
    // cannot cause an unbounded serialization here.
    final entries = rawEntries.map(MusicCodec.decodeQueueEntry).toList();
    final ids = entries.map((entry) => entry.entryId).toSet();
    if (ids.length != entries.length ||
        rawOrder.length != ids.length ||
        rawOrder.any((id) => id is! String || !ids.contains(id)) ||
        rawOrder.toSet().length != ids.length) {
      _invalid();
    }
    final current = row['currentEntryId'];
    if (entries.isEmpty
        ? current != null
        : current is! String || !ids.contains(current)) {
      _invalid();
    }
    final position = _duration(row['positionUs']);
    final duration = row['durationUs'] == null
        ? null
        : _duration(row['durationUs']);
    final shuffle = row['shuffle'];
    final volume = row['volume'];
    if (shuffle is! bool ||
        volume is! num ||
        !volume.isFinite ||
        volume < 0 ||
        volume > 1 ||
        (entries.isEmpty && position != Duration.zero)) {
      _invalid();
    }
    final repeat = switch (row['repeat']) {
      'off' => QueueRepeat.off,
      'one' => QueueRepeat.one,
      'all' => QueueRepeat.all,
      _ => _invalid(),
    };
    if (utf8.encode(jsonEncode(row)).length > maxPayloadBytes) _invalid();
    final policy = RecommendationQueuePolicy.decode(policyRow, entries);
    return QueueSnapshot(
      entries: entries,
      effectiveOrder: rawOrder.cast<String>(),
      currentEntryId: current as String?,
      fence: fence,
      position: position,
      duration: duration,
      shuffle: shuffle,
      repeat: repeat,
      volume: volume.toDouble(),
      recommendationExclusions: policy.exclusions,
      closedRecommendationScopes: policy.closedScopes,
      // Playback intent/resources/failure/generation deliberately use safe
      // defaults. Restored service admission belongs to the T04 command.
    );
  }

  Duration _duration(Object? value) {
    if (value is! int || value < 0 || value > MusicCodec.maxDurationUs) {
      _invalid();
    }
    return Duration(microseconds: value);
  }

  Never _invalid() =>
      throw const FormatException('Invalid persisted queue snapshot');
}
