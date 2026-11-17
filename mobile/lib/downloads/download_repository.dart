import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:crypto/crypto.dart';

import '../core/model/owner_key.dart';
import '../core/model/app_failure.dart';
import '../core/model/track.dart';
import '../core/model/track_ref.dart';
import '../core/session/session_authority.dart';
import '../core/storage/owner_store.dart';
import '../playback/resolved_media.dart';
import 'download_checkpoint.dart';
import 'automatic_download_control.dart';
import 'download_models.dart';
import 'download_verifier.dart';
import 'private_media_paths.dart';

final class DownloadRepository {
  DownloadRepository({
    required this.store,
    required this.authority,
    required this.paths,
    required this.verifier,
    required this.beforeRemove,
    this.writerLease = const Duration(seconds: 30),
    DateTime Function()? clock,
  }) : clock = clock ?? DateTime.now;
  final OwnerStore store;
  final SessionAuthority authority;
  final PrivateMediaPaths paths;
  final DownloadVerifier verifier;
  final Future<void> Function(DeviceDownload) beforeRemove;
  final Duration writerLease;
  final DateTime Function() clock;
  static const namespace = 'deviceDownloads.v1';
  final _changes = StreamController<String>.broadcast(sync: true);
  Stream<String> get changes => _changes.stream;
  int get now => clock().millisecondsSinceEpoch;

  String key(TrackRef ref, String quality, OwnerKey owner) => sha256
      .convert(
        utf8.encode(
          jsonEncode([
            owner.serverOrigin.toString(),
            owner.userId,
            ref.identityKey,
            quality,
          ]),
        ),
      )
      .toString();
  Future<DeviceDownload?> _read(
    OwnerTransaction tx,
    String id,
    SessionFence fence,
  ) async {
    final row = await tx.read(namespace, id);
    if (row == null) return null;
    return _decode(row, id, fence);
  }

  DeviceDownload _decode(
    Map<String, Object?> row,
    String id,
    SessionFence fence,
  ) {
    final job = DeviceDownload.fromJson(row);
    if (job.id != id ||
        job.originalFence.owner != fence.owner ||
        key(job.track.ref, job.quality, fence.owner) != id) {
      throw const FormatException('Download owner/key mismatch');
    }
    return job;
  }

  Future<DeviceDownload> _write(OwnerTransaction tx, DeviceDownload job) async {
    await tx.write(namespace, job.id, job.toJson());
    return job;
  }

  Future<T> _mutate<T>(
    String id,
    SessionFence fence,
    Future<T> Function(OwnerTransaction) body,
  ) async {
    final result = await store.transaction(fence, body);
    _changes.add(id);
    return result;
  }

  Future<DeviceDownload> enqueue(
    Track track,
    String quality,
    SessionFence fence, {
    bool manual = true,
    DownloadOrigin? origin,
  }) async {
    if (!track.playable ||
        !const {
          'original',
          'high',
          'medium',
          'low',
          'lossless',
          'HIGH',
          'MEDIUM',
          'LOW',
          'LOSSLESS',
        }.contains(quality)) {
      throw ArgumentError('Unsupported download');
    }
    final id = key(track.ref, quality, fence.owner);
    final fileOrigin =
        origin ?? (manual ? DownloadOrigin.manual : DownloadOrigin.liked);
    return _mutate(id, fence, (tx) async {
      final old = await _read(tx, id, fence);
      if (old != null &&
          old.state != DownloadState.removing &&
          (old.state == DownloadState.ready || old.originalFence == fence)) {
        return _write(
          tx,
          old.patch({
            'manual': old.manual || manual,
            'origins': {...old.origins, fileOrigin.name}.toList()..sort(),
          }),
        );
      }
      return _write(
        tx,
        DeviceDownload(
          id: id,
          track: track,
          quality: quality,
          originalFence: fence,
          generation: (old?.generation ?? 0) + 1,
          state: DownloadState.queued,
          manual: manual,
          origins: Set.unmodifiable({...?old?.origins, fileOrigin.name}),
          files: old?.files ?? const [],
          retryNotBefore: old?.retryNotBefore ?? 0,
        ),
      );
    });
  }

  Future<DeviceDownload?> status(String id, SessionFence fence) =>
      store.transaction(fence, (tx) => _read(tx, id, fence));

  /// Protect only the captured ready generation as an individual saved file.
  /// This local action never enqueues, transfers or resurrects a replacement.
  Future<bool> pinReadyIfCurrent(
    String id,
    SessionFence fence, {
    required int expectedGeneration,
  }) => _mutate(id, fence, (tx) async {
    final current = await _read(tx, id, fence);
    if (current == null ||
        current.state != DownloadState.ready ||
        current.generation != expectedGeneration) {
      return false;
    }
    await _write(
      tx,
      current.patch({
        'manual': true,
        'origins': {...current.origins, DownloadOrigin.manual.name}.toList()
          ..sort(),
      }),
    );
    return true;
  });

  Future<List<DeviceDownload>> list(SessionFence fence) =>
      store.transaction(fence, (tx) async {
        final jobs = <DeviceDownload>[];
        String? after;
        while (true) {
          final page = await tx.list(namespace, afterKey: after);
          if (page.isEmpty) break;
          for (final row in page) {
            final job = _decode(row.value, row.key, fence);
            if (job.state != DownloadState.removing) jobs.add(job);
          }
          after = page.last.key;
        }
        return List.unmodifiable(jobs);
      });

  /// Polling observes commits made by other Flutter engines as well as this one.
  Stream<List<DeviceDownload>> watch(SessionFence fence) async* {
    while (authority.isCurrent(fence)) {
      yield await list(fence);
      await Future<void>.delayed(const Duration(milliseconds: 500));
    }
  }

  Future<({DeviceDownload job, bool applied})> _command(
    String id,
    SessionFence fence,
    DownloadState state, {
    String? error,
    bool forceNewGeneration = false,
    int? expectedGeneration,
    bool automaticOnly = false,
    bool manual = false,
  }) => _mutate(id, fence, (tx) async {
    final old = await _read(tx, id, fence);
    if (old == null) throw StateError('Download not found');
    // Compare inside the same owner transaction as the write. A status read in
    // a sheet/automation is only a captured intent, never mutation authority.
    if ((expectedGeneration != null && old.generation != expectedGeneration) ||
        (automaticOnly && old.manual) ||
        old.state == DownloadState.ready ||
        old.state == DownloadState.removing) {
      return (job: old, applied: false);
    }
    if (!forceNewGeneration &&
        old.state == state &&
        old.writer == null &&
        old.originalFence == fence &&
        old.errorCode == error &&
        (!manual || old.manual)) {
      return (job: old, applied: false);
    }
    final updated = await _write(
      tx,
      old.patch({
        'state': state.name,
        'generation': old.generation + 1,
        'epoch': fence.epoch,
        'writer': null,
        'leaseUntil': 0,
        'errorCode': error,
        'manual': old.manual || manual,
      }),
    );
    return (job: updated, applied: true);
  });
  Future<DeviceDownload> pause(
    String id,
    SessionFence fence, {
    int? expectedGeneration,
  }) async => (await _command(
    id,
    fence,
    DownloadState.paused,
    expectedGeneration: expectedGeneration,
  )).job;
  Future<DeviceDownload> resume(
    String id,
    SessionFence fence, {
    int? expectedGeneration,
  }) async => (await _command(
    id,
    fence,
    DownloadState.queued,
    expectedGeneration: expectedGeneration,
  )).job;

  /// A rescheduler may resume only a pause that it actually applied. A rejected
  /// CAS can return another command's paused generation and grants no ownership.
  Future<DeviceDownload?> pauseIfCurrent(
    String id,
    SessionFence fence, {
    required int expectedGeneration,
  }) async {
    final result = await _command(
      id,
      fence,
      DownloadState.paused,
      expectedGeneration: expectedGeneration,
    );
    return result.applied ? result.job : null;
  }

  Future<DeviceDownload> retry(
    String id,
    SessionFence fence, {
    int? expectedGeneration,
  }) async => (await _command(
    id,
    fence,
    DownloadState.queued,
    forceNewGeneration: true,
    expectedGeneration: expectedGeneration,
  )).job;

  /// An explicit row action promotes manual intent in the same transaction as
  /// its generation check. Null means no command was applied; callers must not
  /// schedule a replacement returned by a rejected stale action.
  Future<DeviceDownload?> restartManually(
    String id,
    SessionFence fence, {
    required int expectedGeneration,
    bool retry = false,
  }) async {
    final result = await _command(
      id,
      fence,
      DownloadState.queued,
      forceNewGeneration: retry,
      expectedGeneration: expectedGeneration,
      manual: true,
    );
    return result.applied ? result.job : null;
  }

  /// Returns whether this captured cancellation was admitted. A manual
  /// promotion can retain its generation and still reject automatic cleanup.
  Future<bool> cancel(
    String id,
    SessionFence fence, {
    int? expectedGeneration,
    bool automaticOnly = false,
  }) async {
    return (await _command(
      id,
      fence,
      DownloadState.paused,
      error: 'download_cancelled',
      expectedGeneration: expectedGeneration,
      automaticOnly: automaticOnly,
    )).applied;
  }

  /// Atomically admits one engine. Expired claims are reclaimable; the new
  /// writer copies a bounded checkpoint to its own path, never appends to the
  /// abandoned writer's file. Late old writes are consequently inaccessible.
  Future<DeviceDownload?> claim(
    String id,
    SessionFence fence,
    int generation,
  ) => _mutate(id, fence, (tx) async {
    final old = await _read(tx, id, fence);
    if (old == null ||
        old.originalFence != fence ||
        old.generation != generation ||
        old.retryNotBefore > now ||
        !const {
          DownloadState.queued,
          DownloadState.downloading,
          DownloadState.verifying,
          DownloadState.failed,
        }.contains(old.state) ||
        (old.writer != null && old.leaseUntil > now)) {
      return null;
    }
    if (!old.manual &&
        AutomaticDownloadControl.paused(
          await tx.read(
            AutomaticDownloadControl.namespace,
            AutomaticDownloadControl.key,
          ),
        )) {
      return null;
    }
    final random = Random.secure();
    final token = List.generate(
      24,
      (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'),
    ).join();
    return _write(
      tx,
      old.patch({
        'state': 'downloading',
        'writer': token,
        'leaseUntil': now + writerLease.inMilliseconds,
        'errorCode': null,
        'files': [
          ...old.files.map((f) => f.toJson()),
          DownloadCheckpoint(
            generation: old.generation,
            claim: token,
            bytes: 0,
          ).toJson(),
        ],
      }),
    );
  });
  bool owns(DeviceDownload? current, DeviceDownload claim) =>
      current != null &&
      current.originalFence == claim.originalFence &&
      current.generation == claim.generation &&
      current.writer == claim.writer &&
      current.leaseUntil > now &&
      const {
        DownloadState.downloading,
        DownloadState.verifying,
      }.contains(current.state);
  Future<void> assertClaim(DeviceDownload claim) async {
    await store.transaction(claim.originalFence, (tx) async {
      final current = await _read(tx, claim.id, claim.originalFence);
      if (!owns(current, claim)) throw mediaCancelled;
      if (!current!.manual &&
          AutomaticDownloadControl.paused(
            await tx.read(
              AutomaticDownloadControl.namespace,
              AutomaticDownloadControl.key,
            ),
          )) {
        throw mediaCancelled;
      }
    });
  }

  Future<DeviceDownload> updateClaim(
    DeviceDownload claim, {
    DownloadCheckpoint? checkpoint,
    DownloadState? state,
    String? errorCode,
    bool release = false,
    int? retryNotBefore,
    bool pauseAutomaticDownloads = false,
  }) => _mutate(claim.id, claim.originalFence, (tx) async {
    final old = await _read(tx, claim.id, claim.originalFence);
    if (!owns(old, claim)) throw mediaCancelled;
    // Commit the failed job and global auto pause together. A headless worker
    // must not depend on a visible Downloads screen observing its error.
    if (pauseAutomaticDownloads) {
      await tx.write(
        AutomaticDownloadControl.namespace,
        AutomaticDownloadControl.key,
        AutomaticDownloadControl.encode(true),
      );
    }
    return _write(
      tx,
      old!.patch({
        'state': (state ?? old.state).name,
        if (checkpoint != null) 'checkpoint': checkpoint.toJson(),
        'leaseUntil': release ? 0 : now + writerLease.inMilliseconds,
        'writer': release ? null : claim.writer,
        'errorCode': errorCode,
        if (retryNotBefore != null)
          'retryNotBefore': max(old.retryNotBefore, retryNotBefore),
      }),
    );
  });
  Future<void> heartbeat(DeviceDownload claim) async {
    await assertClaim(claim);
    await updateClaim(claim);
  }

  Future<File?> openReady(
    TrackRef ref,
    String quality,
    SessionFence fence,
  ) async {
    final job = await status(key(ref, quality, fence.owner), fence);
    if (job == null ||
        job.state != DownloadState.ready ||
        job.checkpoint?.sha256 == null) {
      return null;
    }
    final cp = job.checkpoint!;
    final file = await paths.file(
      fence.owner,
      job.id,
      cp.generation,
      cp.claim,
      ready: true,
    );
    if (!await verifier.matches(file, bytes: cp.bytes, digest: cp.sha256!)) {
      await _mutate(job.id, fence, (tx) async {
        final current = await _read(tx, job.id, fence);
        if (current?.state == DownloadState.ready &&
            current?.generation == job.generation &&
            current?.checkpoint?.claim == cp.claim) {
          await _write(
            tx,
            current!.patch({
              'state': 'failed',
              'errorCode': 'download_corrupt',
              'generation': current.generation + 1,
              'epoch': fence.epoch,
              'checkpoint': null,
              'writer': null,
              'leaseUntil': 0,
            }),
          );
        }
      });
      return null;
    }
    final current = await status(job.id, fence);
    if (current?.state != DownloadState.ready ||
        current?.generation != job.generation ||
        current?.checkpoint?.claim != cp.claim) {
      return null;
    }
    await authority.assertCurrent(fence);
    return file;
  }

  Future<void> remove(
    String id,
    SessionFence fence, {
    int? expectedGeneration,
  }) async {
    final old = await status(id, fence);
    if (old == null ||
        (expectedGeneration != null && old.generation != expectedGeneration)) {
      return;
    }
    await beforeRemove(old);
    final releasedPaths = {
      for (final cp in [
        ...old.files,
        if (old.checkpoint != null) old.checkpoint!,
      ])
        '${cp.generation}:${cp.claim}',
    };
    final removed = await _mutate<DeviceDownload?>(id, fence, (tx) async {
      final current = await _read(tx, id, fence);
      // Completion or lease reclaim can change the writer without replacing
      // this job. Only a new generation supersedes the user's deletion intent.
      if (current == null || current.generation != old.generation) {
        return null;
      }
      if ([
        ...current.files,
        if (current.checkpoint != null) current.checkpoint!,
      ].any((cp) => !releasedPaths.contains('${cp.generation}:${cp.claim}'))) {
        throw const AppFailure(
          code: 'download_in_use',
          message: 'Запись изменилась во время удаления. Повторите удаление.',
          retryable: true,
        );
      }
      return _write(
        tx,
        current.patch({
          'state': 'removing',
          'generation': current.generation + 1,
          'writer': null,
          'leaseUntil': 0,
        }),
      );
    });
    if (removed == null) return;
    final claims = {
      for (final cp in [
        ...removed.files,
        if (removed.checkpoint != null) removed.checkpoint!,
      ])
        '${cp.generation}:${cp.claim}': cp,
    };
    for (final cp in claims.values) {
      for (final ready in [false, true]) {
        final file = await paths.file(
          fence.owner,
          id,
          cp.generation,
          cp.claim,
          ready: ready,
        );
        if (await file.exists()) await file.delete();
      }
    }
  }
}
