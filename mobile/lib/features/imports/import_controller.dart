import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../core/model/app_failure.dart';
import '../../core/session/session_authority.dart';
import 'import_models.dart';
import 'import_repository.dart';

final class ImportState {
  const ImportState({
    this.jobs = const [],
    this.selected,
    this.preview,
    this.outcome,
    this.loading = false,
    this.busy = false,
    this.uncertain = false,
    this.pendingLabel,
    this.failure,
  });
  final List<ImportJob> jobs;
  final ImportJob? selected;
  final ImportPreview? preview;
  final ImportOutcome? outcome;
  final bool loading, busy, uncertain;
  final String? pendingLabel;
  final AppFailure? failure;
}

/// A retained owner-scoped controller. Leaving the screen never cancels a job.
final class ImportController extends ChangeNotifier {
  ImportController({required this.repository}) {
    _subscription = repository.authority.changes.listen((_) {
      if (!isCurrent) {
        _state = const ImportState();
        _generation++;
        notifyListeners();
      }
    });
  }
  final ImportRepository repository;
  late final StreamSubscription<SessionState> _subscription;
  ImportState _state = const ImportState();
  ImportState get state => isCurrent ? _state : const ImportState();
  bool _disposed = false, _restored = false;
  int _generation = 0;
  final _pending = <Future<void>>{};
  bool get isCurrent => !_disposed && repository.isCurrent;
  bool get canMutate =>
      isCurrent &&
      repository.networkAllowed &&
      !_state.busy &&
      !_state.loading &&
      !_state.uncertain;
  bool get canRead =>
      isCurrent && repository.networkAllowed && !_state.busy && !_state.loading;
  bool get hasActiveJobs =>
      state.jobs.any((j) => j.active) || state.selected?.active == true;
  void _emit({
    List<ImportJob>? jobs,
    ImportJob? selected,
    ImportPreview? preview,
    ImportOutcome? outcome,
    bool? loading,
    bool? busy,
    bool? uncertain,
    String? pendingLabel,
    AppFailure? failure,
    bool clearPreview = false,
    bool clearOutcome = false,
  }) {
    if (!isCurrent) return;
    _state = ImportState(
      jobs: jobs ?? _state.jobs,
      selected: selected ?? _state.selected,
      preview: clearPreview ? null : preview ?? _state.preview,
      outcome: clearOutcome ? null : outcome ?? _state.outcome,
      loading: loading ?? false,
      busy: busy ?? _state.busy,
      uncertain: uncertain ?? _state.uncertain,
      pendingLabel: pendingLabel ?? _state.pendingLabel,
      failure: failure,
    );
    notifyListeners();
  }

  Future<void> _track(Future<void> Function() action) {
    final work = action();
    _pending.add(work);
    unawaited(
      work.then(
        (_) => _pending.remove(work),
        onError: (Object _, StackTrace _) => _pending.remove(work),
      ),
    );
    return work;
  }

  Future<void> _restore() async {
    if (_restored) return;
    final pending = await repository.readPending();
    if (!isCurrent) return;
    _restored = true;
    if (pending != null) {
      _emit(
        uncertain: true,
        pendingLabel: pending['label'] is String
            ? pending['label'] as String
            : 'Предыдущий импорт',
        loading: _state.loading,
        busy: _state.busy,
      );
    }
  }

  Future<void> refresh() => _read(() async {
    await _restore();
    if (!isCurrent) return;
    final jobs = await repository.listJobs();
    if (!isCurrent) return;
    ImportJob? selected;
    for (final job in jobs) {
      if (job.id == _state.selected?.id) selected = job;
    }
    _emit(jobs: jobs, selected: selected);
  });
  Future<void> openJob(String id) => _read(() async {
    await _restore();
    if (!isCurrent) return;
    final job = await repository.getJob(id);
    if (isCurrent) _putJob(job);
  });
  Future<void> reconnect(String input) => _read(() async {
    await _restore();
    if (!isCurrent) return;
    final source = ImportSource.parse(input);
    final job = await repository.reconnect(source.url);
    if (isCurrent) _putJob(job);
  });
  Future<void> _read(Future<void> Function() action) {
    if (!isCurrent || _state.busy || _state.loading) return Future.value();
    return _track(() async {
      final generation = ++_generation;
      _emit(loading: true);
      try {
        await action();
      } catch (error) {
        if (isCurrent && generation == _generation) {
          _emit(failure: _failure(error));
        }
      } finally {
        if (isCurrent && generation == _generation) {
          _emit(failure: _state.failure);
        }
      }
    });
  }

  void _putJob(ImportJob job) {
    _emit(
      selected: job,
      jobs: List.unmodifiable([
        job,
        ..._state.jobs.where((j) => j.id != job.id),
      ]),
    );
  }

  Future<void> submit(String input, {String? name}) async {
    if (!canMutate) return;
    ImportSource source;
    try {
      source = ImportSource.parse(input);
    } catch (e) {
      _emit(failure: _failure(e));
      return;
    }
    await _mutate(
      {'kind': 'submit', 'label': 'Импорт ссылки', 'source': source.identity},
      () async {
        final job = await repository.submit(source.url, name: name);
        if (isCurrent) _putJob(job);
      },
    );
  }

  Future<void> cancel(ImportJob job) async {
    if (!job.canCancel || !_state.jobs.any((j) => j.id == job.id)) return;
    await _mutate(
      {'kind': 'cancel', 'label': 'Отмена задания', 'jobId': job.id},
      () async {
        final result = await repository.cancel(job.id);
        if (isCurrent) _putJob(result);
      },
    );
  }

  Future<void> retry(ImportJob job) async {
    if (!job.canRetry || !_state.jobs.any((j) => j.id == job.id)) return;
    await _mutate(
      {'kind': 'retry', 'label': 'Повтор поиска записей', 'jobId': job.id},
      () async {
        final result = await repository.retry(job.id);
        if (isCurrent) _putJob(result);
      },
    );
  }

  Future<void> previewM3u(String content, {String? name}) =>
      _preview(() => repository.previewM3u(content, name: name));
  Future<void> previewUrl(String input) =>
      _preview(() => repository.preview(ImportSource.parse(input).url));
  Future<void> _preview(Future<ImportPreview> Function() load) {
    if (!canMutate) return Future.value();
    return _read(() async {
      await _restore();
      if (!isCurrent || _state.uncertain) return;
      _emit(loading: true, clearPreview: true, clearOutcome: true);
      final preview = await load();
      if (isCurrent) _emit(preview: preview);
    });
  }

  Future<void> execute({String? name}) async {
    final preview = _state.preview;
    if (preview == null || preview.summary.importable == 0) return;
    await _mutate(
      {
        'kind': 'execute',
        'label': 'Создание плейлиста из предпросмотра',
        'fingerprint': ImportRepository.fingerprint(preview),
        'count': preview.summary.total,
      },
      () async {
        final outcome = await repository.execute(preview, name: name);
        if (isCurrent) _emit(outcome: outcome, clearPreview: true);
      },
    );
  }

  Future<void> _mutate(
    Map<String, Object?> intent,
    Future<void> Function() operation,
  ) {
    if (!canMutate) return Future.value();
    return _track(() async {
      _emit(busy: true);
      bool dispatched = false;
      try {
        await _restore();
        if (!isCurrent || _state.uncertain) return;
        await repository.savePending(intent);
        if (!isCurrent) return;
        dispatched = true;
        await operation();
        if (!isCurrent) return;
        await repository.clearPending();
        if (!isCurrent) return;
        _emit(busy: false, uncertain: false);
      } catch (error) {
        if (!isCurrent) return;
        final definite =
            error is AppFailure &&
            ((error.statusCode != null &&
                    const {
                      400,
                      401,
                      403,
                      404,
                      409,
                      413,
                      422,
                      429,
                    }.contains(error.statusCode)) ||
                const {
                  'offline_mode',
                  'invalid_import_url',
                  'import_name',
                  'request_too_large',
                }.contains(error.code));
        var uncertain = dispatched && !definite;
        if (dispatched && definite) {
          try {
            await repository.clearPending();
          } catch (_) {
            uncertain = true;
          }
        }
        if (isCurrent) {
          _emit(
            busy: false,
            uncertain: uncertain,
            pendingLabel: intent['label'] as String,
            failure: _failure(error),
          );
        }
      } finally {
        if (isCurrent) _emit(busy: false, failure: _state.failure);
      }
    });
  }

  /// Called only by an explicit warning dialog. This never repeats an operation.
  Future<void> acknowledgeDuplicateRisk() => _track(() async {
    if (!isCurrent || _state.busy || _state.loading || !_state.uncertain) {
      return;
    }
    _emit(busy: true);
    try {
      await repository.clearPending();
      if (isCurrent) {
        _state = ImportState(jobs: _state.jobs, selected: _state.selected);
        notifyListeners();
      }
    } catch (e) {
      if (isCurrent) _emit(busy: false, failure: _failure(e));
    }
  });
  void dismissPreview() {
    if (canMutate) _emit(clearPreview: true);
  }

  void showFailure(Object error) {
    if (isCurrent) _emit(failure: _failure(error));
  }

  AppFailure _failure(Object error) => error is AppFailure
      ? error
      : const AppFailure(
          code: 'import_unavailable',
          message:
              'Не удалось получить ответ сервера. Проверьте состояние импорта.',
        );
  Future<void> close() async {
    dispose();
    while (_pending.isNotEmpty) {
      await Future.wait(List.of(_pending));
    }
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _generation++;
    repository.revoke();
    unawaited(_subscription.cancel());
    super.dispose();
  }
}
