import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../core/model/app_failure.dart';
import '../../downloads/download_models.dart';
import '../../downloads/offline_mix_repository.dart';
import '../../downloads/offline_mix_daily_refresh.dart';
import '../../downloads/offline_mix_refresh_policy.dart';
import '../home/home_models.dart';
import '../library/library_models.dart';
import 'downloads_controller.dart';

/// Manual offline snapshot admission, retaining the existing transfer pipeline.
final class OfflineMixController extends ChangeNotifier {
  OfflineMixController({
    required this.repository,
    required this.downloads,
    this.dailyRefresh,
  }) {
    if (!identical(repository.downloads, downloads.repository) ||
        repository.fence != downloads.fence) {
      throw ArgumentError('Offline mix and downloads must share an owner');
    }
  }
  final OfflineMixRepository repository;
  final DownloadsController downloads;
  final OfflineMixDailyRefresh? dailyRefresh;
  OfflineMixRefreshState _dailyState = const OfflineMixRefreshState();
  OfflineMixRefreshState get dailyState =>
      isCurrent ? _dailyState : const OfflineMixRefreshState();
  String _dailyCode = '';
  String get dailyStatus => switch (_dailyCode) {
    'complete' => 'Последнее обновление полностью сохранено.',
    'waiting' => 'Новый состав сохраняется. Готовый микс остаётся доступен.',
    'source_unavailable' =>
      'Источник недоступен или переименован. Готовый микс сохранён.',
    'conditions' => 'Обновление ждёт зарядку и сеть без тарификации.',
    'holdoff' =>
      'Сервер попросил подождать перед повтором. Готовый микс сохранён.',
    'failed' => 'Не удалось обновить. Готовый микс сохранён; можно повторить.',
    'quota' =>
      'Лимит офлайн-микса исчерпан. Измените его выше и повторите обновление.',
    'storage' => 'Не хватает памяти устройства. Готовый микс сохранён.',
    'paused' => 'Загрузка приостановлена. Готовый микс остаётся доступен.',
    'manual_pending' => 'Автообновление ожидает завершения ручного сохранения.',
    'source_changed' => 'Сохранённая подборка изменилась. Выключите и снова включите обновление для её выбора.',
    'scheduled' => 'Повтор назначен на зарядке и в сети без тарификации.',
    _ =>
      _dailyState.enabled
          ? 'Ежедневно на зарядке и в сети без тарификации.'
          : 'Автоматическое обновление выключено.',
  };
  AppFailure? dailyFailure;
  bool _dailyBusy = false;
  bool get dailyBusy => isCurrent && _dailyBusy;

  Future<void> loadDailySettings() => _dailyAction(() async {});
  Future<void> setDailyEnabled(bool enabled) => _dailyAction(() async {
    await dailyRefresh?.configure(enabled);
  });
  Future<void> retryDailyRefresh() => _dailyAction(() async {
    await dailyRefresh?.retry();
    if (isCurrent) _dailyCode = 'scheduled';
  }, retainStatus: true);

  Future<void> _dailyAction(
    Future<void> Function() action, {
    bool retainStatus = false,
  }) {
    final daily = dailyRefresh;
    if (!isCurrent || daily == null || _dailyBusy) return Future.value();
    _dailyBusy = true;
    _notify();
    return _track(() async {
      Object? actionError;
      try {
        try {
          await action();
        } catch (error) {
          actionError = error;
        }
        final saved = await repository.read();
        final policy = await daily.policy.read();
        final status = await daily.readStatus();
        if (!isCurrent) return;
        _state = saved;
        _dailyState = policy;
        if (!retainStatus) {
          _dailyCode = status;
        }
        if (policy.enabled &&
            (saved.active?.sourceIdentity != policy.sourceIdentity ||
                saved.active?.quality != policy.quality)) {
          _dailyCode = 'source_changed';
        }
        dailyFailure = actionError == null
            ? null
            : collectionFailure(actionError);
      } catch (error) {
        if (isCurrent) dailyFailure = collectionFailure(error);
      } finally {
        _dailyBusy = false;
        _notify();
      }
    });
  }

  OfflineMixState _state = const OfflineMixState();
  AppFailure? _failure;
  String? _notice;
  bool _saving = false, _disposed = false;
  bool _closed = false;
  bool get isCurrent => !_closed && downloads.isCurrent;
  OfflineMixState get state => isCurrent ? _state : const OfflineMixState();
  AppFailure? get failure => isCurrent ? _failure : null;
  String? get notice => isCurrent ? _notice : null;
  bool get busy => isCurrent && _saving;
  final _closedSignal = Completer<void>();
  final _pending = <Future<void>>{};
  Future<void>? _refreshing, _closing;

  void _notify() {
    if (!_disposed && isCurrent) notifyListeners();
  }

  Future<void> _track(Future<void> Function() action) {
    late final Future<void> result;
    result = action().whenComplete(() => _pending.remove(result));
    _pending.add(result);
    return result;
  }

  /// A fully cached user selection is local even in explicit offline mode.
  /// Other selections reuse the existing consent/permission/worker admission.
  Future<void> save(MusicMix source, {String quality = 'original'}) async =>
      _save(source, quality);

  /// Retry the retained composition, rather than silently fetching a different
  /// day's mix or following the generation of a newer user download.
  Future<void> retry() async {
    if (!isCurrent || busy) return;
    final pending = state.pending;
    if (pending == null) return refresh();
    final separator = pending.sourceIdentity.indexOf(':');
    try {
      if (separator < 1) throw const FormatException('Mix source');
      final kind = MusicMixKind.values.byName(
        pending.sourceIdentity.substring(0, separator),
      );
      await _save(
        MusicMix(
          id: pending.sourceIdentity.substring(separator + 1),
          title: pending.title,
          description: '',
          kind: kind,
          generationId: pending.sourceGenerationId,
          tracks: pending.tracks,
        ),
        pending.quality,
      );
    } on FormatException {
      if (isCurrent) {
        _failure = const AppFailure(
          code: 'offline_mix_source_unknown',
          message:
              'Не удалось повторить сохранение. Откройте исходную подборку.',
        );
        _notify();
      }
    } on ArgumentError {
      if (isCurrent) {
        _failure = const AppFailure(
          code: 'offline_mix_source_unknown',
          message:
              'Не удалось повторить сохранение. Откройте исходную подборку.',
        );
        _notify();
      }
    }
  }

  Future<void> pin(OfflineMixItem item) => _track(() async {
    if (!isCurrent || item.downloadGeneration == null) return;
    final applied = await repository.downloads.pinReadyIfCurrent(
      item.downloadId,
      repository.fence,
      expectedGeneration: item.downloadGeneration!,
    );
    if (!isCurrent) return;
    if (!applied) {
      throw const AppFailure(
        code: 'offline_mix_file_changed',
        message: 'Файл изменился. Откройте актуальную загрузку.',
      );
    }
    _notice = 'Трек сохранён отдельно от микса.';
    _notify();
  });

  Future<void> _save(MusicMix source, String quality) {
    if (!isCurrent || _saving) return Future.value();
    _saving = true;
    _failure = null;
    _notice = null;
    _notify();
    return _track(() async {
      try {
        final draft = await repository.stage(source, quality: quality);
        if (!isCurrent) return;
        _state = await repository.read();
        _notify();
        final ready = <String, DeviceDownload>{};
        for (final item in draft.items) {
          if (ready.containsKey(item.downloadId)) continue;
          final job = await repository.downloads.status(
            item.downloadId,
            repository.fence,
          );
          if (!isCurrent) return;
          if (job?.state != DownloadState.ready || job?.sha256 == null) break;
          ready[item.downloadId] = job!;
        }
        final count = draft.items.map((item) => item.downloadId).toSet().length;
        late final List<DeviceDownload> jobs;
        if (ready.length == count) {
          jobs = ready.values.toList();
        } else {
          final result = await Future.any<DownloadBatchAdmission>([
            downloads.queueTracks(
              source.tracks,
              quality: quality,
              origin: DownloadOrigin.offlineMix,
            ),
            _closedSignal.future.then(
              (_) => DownloadBatchAdmission(accepted: false, cancelled: false),
            ),
          ]);
          if (!isCurrent) return;
          if (!result.accepted) {
            await repository.cancel(draft.generation);
            if (result.cancelled) {
              _notice = _state.active == null
                  ? 'Сохранение отменено.'
                  : 'Сохранение отменено. Готовый микс остаётся доступен.';
            } else {
              _failure =
                  downloads.failure ??
                  const AppFailure(
                    code: 'offline_mix_not_admitted',
                    message: 'Не удалось начать сохранение подборки. Повторите попытку.',
                  );
            }
            return;
          }
          jobs = result.jobs;
        }
        if (!isCurrent) return;
        if (jobs.isEmpty || !await repository.bind(draft.generation, jobs)) {
          throw const AppFailure(
            code: 'offline_mix_changed',
            message: 'Сохранение подборки изменилось. Повторите попытку.',
          );
        }
        await refresh();
        if (isCurrent && downloads.failure != null && _state.pending != null) {
          _failure = downloads.failure;
        }
      } catch (error) {
        if (isCurrent) _failure = collectionFailure(error);
      } finally {
        _saving = false;
        if (isCurrent) {
          try {
            _state = await repository.read();
          } catch (error) {
            if (isCurrent) _failure ??= collectionFailure(error);
          }
          _notify();
        }
      }
    });
  }

  /// Observe durable worker commits without scheduling jobs or repeating consent.
  /// Unbound pre-consent drafts stay pending until another explicit save.
  Future<void> refresh() {
    if (!isCurrent) return Future.value();
    final running = _refreshing;
    if (running != null) return running;
    final result = _track(() async {
      try {
        final before = await repository.read();
        if (!isCurrent) return;
        final pending = before.pending;
        if (dailyRefresh != null && pending != null) {
          try {
            await dailyRefresh!.commitIfReady();
          } on AppFailure catch (error) {
            if (error.code != OfflineMixDailyRefresh.restricted.code &&
                error.code != 'offline_mix_refresh_stale') {
              rethrow;
            }
          }
        }
        if (pending != null &&
            pending.items.every((i) => i.downloadGeneration != null)) {
          await repository.commit(pending.generation);
        }
        final next = await repository.read();
        if (!isCurrent) return;
        _state = next;
        _failure = null;
      } catch (error) {
        if (isCurrent) _failure = collectionFailure(error);
      } finally {
        _notify();
      }
    });
    _refreshing = result.whenComplete(() => _refreshing = null);
    return _refreshing!;
  }

  Future<void> close() {
    if (_closing != null) return _closing!;
    _closed = true;
    _closedSignal.complete();
    return _closing = Future.wait(_pending.toList()).then((_) {});
  }

  @override
  void dispose() {
    if (!_closed) unawaited(close());
    _disposed = true;
    super.dispose();
  }
}
