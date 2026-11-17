import 'dart:convert';

import 'package:crypto/crypto.dart';

import '../core/model/app_failure.dart';
import '../core/model/track.dart';
import '../core/storage/music_codec.dart';
import '../core/storage/owner_store.dart';
import '../features/home/home_models.dart';
import 'download_checkpoint.dart';
import 'download_models.dart';
import 'download_repository.dart';

/// One ordered occurrence; repeated recordings share a download, not a row.
final class OfflineMixItem {
  const OfflineMixItem({
    required this.track,
    required this.downloadId,
    required this.occurrenceId,
    this.downloadGeneration,
    this.downloadEpoch,
    this.verified,
  });
  final Track track;
  final String downloadId, occurrenceId;
  final int? downloadGeneration;
  final int? downloadEpoch;
  final DownloadCheckpoint? verified;
}

/// Frozen source metadata and ordered file bindings for a single generation.
final class OfflineMixSnapshot {
  const OfflineMixSnapshot({
    required this.generation,
    required this.title,
    required this.sourceIdentity,
    required this.revision,
    required this.items,
    this.quality = 'original',
    this.ownerEpoch = 0,
    this.createdAt = 0,
  });
  final int generation;
  final String title, sourceIdentity, revision;
  final String quality;
  final int ownerEpoch, createdAt;
  final List<OfflineMixItem> items;
  List<Track> get tracks => List.unmodifiable(items.map((item) => item.track));
}

final class OfflineMixState {
  const OfflineMixState({this.active, this.previous, this.pending});
  final OfflineMixSnapshot? active, previous, pending;
}

/// Owner-scoped manifest switching; byte transfers stay in the existing worker.
final class OfflineMixRepository {
  OfflineMixRepository({required this.downloads, required this.fence});
  final DownloadRepository downloads;
  final SessionFence fence;
  static const namespace = 'offlineMix.v1';
  static const key = 'current';
  static const _qualities = {
    'original',
    'high',
    'medium',
    'low',
    'lossless',
    'HIGH',
    'MEDIUM',
    'LOW',
    'LOSSLESS',
  };

  Future<OfflineMixState> read() =>
      downloads.store.transaction(fence, (tx) async {
        final record = await _read(tx);
        return record.state;
      });

  /// Persist the exact intent before any file admission or scheduling. Replacing
  /// pending work never clears the last fully verified active generation.
  Future<OfflineMixSnapshot> stage(
    MusicMix source, {
    String quality = 'original',
  }) async {
    if (!source.loaded ||
        source.tracks.isEmpty ||
        source.tracks.length != source.trackCount ||
        source.tracks.length > 1000 ||
        source.tracks.any((t) => !t.playable) ||
        source.title.isEmpty ||
        source.title.length > 200 ||
        source.identity.length > 512 ||
        !_qualities.contains(quality)) {
      throw const AppFailure(
        code: 'offline_mix_source_incomplete',
        message: 'Для сохранения нужен полный доступный состав подборки.',
      );
    }
    final revision = sha256
        .convert(
          utf8.encode(
            jsonEncode([
              source.identity,
              source.generationId,
              source.tracks.map((track) => track.ref.identityKey).toList(),
            ]),
          ),
        )
        .toString();
    return downloads.store.transaction(fence, (tx) async {
      final record = await _read(tx);
      final generation = record.generation + 1;
      if (generation > 9007199254740991) {
        throw const FormatException('Mix generation');
      }
      final snapshot = OfflineMixSnapshot(
        generation: generation,
        title: source.title,
        sourceIdentity: source.identity,
        revision: revision,
        quality: quality,
        ownerEpoch: fence.epoch,
        createdAt: DateTime.now().millisecondsSinceEpoch,
        items: List.unmodifiable([
          for (var i = 0; i < source.tracks.length; i++)
            OfflineMixItem(
              track: source.tracks[i],
              downloadId: downloads.key(
                source.tracks[i].ref,
                quality,
                fence.owner,
              ),
              occurrenceId: '$generation:$i',
            ),
        ]),
      );
      await _write(
        tx,
        generation,
        OfflineMixState(
          active: record.state.active,
          previous: record.state.previous,
          pending: snapshot,
        ),
      );
      return snapshot;
    });
  }

  /// Bind only journal generations actually admitted for this exact intent.
  /// A crash before binding is recoverable from the already persisted file IDs;
  /// an existing binding cannot silently follow a newer user retry generation.
  Future<bool> bind(int generation, Iterable<DeviceDownload> jobs) async =>
      downloads.store.transaction(fence, (tx) async {
        final record = await _read(tx);
        final pending = record.state.pending;
        if (pending == null ||
            pending.generation != generation ||
            pending.ownerEpoch != fence.epoch) {
          return false;
        }
        final byId = <String, DeviceDownload>{};
        for (final job in jobs) {
          if (byId.containsKey(job.id) ||
              !pending.items.any((item) => item.downloadId == job.id)) {
            return false;
          }
          byId[job.id] = job;
        }
        if (byId.isEmpty) return false;
        final items = <OfflineMixItem>[];
        for (final item in pending.items) {
          final job = byId[item.downloadId];
          if (job == null) {
            items.add(item);
            continue;
          }
          final current = await _job(tx, item, pending);
          if (current == null ||
              current.generation != job.generation ||
              current.originalFence != job.originalFence ||
              (current.state != DownloadState.ready &&
                  current.originalFence != fence) ||
              (item.downloadGeneration != null &&
                  (item.downloadGeneration != job.generation ||
                      item.downloadEpoch != job.originalFence.epoch))) {
            return false;
          }
          items.add(
            OfflineMixItem(
              track: item.track,
              downloadId: item.downloadId,
              occurrenceId: item.occurrenceId,
              downloadGeneration: job.generation,
              downloadEpoch: job.originalFence.epoch,
            ),
          );
        }
        await _write(
          tx,
          record.generation,
          OfflineMixState(
            active: record.state.active,
            previous: record.state.previous,
            pending: _withItems(pending, items),
          ),
        );
        return true;
      });

  /// Hash every ready file outside SQL, then atomically recheck the pending
  /// intent and every journal generation/claim before switching the manifest.
  /// No network requests, byte transfers or file deletion occur here.
  Future<bool> commit(int generation) async {
    final candidate = await downloads.store.transaction(fence, (tx) async {
      final record = await _read(tx);
      final pending = record.state.pending;
      if (pending == null ||
          pending.generation != generation ||
          pending.ownerEpoch != fence.epoch) {
        return null;
      }
      final jobs = <String, DeviceDownload>{};
      for (final item in pending.items) {
        final job = await _job(tx, item, pending);
        if (!_readyBound(job, item)) return null;
        jobs[item.downloadId] = job!;
      }
      return (snapshot: pending, jobs: jobs);
    });
    if (candidate == null) {
      return (await read()).active?.generation == generation;
    }
    for (final job in candidate.jobs.values) {
      if (await downloads.openReady(
            job.track.ref,
            candidate.snapshot.quality,
            fence,
          ) ==
          null) {
        return false;
      }
    }
    final verified = _withItems(candidate.snapshot, [
      for (final item in candidate.snapshot.items)
        OfflineMixItem(
          track: item.track,
          downloadId: item.downloadId,
          occurrenceId: item.occurrenceId,
          downloadGeneration: item.downloadGeneration,
          downloadEpoch: item.downloadEpoch,
          verified: candidate.jobs[item.downloadId]!.checkpoint,
        ),
    ]);
    return downloads.store.transaction(fence, (tx) async {
      final record = await _read(tx);
      final pending = record.state.pending;
      if (pending == null ||
          pending.generation != generation ||
          pending.ownerEpoch != fence.epoch ||
          pending.revision != verified.revision) {
        return false;
      }
      for (final item in verified.items) {
        final current = await _job(tx, item, verified);
        if (!_readyBound(current, item) ||
            !_sameFile(current!.checkpoint!, item.verified!)) {
          return false;
        }
      }
      await _write(
        tx,
        record.generation,
        OfflineMixState(active: verified, previous: record.state.active),
      );
      return true;
    });
  }

  Future<bool> cancel(int generation) =>
      downloads.store.transaction(fence, (tx) async {
        final record = await _read(tx);
        if (record.state.pending?.generation != generation) return false;
        await _write(
          tx,
          record.generation,
          OfflineMixState(
            active: record.state.active,
            previous: record.state.previous,
          ),
        );
        return true;
      });

  Future<DeviceDownload?> _job(
    OwnerTransaction tx,
    OfflineMixItem item,
    OfflineMixSnapshot snapshot,
  ) async {
    final row = await tx.read(DownloadRepository.namespace, item.downloadId);
    if (row == null) return null;
    final job = DeviceDownload.fromJson(row);
    if (job.id != item.downloadId ||
        job.originalFence.owner != fence.owner ||
        job.track.ref != item.track.ref ||
        job.quality != snapshot.quality ||
        downloads.key(job.track.ref, job.quality, fence.owner) != job.id) {
      throw const FormatException('Mix download identity');
    }
    return job;
  }

  bool _readyBound(DeviceDownload? job, OfflineMixItem item) =>
      job != null &&
      job.state == DownloadState.ready &&
      job.generation == item.downloadGeneration &&
      job.originalFence.epoch == item.downloadEpoch &&
      job.checkpoint?.sha256 != null &&
      job.checkpoint!.bytes > 0;

  bool _sameFile(DownloadCheckpoint a, DownloadCheckpoint b) =>
      a.generation == b.generation &&
      a.claim == b.claim &&
      a.bytes == b.bytes &&
      a.sha256 == b.sha256;

  OfflineMixSnapshot _withItems(
    OfflineMixSnapshot source,
    List<OfflineMixItem> items,
  ) => OfflineMixSnapshot(
    generation: source.generation,
    title: source.title,
    sourceIdentity: source.sourceIdentity,
    revision: source.revision,
    quality: source.quality,
    ownerEpoch: source.ownerEpoch,
    createdAt: source.createdAt,
    items: List.unmodifiable(items),
  );

  Future<({int generation, OfflineMixState state})> _read(
    OwnerTransaction tx,
  ) async {
    final row = await tx.read(namespace, key);
    if (row == null) return (generation: 0, state: const OfflineMixState());
    if (row['version'] != 1 ||
        row['version'] is! int ||
        row['origin'] != fence.owner.serverOrigin.toString() ||
        row['user'] != fence.owner.userId ||
        row['generation'] is! int ||
        (row['generation'] as int) < 0 ||
        (row['generation'] as int) > 9007199254740991) {
      throw const FormatException('Offline mix state');
    }
    final generation = row['generation'] as int;
    final active = _decode(row['active'], complete: true);
    final previous = _decode(row['previous'], complete: true);
    final pending = _decode(row['pending'], complete: false);
    if ([
          active,
          previous,
          pending,
        ].nonNulls.any((s) => s.generation > generation) ||
        (previous != null &&
            (active == null || previous.generation >= active.generation)) ||
        (pending != null &&
            active != null &&
            pending.generation <= active.generation)) {
      throw const FormatException('Offline mix generation order');
    }
    return (
      generation: generation,
      state: OfflineMixState(
        active: active,
        previous: previous,
        pending: pending,
      ),
    );
  }

  Future<void> _write(
    OwnerTransaction tx,
    int generation,
    OfflineMixState state,
  ) => tx.write(namespace, key, {
    'version': 1,
    'origin': fence.owner.serverOrigin.toString(),
    'user': fence.owner.userId,
    'generation': generation,
    'state': state.pending != null
        ? 'pending'
        : state.active != null
        ? 'active'
        : 'idle',
    'active': _encode(state.active),
    'previous': _encode(state.previous),
    'pending': _encode(state.pending),
  });

  Map<String, Object?>? _encode(OfflineMixSnapshot? snapshot) =>
      snapshot == null
      ? null
      : {
          'generation': snapshot.generation,
          'title': snapshot.title,
          'sourceIdentity': snapshot.sourceIdentity,
          'revision': snapshot.revision,
          'quality': snapshot.quality,
          'epoch': snapshot.ownerEpoch,
          'createdAt': snapshot.createdAt,
          'items': [
            for (final item in snapshot.items)
              {
                'track': MusicCodec.encodeTrack(item.track),
                'downloadId': item.downloadId,
                'occurrenceId': item.occurrenceId,
                'downloadGeneration': item.downloadGeneration,
                'downloadEpoch': item.downloadEpoch,
                'verified': item.verified?.toJson(),
              },
          ],
        };

  OfflineMixSnapshot? _decode(Object? value, {required bool complete}) {
    if (value == null) return null;
    if (value is! Map) throw const FormatException('Offline mix snapshot');
    final raw = Map<String, Object?>.from(value);
    final generation = raw['generation'],
        epoch = raw['epoch'],
        items = raw['items'];
    if (generation is! int ||
        generation < 1 ||
        epoch is! int ||
        epoch < 1 ||
        raw['createdAt'] is! int ||
        (raw['createdAt'] as int) < 1 ||
        raw['title'] is! String ||
        (raw['title'] as String).isEmpty ||
        (raw['title'] as String).length > 200 ||
        raw['sourceIdentity'] is! String ||
        (raw['sourceIdentity'] as String).isEmpty ||
        (raw['sourceIdentity'] as String).length > 512 ||
        raw['revision'] is! String ||
        !RegExp(r'^[a-f0-9]{64}$').hasMatch(raw['revision'] as String) ||
        !_qualities.contains(raw['quality']) ||
        items is! List ||
        items.isEmpty ||
        items.length > 1000) {
      throw const FormatException('Offline mix snapshot fields');
    }
    final decoded = <OfflineMixItem>[];
    for (var i = 0; i < items.length; i++) {
      final item = Map<String, Object?>.from(items[i] as Map);
      final track = MusicCodec.decodeTrack(item['track']);
      final dg = item['downloadGeneration'], de = item['downloadEpoch'];
      if (!track.playable ||
          item['downloadId'] !=
              downloads.key(track.ref, raw['quality'] as String, fence.owner) ||
          item['occurrenceId'] != '$generation:$i' ||
          (dg != null && (dg is! int || dg < 1)) ||
          (de != null && (de is! int || de < 1)) ||
          (dg == null) != (de == null)) {
        throw const FormatException('Offline mix occurrence');
      }
      final verified = item['verified'] == null
          ? null
          : DownloadCheckpoint.fromJson(
              Map<String, Object?>.from(item['verified'] as Map),
            );
      if (complete &&
              (dg == null || verified?.sha256 == null || verified!.bytes < 1) ||
          verified != null &&
              (dg == null || verified.generation > (dg as int))) {
        throw const FormatException('Offline mix verified file');
      }
      decoded.add(
        OfflineMixItem(
          track: track,
          downloadId: item['downloadId'] as String,
          occurrenceId: item['occurrenceId'] as String,
          downloadGeneration: dg as int?,
          downloadEpoch: de as int?,
          verified: verified,
        ),
      );
    }
    return OfflineMixSnapshot(
      generation: generation,
      title: raw['title'] as String,
      sourceIdentity: raw['sourceIdentity'] as String,
      revision: raw['revision'] as String,
      quality: raw['quality'] as String,
      ownerEpoch: epoch,
      createdAt: raw['createdAt'] as int,
      items: List.unmodifiable(decoded),
    );
  }
}
