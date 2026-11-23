import 'dart:convert';

import 'queue_snapshot.dart';
import 'queue_snapshot_store.dart';

/// Reuses the existing durable bound; original occurrences are never truncated.
const smartShufflePoolLimit = 50;
const smartShuffleSnapshotLimit = 5000;

List<QueueEntry> buildFiniteSmartShuffle({
  required List<QueueEntry> own,
  required List<String> itemIds,
  required List<QueueEntry> pool,
  required String playlistId,
  required String sessionId,
  required int seed,
}) {
  if (own.isEmpty ||
      own.length >= QueueSnapshotStore.maxEntries ||
      itemIds.length != own.length ||
      itemIds.toSet().length != own.length ||
      pool.length > smartShufflePoolLimit) {
    throw const FormatException('Invalid finite smart snapshot');
  }
  var hash = 2166136261;
  for (final unit in jsonEncode([
    for (var i = 0; i < own.length; i++)
      [itemIds[i], own[i].track.ref.identityKey],
  ]).codeUnits) {
    hash = ((hash ^ unit) * 16777619) & 0xffffffff;
  }
  final snapshotId = hash.toRadixString(16).padLeft(8, '0');
  final seen = own.map((entry) => entry.track.ref.identityKey).toSet();
  final candidates = pool
      .where(
        (entry) =>
            entry.track.playable && seen.add(entry.track.ref.identityKey),
      )
      .toList();
  var state = seed;
  for (var i = candidates.length - 1; i > 0; i--) {
    state = (state * 1664525 + 1013904223) & 0xffffffff;
    final j = state % (i + 1);
    final swap = candidates[i];
    candidates[i] = candidates[j];
    candidates[j] = swap;
  }
  final result = <QueueEntry>[];
  var cursor = 0;
  SmartShuffleLineage lineage(bool injected, String occurrence) =>
      SmartShuffleLineage(
        sessionId: sessionId,
        playlistId: playlistId,
        snapshotId: snapshotId,
        seed: seed,
        injected: injected,
        occurrenceId: occurrence,
        cursor: 0,
        enabled: true,
      );
  final capacity = QueueSnapshotStore.maxEntries - own.length;
  for (var i = 0; i < own.length; i++) {
    result.add(own[i].withSmartShuffle(lineage(false, 'own:${itemIds[i]}')));
    if (((i + 1) % 3 == 0 || (own.length < 3 && i == own.length - 1)) &&
        cursor < candidates.length &&
        cursor < capacity) {
      result.add(
        candidates[cursor].withSmartShuffle(
          lineage(true, 'injected:$sessionId:$cursor'),
        ),
      );
      cursor++;
    }
  }
  return result.map((entry) {
    final meta = entry.smartShuffle!;
    return entry.withSmartShuffle(
      SmartShuffleLineage(
        sessionId: meta.sessionId,
        playlistId: meta.playlistId,
        snapshotId: meta.snapshotId,
        seed: meta.seed,
        injected: meta.injected,
        occurrenceId: meta.occurrenceId,
        cursor: cursor,
        enabled: cursor > 0,
      ),
    );
  }).toList();
}

/// Future membership follows service order, including an ordinary shuffle.
List<QueueEntry> disableFiniteSmartShuffle(
  QueueSnapshot snapshot,
  String sessionId,
) {
  final index = snapshot.effectiveOrder.indexOf(snapshot.currentEntryId ?? '');
  if (index < 0) return snapshot.entries;
  final future = snapshot.effectiveOrder.skip(index + 1).toSet();
  return snapshot.entries
      .where(
        (entry) =>
            !(entry.smartShuffle?.sessionId == sessionId &&
                entry.smartShuffle!.injected &&
                future.contains(entry.entryId)),
      )
      .map(
        (entry) => entry.smartShuffle?.sessionId == sessionId
            ? entry.withSmartShuffle(entry.smartShuffle!.withEnabled(false))
            : entry,
      )
      .toList();
}
