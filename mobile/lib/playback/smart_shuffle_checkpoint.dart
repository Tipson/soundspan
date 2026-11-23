import 'dart:convert';

import '../core/model/queue_entry.dart';
import '../core/storage/music_codec.dart';
import '../core/storage/owner_store.dart';

/// Optional metadata beside the unchanged legacy queue, bound to its exact
/// identities, contexts and order. An older client can safely ignore this row.
abstract final class SmartShuffleCheckpoint {
  static Map<String, Object?>? encode(
    List<QueueEntry> entries,
    List<String> order,
  ) {
    if (entries.every((entry) => entry.smartShuffle == null)) return null;
    final row = <String, Object?>{
      'v': 1,
      'order': order.toList(),
      'entries': [
        for (final entry in entries)
          {
            'entryId': entry.entryId,
            'ref': MusicCodec.encodeTrackRef(entry.track.ref),
            'context': MusicCodec.encodePlayContext(entry.context),
            'lineage': entry.smartShuffle?.toJson(),
          },
      ],
    };
    _decode(row, entries, order);
    if (utf8.encode(jsonEncode(row)).length > OwnerRecord.maxPayloadBytes) {
      throw const FormatException('Smart checkpoint too large');
    }
    return row;
  }

  /// Unknown/corrupt/stale optional metadata cannot discard a playable queue.
  static List<QueueEntry> restore(
    Object? row,
    List<QueueEntry> entries,
    List<String> order,
  ) {
    if (row == null) return entries;
    try {
      return _decode(row, entries, order);
    } catch (_) {
      return entries;
    }
  }

  static List<QueueEntry> _decode(
    Object? value,
    List<QueueEntry> entries,
    List<String> order,
  ) {
    Never invalid() =>
        throw const FormatException('Invalid optional smart checkpoint');
    if (value is! Map ||
        value.length != 3 ||
        value.keys.any((key) => !{'v', 'order', 'entries'}.contains(key)) ||
        value['v'] is! int ||
        value['v'] != 1 ||
        jsonEncode(value['order']) != jsonEncode(order)) {
      invalid();
    }
    final rows = value['entries'];
    if (rows is! List || rows.length != entries.length) invalid();
    final result = <QueueEntry>[];
    for (var i = 0; i < entries.length; i++) {
      final row = rows[i], entry = entries[i];
      if (row is! Map ||
          row.length != 4 ||
          row.keys.any(
            (key) => !{'entryId', 'ref', 'context', 'lineage'}.contains(key),
          ) ||
          row['entryId'] != entry.entryId ||
          jsonEncode(row['ref']) !=
              jsonEncode(MusicCodec.encodeTrackRef(entry.track.ref)) ||
          jsonEncode(row['context']) !=
              jsonEncode(MusicCodec.encodePlayContext(entry.context))) {
        invalid();
      }
      final raw = row['lineage'];
      if (raw == null) {
        result.add(entry);
        continue;
      }
      final meta = SmartShuffleLineage.fromJson(raw);
      if (entry.context.surface != PlaySurface.playlist ||
          (meta.injected
              ? entry.context.recommendationSessionId !=
                    'smart-shuffle:${meta.sessionId}'
              : entry.context.recommendationScopeKey != null)) {
        invalid();
      }
      result.add(entry.withSmartShuffle(meta));
    }
    return result;
  }
}
