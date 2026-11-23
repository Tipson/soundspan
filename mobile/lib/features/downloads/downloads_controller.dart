import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../core/model/app_failure.dart';
import '../../core/model/owner_key.dart';
import '../../core/model/track.dart';
import '../../core/network/network_policy.dart';
import '../../downloads/download_models.dart';
import '../../downloads/download_network_access.dart';
import '../../downloads/download_network_rules.dart';
import '../../downloads/download_repository.dart';
import '../../downloads/liked_download_automation.dart';
import '../../downloads/offline_mix_quota.dart';
import '../../downloads/stored_download_network_rules.dart';
import '../library/library_models.dart';

enum DownloadsFilter { all, ready, active, failed }

enum _ManualNetworkChoice { regular, once, waiting, cancelled }

/// Exact journal generations admitted by one manual batch, before completion.
/// A cancelled or rejected batch must not be interpreted as a saved mix.
final class DownloadBatchAdmission {
  DownloadBatchAdmission({
    required this.accepted,
    required this.cancelled,
    Iterable<DeviceDownload> jobs = const [],
  }) : jobs = List.unmodifiable(jobs);
  final bool accepted, cancelled;
  final List<DeviceDownload> jobs;
}

/// UI commands use only DownloadRepository and the existing native work bridge.
final class DownloadsController extends ChangeNotifier {
  DownloadsController({
    required this.repository,
    required this.fence,
    required this.networkPolicy,
    required this.storageReady,
    required this.schedule,
    required this.cancelJob,
    this.requestNotificationPermission,
    this.automation,
    this.networkAccess,
    this.confirmNetworkUse,
    this.onNetworkRulesChanged,
    this.offlineQuota,
  });
  final DownloadRepository repository;
  final SessionFence fence;
  final NetworkPolicy networkPolicy;
  final bool Function() storageReady;
  final ScheduleDeviceDownload schedule;
  final CancelDeviceDownload cancelJob;
  final Future<bool> Function()? requestNotificationPermission;
  final LikedDownloadAutomation? automation;
  final DownloadNetworkAccess? networkAccess;
  Future<bool> Function(int count)? confirmNetworkUse;
  final Future<void> Function()? onNetworkRulesChanged;
  final OfflineMixQuota? offlineQuota;
  OfflineMixQuotaUsage? _quotaUsage;
  AppFailure? _quotaFailure;
  bool _quotaLoading = false;
  int _quotaRevision = 0;
  OfflineMixQuotaUsage? get quotaUsage => isCurrent ? _quotaUsage : null;
  AppFailure? get quotaFailure => isCurrent ? _quotaFailure : null;
  bool get quotaLoading => isCurrent && _quotaLoading;

  Future<void> loadQuota() => _runQuota();
  Future<void> setQuotaLimit(int bytes) => _runQuota(limit: bytes);

  Future<void> _runQuota({int? limit}) {
    final quota = offlineQuota;
    if (!isCurrent || quota == null || _quotaLoading) return Future.value();
    final revision = ++_quotaRevision;
    _quotaLoading = true;
    _notify();
    return _track(() async {
      try {
        if (!identical(quota.repository, repository) || quota.fence != fence) {
          throw collectionStaleSession;
        }
        if (limit != null) await quota.setLimit(limit);
        final usage = await quota.usage();
        await repository.authority.assertCurrent(fence);
        if (isCurrent && revision == _quotaRevision) {
          _quotaUsage = usage;
          _quotaFailure = null;
        }
      } catch (_) {
        if (isCurrent && revision == _quotaRevision) {
          _quotaUsage = null;
          _quotaFailure = const AppFailure(
            code: 'offline_mix_quota_unavailable',
            message: 'Не удалось прочитать или сохранить лимит офлайн-микса. Повторите попытку.',
          );
        }
      } finally {
        if (revision == _quotaRevision) _quotaLoading = false;
        _notify();
      }
    });
  }

  DownloadNetworkRules? _networkRules;
  AppFailure? _networkRulesFailure;
  bool _networkRulesLoading = false;
  int _rulesRevision = 0;
  final _closedSignal = Completer<void>();
  DownloadNetworkRules? get networkRules => isCurrent ? _networkRules : null;
  AppFailure? get networkRulesFailure =>
      isCurrent ? _networkRulesFailure : null;
  bool get networkRulesLoading => isCurrent && _networkRulesLoading;

  void _checkNetworkAccess(DownloadNetworkAccess access) {
    if (access.fence != fence) throw collectionStaleSession;
  }

  /// Unknown future preferences remain untouched until an explicit new choice.
  Future<void> loadNetworkRules() {
    final access = networkAccess;
    if (!isCurrent || access == null || _networkRulesLoading) {
      return Future.value();
    }
    final revision = ++_rulesRevision;
    _networkRulesLoading = true;
    _notify();
    return _track(() async {
      try {
        _checkNetworkAccess(access);
        final rules = await access.rules();
        await repository.authority.assertCurrent(fence);
        if (isCurrent && revision == _rulesRevision) {
          _networkRules = rules;
          _networkRulesFailure = null;
        }
      } catch (error) {
        if (isCurrent && revision == _rulesRevision) {
          _networkRules = null;
          _networkRulesFailure = collectionFailure(error);
        }
      } finally {
        if (revision == _rulesRevision) _networkRulesLoading = false;
        _notify();
      }
    });
  }

  Future<void> setNetworkRules(DownloadNetworkRules rules) => _act(() async {
    ++_rulesRevision;
    _networkRulesLoading = false;
    try {
      final access = networkAccess;
      if (access == null) throw DownloadNetworkAccess.restricted;
      _checkNetworkAccess(access);
      await saveDownloadNetworkRules(repository.store, fence, rules);
      await repository.authority.assertCurrent(fence);
      if (!isCurrent) return;
      _networkRules = rules;
      _networkRulesFailure = null;
      _notify();
      await onNetworkRulesChanged?.call();
      await repository.authority.assertCurrent(fence);
    } catch (error) {
      if (isCurrent) _networkRulesFailure = collectionFailure(error);
    }
  });
  List<DeviceDownload> _jobs = const [];
  String _query = '';
  DownloadsFilter _filter = DownloadsFilter.all;
  AppFailure? failure;
  String? notice;
  bool loading = false;
  bool busy = false;
  bool _closed = false;
  bool _disposed = false;
  Timer? _poll;
  final _pending = <Future<void>>{};
  Future<void>? _closing;
  bool get isCurrent => !_closed && repository.authority.isCurrent(fence);
  bool get canDownload =>
      isCurrent && storageReady() && networkPolicy.networkAllowed;
  List<DeviceDownload> get jobs => isCurrent ? _jobs : const [];
  String get query => _query;
  DownloadsFilter get filter => _filter;
  List<DeviceDownload> get visible => List.unmodifiable(
    jobs.where((job) {
      final match = switch (_filter) {
        DownloadsFilter.all => true,
        DownloadsFilter.ready => job.state == DownloadState.ready,
        DownloadsFilter.active => const {
          DownloadState.queued,
          DownloadState.downloading,
          DownloadState.verifying,
          DownloadState.paused,
        }.contains(job.state),
        DownloadsFilter.failed => job.state == DownloadState.failed,
      };
      return match &&
          '${job.track.title} ${job.track.artist}'.toLowerCase().contains(
            _query.toLowerCase(),
          );
    }),
  );
  void _notify() {
    if (!_disposed) notifyListeners();
  }

  void setQuery(String value) {
    _query = value;
    _notify();
  }

  void setFilter(DownloadsFilter value) {
    _filter = value;
    _notify();
  }

  Future<void> _track(Future<void> Function() body) {
    late final Future<void> result;
    result = body().whenComplete(() => _pending.remove(result));
    _pending.add(result);
    return result;
  }

  Future<void> refresh() {
    if (!isCurrent || loading) return Future.value();
    return _track(() async {
      loading = true;
      try {
        final next = await repository.list(fence);
        await automation?.readPaused();
        await automation?.observeSnapshot(next);
        if (isCurrent) {
          _jobs = next;
        }
      } catch (error) {
        if (isCurrent) failure = collectionFailure(error);
      } finally {
        loading = false;
        _notify();
      }
    });
  }

  /// Bounded polling observes headless native commits only while the screen is
  /// visible and the app foregrounded. The root owns visibility across routes.
  void setVisible(bool value) {
    _poll?.cancel();
    _poll = null;
    if (!value || !isCurrent) return;
    unawaited(refresh());
    _poll = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!isCurrent) {
        setVisible(false);
        _notify();
      } else {
        unawaited(refresh());
      }
    });
  }

  Future<void> _act(Future<void> Function() body) {
    if (!isCurrent || busy) return Future.value();
    busy = true;
    failure = null;
    notice = null;
    _notify();
    return _track(() async {
      try {
        await repository.authority.assertCurrent(fence);
        await body();
      } catch (error) {
        if (isCurrent) failure = collectionFailure(error);
      } finally {
        busy = false;
        await refresh();
        _notify();
      }
    });
  }

  void _requireAdmission() {
    if (!storageReady()) {
      throw const AppFailure(
        code: 'storage_not_ready',
        message: 'Хранилище устройства пока недоступно. Проверьте память и повторите.',
      );
    }
    networkPolicy.requireNetwork();
  }

  Future<_ManualNetworkChoice> _manualNetworkChoice(int count) async {
    final access = networkAccess;
    if (access == null) return _ManualNetworkChoice.regular;
    _checkNetworkAccess(access);
    try {
      await access.requireNetwork();
      return _ManualNetworkChoice.regular;
    } on AppFailure catch (error) {
      if (error.code != DownloadNetworkAccess.restricted.code) rethrow;
    }
    final rules = await access.rules();
    final state = await access.readNetwork();
    await repository.authority.assertCurrent(fence);
    _requireAdmission();
    if (rules.allows(state)) return _ManualNetworkChoice.regular;
    final confirm = confirmNetworkUse;
    if (!rules.allows(state, oneOff: true) || confirm == null) {
      return _ManualNetworkChoice.waiting;
    }
    final allowed = await Future.any<bool>([
      confirm(count),
      _closedSignal.future.then((_) => false),
    ]);
    await repository.authority.assertCurrent(fence);
    if (!isCurrent) throw collectionStaleSession;
    return allowed ? _ManualNetworkChoice.once : _ManualNetworkChoice.cancelled;
  }

  Future<void> _admitAndSchedule(
    DeviceDownload job,
    _ManualNetworkChoice choice,
  ) async {
    if (choice == _ManualNetworkChoice.once) {
      try {
        await networkAccess!.allowOnce(job);
      } on AppFailure catch (error) {
        if (error.code != DownloadNetworkAccess.restricted.code) rethrow;
        // The route may change while consent is open. Keep a future-route job,
        // never turn that answer into permission for unknown/offline/roaming.
        notice = DownloadNetworkAccess.restricted.message;
      }
    } else if (choice == _ManualNetworkChoice.waiting) {
      notice = DownloadNetworkAccess.restricted.message;
    }
    await _schedule(job);
  }

  /// Receives the actual selected, already bounded collection subset. No crawl,
  /// count truncation or permission prompt occurs elsewhere in the feature.
  Future<DownloadBatchAdmission> queueTracks(
    List<Track> tracks, {
    String quality = 'original',
    DownloadOrigin origin = DownloadOrigin.manual,
  }) async {
    final selected = List<Track>.of(tracks);
    var accepted = false, cancelled = false;
    final admittedJobs = <DeviceDownload>[];
    await _act(() async {
      _requireAdmission();
      final pending = <Track>[];
      final readyToPin = <DeviceDownload>[];
      var alreadyReady = 0;
      if (networkAccess == null) {
        pending.addAll(selected);
      } else {
        final seen = <String>{};
        for (final track in selected) {
          if (!track.playable) continue;
          final id = repository.key(track.ref, quality, fence.owner);
          if (!seen.add(id)) continue;
          final existing = await repository.status(id, fence);
          if (existing?.state == DownloadState.ready) {
            alreadyReady++;
            readyToPin.add(existing!);
          } else {
            pending.add(track);
          }
        }
      }
      Future<void> retainReadyFiles() async {
        for (final job in readyToPin) {
          if (origin == DownloadOrigin.manual &&
              !await repository.pinReadyIfCurrent(
                job.id,
                fence,
                expectedGeneration: job.generation,
              )) {
            continue;
          }
          final current = await repository.status(job.id, fence);
          if (current?.state == DownloadState.ready &&
              current?.generation == job.generation) {
            admittedJobs.add(current!);
          }
        }
      }

      if (pending.isEmpty) {
        await retainReadyFiles();
        accepted = true;
        notice = 'Выбранные записи уже загружены или недоступны.';
        return;
      }
      final choice = await _manualNetworkChoice(pending.length);
      if (choice == _ManualNetworkChoice.cancelled) {
        cancelled = true;
        notice = 'Загрузка отменена.';
        return;
      }
      final permission = requestNotificationPermission;
      if (permission != null) {
        final allowed = await permission();
        await repository.authority.assertCurrent(fence);
        if (!allowed) notice = 'Доступ к уведомлениям не разрешён. Загрузка может работать в приложении; фоновый запуск зависит от ограничений Android.';
      }
      await retainReadyFiles();
      accepted = true;
      var admitted = alreadyReady;
      var skipped = 0;
      for (final track in pending) {
        if (!isCurrent) return;
        if (!track.playable) {
          skipped++;
          continue;
        }
        try {
          _requireAdmission();
          var job = await repository.enqueue(
            track,
            quality,
            fence,
            manual: true,
            origin: origin,
          );
          if (!isCurrent) return;
          if (job.state == DownloadState.ready) {
            admittedJobs.add(job);
            admitted++;
            continue;
          }
          if (job.state == DownloadState.paused ||
              job.state == DownloadState.failed) {
            job = await repository.resume(
              job.id,
              fence,
              expectedGeneration: job.generation,
            );
          }
          admittedJobs.add(job);
          await _admitAndSchedule(job, choice);
          admitted++;
        } catch (error) {
          if (!isCurrent) return;
          failure = collectionFailure(error);
          if (error is AppFailure && error.code == 'offline_mode') break;
        }
      }
      notice ??=
          'Выбрано ${selected.length}; в загрузках $admitted${skipped > 0 ? ', недоступно $skipped' : ''}.';
    });
    return DownloadBatchAdmission(
      accepted: isCurrent && accepted,
      cancelled: cancelled,
      jobs: isCurrent
          ? {for (final job in admittedJobs) job.id: job}.values
          : const [],
    );
  }

  Future<void> downloadTracks(
    List<Track> tracks, {
    String quality = 'original',
    DownloadOrigin origin = DownloadOrigin.manual,
  }) async {
    await queueTracks(tracks, quality: quality, origin: origin);
  }

  Future<void> _schedule(DeviceDownload job) async {
    await repository.authority.assertCurrent(fence);
    _requireAdmission();
    if (job.originalFence != fence || job.state == DownloadState.ready) return;
    await schedule(job.id, job.originalFence, job.generation);
  }

  Future<void> pause(DeviceDownload job) => _act(() async {
    final updated = await repository.pause(
      job.id,
      fence,
      expectedGeneration: job.generation,
    );
    if (updated.generation == job.generation + 1 &&
        updated.state == DownloadState.paused) {
      await cancelJob(job.id, job.originalFence, job.generation);
    }
  });
  Future<void> resume(DeviceDownload job) => _restart(job);
  Future<void> retry(DeviceDownload job) => _restart(job, retry: true);
  Future<void> _restart(DeviceDownload job, {bool retry = false}) =>
      _act(() async {
        _requireAdmission();
        if (job.state == DownloadState.ready) return;
        final current = await repository.status(job.id, fence);
        if (current == null ||
            current.generation != job.generation ||
            current.state == DownloadState.ready) {
          return;
        }
        final choice = await _manualNetworkChoice(1);
        if (choice == _ManualNetworkChoice.cancelled) {
          notice = 'Загрузка отменена.';
          return;
        }
        final updated = await repository.restartManually(
          job.id,
          fence,
          expectedGeneration: job.generation,
          retry: retry,
        );
        if (updated != null) {
          await _admitAndSchedule(updated, choice);
        }
      });
  Future<void> cancel(DeviceDownload job) => _act(() async {
    final cancelled = await repository.cancel(
      job.id,
      fence,
      expectedGeneration: job.generation,
    );
    if (cancelled) await cancelJob(job.id, job.originalFence, job.generation);
  });
  Future<void> remove(DeviceDownload job) => _act(() async {
    await repository.remove(job.id, fence, expectedGeneration: job.generation);
    await cancelJob(job.id, job.originalFence, job.generation);
  });
  Future<void> setAutomationPaused(bool value) => _act(() async {
    final a = automation;
    if (a == null) return;
    await a.setPaused(value, fence);
    if (!value) await a.reconcile(fence);
  });
  CollectionPlaybackRequest play(DeviceDownload selected) {
    if (!isCurrent) throw collectionStaleSession;
    final rows = visible
        .where((j) => j.state == DownloadState.ready && j.track.playable)
        .toList();
    final index = rows.indexWhere((j) => j.id == selected.id);
    if (index < 0) {
      throw const AppFailure(
        code: 'download_not_ready',
        message: 'Трек ещё не загружен.',
      );
    }
    return CollectionPlaybackRequest(
      tracks: rows.map((j) => j.track),
      startIndex: index,
      fence: fence,
    );
  }

  Future<void> close() => _closing ??= () async {
    _closed = true;
    if (!_closedSignal.isCompleted) _closedSignal.complete();
    ++_rulesRevision;
    _poll?.cancel();
    _poll = null;
    while (_pending.isNotEmpty) {
      await Future.wait(List.of(_pending));
    }
    _jobs = const [];
  }();
  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    unawaited(close());
    super.dispose();
  }
}
