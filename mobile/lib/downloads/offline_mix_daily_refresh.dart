import '../core/model/app_failure.dart';
import '../features/home/home_models.dart';
import 'download_models.dart';
import 'download_repository.dart';
import 'offline_mix_refresh_policy.dart';
import 'offline_mix_refresh_admission.dart';
import 'offline_mix_repository.dart';

final class OfflineMixRefreshConditions {
  const OfflineMixRefreshConditions({
    required this.charging,
    required this.unmetered,
  });
  final bool charging, unmetered;
}

/// Orchestrates existing manifests and T07 jobs, without transferring media.
final class OfflineMixDailyRefresh {
  OfflineMixDailyRefresh({
    required this.mixes,
    required this.policy,
    required this.conditions,
    required this.requireNetwork,
    required this.loadSource,
    required this.scheduleFile,
    required this.schedulePeriodic,
    required this.retryPeriodic,
    required this.cancelPeriodic,
    required this.cancelFile,
  });
  final OfflineMixRepository mixes;
  final OfflineMixRefreshPolicy policy;
  final Future<OfflineMixRefreshConditions> Function() conditions;
  final Future<void> Function() requireNetwork;
  final Future<MusicMix?> Function(
    String identity,
    Future<void> Function() admit,
  )
  loadSource;
  final Future<void> Function(DeviceDownload job, int? revision) scheduleFile;
  final Future<void> Function(int revision) schedulePeriodic,
      retryPeriodic,
      cancelPeriodic;
  final Future<void> Function(DeviceDownload job) cancelFile;
  DownloadRepository get downloads => mixes.downloads;
  static const statusNamespace = OfflineMixRefreshAdmission.statusNamespace;
  static const restricted = AppFailure(
    code: 'offline_mix_refresh_waiting',
    message: 'Обновление ждёт зарядку и сеть без тарификации.',
    retryable: true,
  );

  Future<void> requireTicket(OfflineMixRefreshTicket ticket) async {
    await requireNetwork();
    final actual = await conditions();
    if (!actual.charging || !actual.unmetered) throw restricted;
    if (!await policy.isCurrent(ticket)) {
      throw const AppFailure(
        code: 'offline_mix_refresh_stale',
        message: 'Обновление выключено или изменилось.',
      );
    }
  }

  /// Manual promotion uses ordinary admission; it never inherits auto consent.
  Future<void> requireFile(DeviceDownload captured) async {
    final current = await downloads.status(captured.id, policy.fence);
    if (current == null || current.generation != captured.generation) {
      throw restricted;
    }
    if (current.manual) return;
    final ticket = await downloads.store.transaction(
      policy.fence,
      (tx) => OfflineMixRefreshAdmission.jobTicketIn(tx, current),
    );
    if (ticket != null && await policy.isCurrent(ticket)) {
      await requireTicket(ticket);
    } else if (OfflineMixRefreshAdmission.onlyDaily(current)) {
      throw restricted;
    }
  }

  Future<void> configure(bool enabled) async {
    final old = await policy.read();
    final active = (await mixes.read()).active;
    if (enabled && active == null) {
      throw const AppFailure(
        code: 'offline_mix_not_saved',
        message: 'Сначала сохраните подборку для офлайна.',
      );
    }
    final next = await policy.configure(
      enabled: enabled,
      sourceIdentity: enabled ? active!.sourceIdentity : null,
      quality: enabled ? active!.quality : null,
    );
    Object? cancellationError;
    if (old.enabled && (old.revision != next.revision || !next.enabled)) {
      try {
        await cancelPeriodic(old.revision);
      } catch (error) {
        cancellationError = error;
      }
      for (final job in await downloads.list(policy.fence)) {
        if (!OfflineMixRefreshAdmission.onlyDaily(job) ||
            job.state == DownloadState.ready) {
          continue;
        }
        final bound = await downloads.store.transaction(
          policy.fence,
          (tx) => OfflineMixRefreshAdmission.jobTicketIn(tx, job),
        );
        if (bound?.revision == old.revision &&
            await downloads.stopDailyIfCurrent(
              job,
              expectedRevision: old.revision,
            )) {
          try {
            await cancelFile(job);
          } catch (error) {
            cancellationError ??= error;
          }
        }
      }
    }
    if (next.enabled && (await policy.read()).revision == next.revision) {
      await schedulePeriodic(next.revision);
    }
    if (cancellationError != null) throw cancellationError;
  }

  /// Recover scheduling after a crash between durable opt-in and native enqueue.
  Future<void> ensureScheduled() async {
    final state = await policy.read();
    if (state.enabled) await schedulePeriodic(state.revision);
  }

  Future<void> retry() async {
    final state = await policy.read();
    if (state.enabled) await retryPeriodic(state.revision);
  }

  Future<void> run(int expectedRevision) async {
    final actual = await conditions();
    if (!actual.charging || !actual.unmetered) return;
    final configured = await policy.read();
    if (!configured.enabled || configured.revision != expectedRevision) return;
    final holdoff = await downloads.store.transaction(
      policy.fence,
      (tx) => tx.read(statusNamespace, 'current'),
    );
    if (holdoff != null && holdoff.containsKey('retryNotBefore')) {
      final until = holdoff['retryNotBefore'];
      if (holdoff['version'] is! int ||
          holdoff['version'] != 1 ||
          until is! int ||
          until < 0) {
        throw const FormatException('Refresh holdoff');
      }
      final remaining = until - policy.clock().millisecondsSinceEpoch;
      if (remaining > 0) {
        throw AppFailure(
          code: 'offline_mix_refresh_holdoff',
          message: 'Сервер попросил подождать. Готовый микс сохранён.',
          retryable: true,
          retryAfter: Duration(milliseconds: remaining),
        );
      }
    }
    final retained = (await mixes.read()).pending;
    if (retained != null) {
      final existing = await downloads.store.transaction(
        policy.fence,
        (tx) => OfflineMixRefreshAdmission.bindingIn(
          tx,
          retained.generation,
          policy.fence,
        ),
      );
      if (existing != null && await policy.isCurrent(existing)) {
        if (await commitIfReady()) return;
        var retryableComposition = false;
        final retainedJobs = <String, DeviceDownload>{};
        for (final item in retained.items) {
          final job = await downloads.status(item.downloadId, policy.fence);
          if (job == null || job.generation != item.downloadGeneration) {
            retryableComposition = true;
            continue;
          }
          retainedJobs[job.id] = job;
          if (!job.manual &&
              (job.state == DownloadState.failed ||
                  (job.state == DownloadState.paused &&
                      job.errorCode != null &&
                      job.errorCode != 'download_cancelled'))) {
            retryableComposition = true;
          }
        }
        if (!retryableComposition) {
          for (final job in retainedJobs.values) {
            if (job.state == DownloadState.ready ||
                job.state == DownloadState.paused) {
              continue;
            }
            await requireTicket(existing);
            await scheduleFile(job, job.manual ? null : existing.revision);
          }
          if (!await commitIfReady()) await _status(existing, 'waiting');
          return;
        }
        await policy.finish(existing, success: false);
      }
    }
    final ticket = await policy.claim(
      charging: actual.charging,
      unmetered: actual.unmetered,
      expectedRevision: expectedRevision,
    );
    if (ticket == null) return;
    try {
      await requireTicket(ticket);
      final before = await mixes.read();
      final anchor = before.active;
      if (anchor == null ||
          anchor.sourceIdentity != ticket.sourceIdentity ||
          anchor.quality != ticket.quality) {
        throw _sourceMissing;
      }
      if (before.pending != null) {
        final bound = await downloads.store.transaction(
          policy.fence,
          (tx) => OfflineMixRefreshAdmission.bindingIn(
            tx,
            before.pending!.generation,
            policy.fence,
          ),
        );
        if (bound == null) {
          throw const AppFailure(
            code: 'offline_mix_manual_pending',
            message: 'Сначала завершите ручное сохранение подборки.',
          );
        }
      }
      final source = await loadSource(
        ticket.sourceIdentity,
        () => requireTicket(ticket),
      );
      await requireTicket(ticket);
      if (source == null ||
          source.identity != anchor.sourceIdentity ||
          source.title != anchor.title ||
          !source.loaded ||
          source.tracks.isEmpty ||
          source.tracks.length != source.trackCount ||
          (source.snapshot != null &&
              source.snapshot!.availableCount <
                  source.snapshot!.snapshotCount) ||
          source.tracks.any((t) => !t.playable)) {
        throw _sourceMissing;
      }
      final staged = await mixes.stage(
        source,
        quality: ticket.quality,
        refreshTicket: ticket,
      );
      final jobs = <String, DeviceDownload>{};
      for (final track in source.tracks) {
        await requireTicket(ticket);
        final id = downloads.key(track.ref, ticket.quality, policy.fence.owner);
        if (jobs.containsKey(id)) continue;
        var job = await downloads.enqueue(
          track,
          ticket.quality,
          policy.fence,
          manual: false,
          origin: DownloadOrigin.offlineMixDaily,
          refreshTicket: ticket,
        );
        if (OfflineMixRefreshAdmission.onlyDaily(job) &&
            const {
              DownloadState.failed,
              DownloadState.paused,
            }.contains(job.state) &&
            job.errorCode != null &&
            job.errorCode != 'download_cancelled') {
          job = await downloads.resume(
            job.id,
            policy.fence,
            expectedGeneration: job.generation,
          );
          job = await downloads.enqueue(
            track,
            ticket.quality,
            policy.fence,
            manual: false,
            origin: DownloadOrigin.offlineMixDaily,
            refreshTicket: ticket,
          );
        }
        jobs[id] = job;
      }
      if (!await mixes.bind(
        staged.generation,
        jobs.values,
        refreshTicket: ticket,
      )) {
        throw _sourceMissing;
      }
      for (final job in jobs.values) {
        if (job.state == DownloadState.ready ||
            job.state == DownloadState.paused) {
          continue;
        }
        await requireTicket(ticket);
        await scheduleFile(job, job.manual ? null : ticket.revision);
      }
      if (!await commitIfReady()) await _status(ticket, 'waiting');
    } catch (error) {
      await downloads.store.transaction(policy.fence, (tx) async {
        if (!await policy.isCurrentIn(tx, ticket)) return;
        await tx.write(statusNamespace, 'current', {
          'version': 1,
          'revision': ticket.revision,
          'code': error is AppFailure && error.code == _sourceMissing.code
              ? 'source_unavailable'
              : error is AppFailure && error.code == restricted.code
              ? 'conditions'
              : 'failed',
          if (error is AppFailure && error.retryAfter != null)
            'retryNotBefore':
                policy.clock().millisecondsSinceEpoch +
                error.retryAfter!.inMilliseconds,
        });
        await policy.finishIn(tx, ticket, success: false);
      });
      rethrow;
    }
  }

  Future<bool> commitIfReady() async {
    final state = await mixes.read();
    final pending = state.pending;
    if (pending == null) return false;
    if (state.pendingReadyCount != pending.items.length) return false;
    final ticket = await downloads.store.transaction(
      policy.fence,
      (tx) => OfflineMixRefreshAdmission.bindingIn(
        tx,
        pending.generation,
        policy.fence,
      ),
    );
    if (ticket == null) return false;
    await requireTicket(ticket);
    return mixes.commit(
      pending.generation,
      refreshTicket: ticket,
      beforeCommit: () => requireTicket(ticket),
    );
  }

  Future<String> readStatus() async {
    final current = await policy.read();
    final pending = (await mixes.read()).pending;
    if (pending != null && current.enabled) {
      final bound = await downloads.store.transaction(
        policy.fence,
        (tx) => OfflineMixRefreshAdmission.bindingIn(
          tx,
          pending.generation,
          policy.fence,
        ),
      );
      if (bound == null) return 'manual_pending';
      for (final item in pending.items) {
        final job = await downloads.status(item.downloadId, policy.fence);
        if (job?.errorCode == 'offline_mix_quota_exceeded') return 'quota';
        if (job?.errorCode == 'download_storage_full' ||
            job?.errorCode == 'download_storage_error') {
          return 'storage';
        }
        if (job?.state == DownloadState.failed) return 'failed';
        if (job?.state == DownloadState.paused) return 'paused';
      }
    }
    final row = await downloads.store.transaction(
      policy.fence,
      (tx) => tx.read(statusNamespace, 'current'),
    );
    if (row?['retryNotBefore'] is int &&
        (row!['retryNotBefore'] as int) >
            policy.clock().millisecondsSinceEpoch) {
      return 'holdoff';
    }
    return row != null &&
            row['version'] is int &&
            row['version'] == 1 &&
            row['revision'] == current.revision &&
            row['code'] is String
        ? row['code'] as String
        : '';
  }

  Future<void> _status(OfflineMixRefreshTicket ticket, String code) =>
      downloads.store.transaction(policy.fence, (tx) async {
        if (await policy.isCurrentIn(tx, ticket)) {
          await tx.write(statusNamespace, 'current', {
            'version': 1,
            'revision': ticket.revision,
            'code': code,
          });
        }
      });

  static const _sourceMissing = AppFailure(
    code: 'offline_mix_refresh_source_unavailable',
    message:
        'Исходная подборка недоступна или изменилась. Готовый микс сохранён.',
  );
}
