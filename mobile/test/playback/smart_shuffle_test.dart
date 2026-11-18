import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/storage/music_codec.dart';
import 'package:soundspan/playback/finite_smart_shuffle.dart';
import 'package:soundspan/playback/queue_snapshot.dart';
import 'package:soundspan/playback/queue_snapshot_store.dart';

import 'queue_restore_test.dart' show MemoryOwnerStore, fenceA;

QueueEntry ownEntry(int i, {String? recording}) => QueueEntry(
  entryId: 'own-$i',
  track: Track(
    ref: LibraryTrackRef(recording ?? 'a-$i'),
    title: 'Own $i',
    artist: 'Artist',
  ),
  context: const PlayContext(surface: PlaySurface.playlist),
);
QueueEntry injectedEntry(int i) => QueueEntry(
  entryId: 'pool-$i',
  track: Track(
    ref: LibraryTrackRef('pool-$i'),
    title: 'Pool $i',
    artist: 'Artist',
  ),
  context: const PlayContext(
    surface: PlaySurface.playlist,
    recommendationSessionId: 'smart-shuffle:session',
  ),
);
List<QueueEntry> build({int count = 7, List<QueueEntry>? pool}) =>
    buildFiniteSmartShuffle(
      own: List.generate(count, (i) => ownEntry(i, recording: 'same')),
      itemIds: List.generate(count, (i) => 'item-$i'),
      pool: pool ?? List.generate(50, injectedEntry),
      playlistId: 'playlist-1',
      sessionId: 'session',
      seed: 42,
    );

void main() {
  test(
    'cold checkpoint retains smart metadata beside legacy queue encoding',
    () async {
      const original = QueueEntry(
        entryId: 'queue-own-1',
        track: Track(
          ref: LibraryTrackRef('same-recording'),
          title: 'Песня',
          artist: 'Исполнитель',
        ),
        context: PlayContext(surface: PlaySurface.playlist),
      );
      final lineage = <String, Object?>{
        'v': 1,
        'sessionId': 'smart-session',
        'playlistId': 'playlist-1',
        'snapshotId': 'a1234567',
        'seed': 42,
        'kind': 'own',
        'occurrenceId': 'own:item-1',
        'cursor': 2,
        'enabled': true,
      };
      final entry = original.withSmartShuffle(
        SmartShuffleLineage.fromJson(lineage),
      );
      final owners = MemoryOwnerStore(fenceA);
      await QueueSnapshotStore(owners).save(
        QueueSnapshot(
          entries: [entry],
          effectiveOrder: [entry.entryId],
          currentEntryId: entry.entryId,
          fence: fenceA,
        ),
        fenceA,
      );
      final restored = (await QueueSnapshotStore(owners).load(fenceA))!
          .entries
          .single;
      expect(restored.smartShuffle!.toJson(), lineage);
      expect(MusicCodec.encodeQueueEntry(restored).keys.toSet(), {
        'entryId',
        'track',
        'context',
      });
      expect(restored.track.ref, const LibraryTrackRef('same-recording'));
      expect(restored.context.surface, PlaySurface.playlist);
    },
  );
  test('three own then one discovery preserves duplicate occurrence order', () {
    final result = build();
    expect(result.map((entry) => entry.smartShuffle!.injected), [
      false,
      false,
      false,
      true,
      false,
      false,
      false,
      true,
      false,
    ]);
    expect(
      result
          .where((entry) => !entry.smartShuffle!.injected)
          .map((entry) => entry.entryId),
      List.generate(7, (i) => 'own-$i'),
    );
    expect(
      result
          .where((entry) => !entry.smartShuffle!.injected)
          .map((entry) => entry.track.ref)
          .toSet(),
      {const LibraryTrackRef('same')},
    );
    expect(result.map((entry) => entry.entryId).toSet().length, result.length);
    expect(result.every((entry) => entry.smartShuffle!.cursor == 2), true);
    expect(
      build().map((entry) => entry.entryId),
      result.map((entry) => entry.entryId),
    );
  });
  test(
    'one and two own receive exactly one at end; empty pool is honest own only',
    () {
      for (final count in [1, 2]) {
        final result = build(count: count);
        expect(result.length, count + 1);
        expect(result.last.smartShuffle!.injected, true);
      }
      expect(
        build(pool: []).every((entry) => !entry.smartShuffle!.enabled),
        true,
      );
    },
  );
  test(
    'finite pool deduplicates exact recordings and never cycles after50',
    () {
      final ownDuplicate = ownEntry(99, recording: 'same');
      final result = build(
        count: 500,
        pool: [ownDuplicate, ...List.generate(49, injectedEntry)],
      );
      expect(
        result.where((entry) => entry.smartShuffle!.injected),
        hasLength(49),
      );
      final duplicate = build(
        pool: [injectedEntry(1), injectedEntry(1), ownDuplicate],
      );
      expect(
        duplicate.where((entry) => entry.smartShuffle!.injected),
        hasLength(1),
      );
    },
  );
  test('durable capacity never truncates own1999; rejects2000 and5000', () {
    final result = build(count: 1999);
    expect(result.length, QueueSnapshotStore.maxEntries);
    expect(
      result.where((entry) => !entry.smartShuffle!.injected),
      hasLength(1999),
    );
    for (final count in [2000, 5000]) {
      expect(() => build(count: count), throwsFormatException);
    }
  });
  test(
    'actual owner checkpoint cold roundtrip retains all lineage and duplicates',
    () async {
      final entries = build();
      final owners = MemoryOwnerStore(fenceA);
      await QueueSnapshotStore(owners).save(
        QueueSnapshot(
          entries: entries,
          effectiveOrder: entries.map((e) => e.entryId),
          currentEntryId: entries[3].entryId,
          fence: fenceA,
          position: const Duration(seconds: 12),
        ),
        fenceA,
      );
      final cold = (await QueueSnapshotStore(owners).load(fenceA))!;
      expect(
        cold.entries.map((entry) => entry.smartShuffle!.toJson()),
        entries.map((entry) => entry.smartShuffle!.toJson()),
      );
      expect(cold.effectiveOrder, entries.map((entry) => entry.entryId));
      expect(cold.position, const Duration(seconds: 12));
    },
  );
  test('disable uses effective order: current and past injected stay', () {
    final entries = build(count: 12),
        order = build(count: 12)
            .map((entry) => entry.entryId)
            .toList()
            .reversed
            .toList();
    final current = order[7];
    final snapshot = QueueSnapshot(
      entries: entries,
      effectiveOrder: order,
      currentEntryId: current,
    );
    final retained = disableFiniteSmartShuffle(snapshot, 'session');
    expect(retained.map((entry) => entry.entryId), containsAll(order.take(8)));
    final future = order.skip(8).toSet();
    expect(
      retained.any(
        (entry) =>
            future.contains(entry.entryId) && entry.smartShuffle!.injected,
      ),
      false,
    );
    expect(retained.every((entry) => !entry.smartShuffle!.enabled), true);
  });
  test('unknown/malformed metadata cannot enable mode and old entries still decode', () {
    final entry = build().first;
    final row = MusicCodec.encodeQueueEntry(entry);
    for (final patch in [
      {'v': 2},
      {'v': 1.0},
      {'cursor': 51},
      {'enabled': 'true'},
      {'url': 'https://invalid'},
    ]) {
      expect(
        () => SmartShuffleLineage.fromJson({
          ...entry.smartShuffle!.toJson(),
          ...patch,
        }),
        throwsFormatException,
      );
    }
    final old = Map<String, Object?>.of(row)..remove('smartShuffle');
    expect(MusicCodec.decodeQueueEntry(old).smartShuffle, isNull);
  });
  test(
    'stale or unknown optional metadata preserves the complete legacy queue',
    () async {
      for (final kind in ['version', 'identity', 'order', 'lineage']) {
        final owners = MemoryOwnerStore(fenceA), entries = build();
        final store = QueueSnapshotStore(owners);
        await store.save(
          QueueSnapshot(
            entries: entries,
            effectiveOrder: entries.map((entry) => entry.entryId),
            currentEntryId: entries.first.entryId,
            fence: fenceA,
          ),
          fenceA,
        );
        final raw = Map<String, Object?>.of(owners.smart[fenceA.owner]!);
        if (kind == 'version') {
          raw['v'] = 2;
        }
        if (kind == 'order') {
          raw['order'] = ['foreign'];
        }
        if (kind == 'identity' || kind == 'lineage') {
          final rows = (raw['entries'] as List)
              .map((row) => Map<String, Object?>.from(row as Map))
              .toList();
          if (kind == 'identity') {
            rows[0]['entryId'] = 'foreign';
          } else {
            rows[0]['lineage'] = {'v': 99};
          }
          raw['entries'] = rows;
        }
        owners.smart[fenceA.owner] = raw;
        final restored = (await store.load(fenceA))!;
        expect(
          restored.entries.map((entry) => entry.entryId),
          entries.map((entry) => entry.entryId),
        );
        expect(
          restored.entries.every((entry) => entry.smartShuffle == null),
          true,
        );
      }
    },
  );
}
