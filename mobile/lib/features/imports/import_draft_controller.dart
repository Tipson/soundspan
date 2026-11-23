import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../core/model/app_failure.dart';
import '../../core/session/session_authority.dart';
import 'import_draft_models.dart';
import 'import_repository.dart';

/// UI orchestration over the existing server journal. No local import job engine.
final class ImportDraftController extends ChangeNotifier {
  ImportDraftController({required this.repository, required this.supported}) {
    _changes = repository.authority.changes.listen((_) {
      if (!isCurrent && !_closed) {
        _job = null;
        _history = const [];
        _selection.clear();
        notifyListeners();
      }
    });
  }
  final ImportRepository repository;
  final bool Function() supported;
  late final StreamSubscription<SessionState> _changes;
  ImportDraftJob? _job;
  List<ImportDraftJob> _history = const [];
  final _selection = <ImportDraftCategory>{};
  AppFailure? _failure;
  bool _busy = false, _closed = false, _dirty = false;
  int _inputRevision = 0;
  final _pending = <Future<void>>{};
  Future<void>? _closing;
  bool get isCurrent => !_closed && repository.isCurrent;
  bool get available => isCurrent && repository.networkAllowed && supported();
  ImportDraftJob? get job => isCurrent ? _job : null;
  List<ImportDraftJob> get history => isCurrent ? _history : const [];
  Set<ImportDraftCategory> get selection =>
      isCurrent ? Set.unmodifiable(_selection) : const {};
  AppFailure? get failure => isCurrent ? _failure : null;
  bool get busy => isCurrent && _busy;
  bool get dirty => isCurrent && _dirty;
  bool get canConfirm =>
      available &&
      !busy &&
      !dirty &&
      job?.canConfirm == true &&
      _selection.isNotEmpty;

  void _notify() {
    if (isCurrent) notifyListeners();
  }

  void sourceEdited() {
    if (!isCurrent) return;
    _inputRevision++;
    _dirty = true;
    _selection.clear();
    _notify();
  }

  void choose(ImportDraftCategory category, bool selected) {
    if (!available ||
        busy ||
        dirty ||
        job?.canConfirm != true ||
        job!.count(category) == 0) {
      return;
    }
    selected ? _selection.add(category) : _selection.remove(category);
    _notify();
  }

  void newDraft() {
    if (!isCurrent || busy) return;
    _job = null;
    _selection.clear();
    _failure = null;
    _dirty = false;
    _inputRevision++;
    _notify();
  }

  void showFailure(Object error) {
    if (!isCurrent) return;
    _failure = error is AppFailure
        ? error
        : const AppFailure(
            code: 'import_file_unavailable',
            message: 'Не удалось прочитать файл. Выберите его ещё раз.',
          );
    _notify();
  }

  void _accept(ImportDraftJob next, {bool clearDirty = false}) {
    _job = next;
    _history = List.unmodifiable([
      next,
      ..._history.where((j) => j.id != next.id),
    ]);
    if (clearDirty) _dirty = false;
    _selection.clear();
  }

  Future<void> _act(Future<void> Function() body) {
    if (!isCurrent || _busy) return Future.value();
    if (!available) {
      _failure = const AppFailure(
        code: 'import_drafts_unsupported',
        message: 'Этот импорт доступен в новой версии сервера при подключении к сети.',
      );
      _notify();
      return Future.value();
    }
    _busy = true;
    _failure = null;
    _notify();
    late final Future<void> work;
    work = () async {
      try {
        await body();
      } catch (error) {
        if (isCurrent) {
          _failure = error is AppFailure
              ? error
              : const AppFailure(
                  code: 'import_draft_unavailable',
                  message: 'Не удалось получить ответ. Обновите состояние этого импорта; повторная отправка не выполняется автоматически.',
                );
        }
      } finally {
        _busy = false;
        _pending.remove(work);
        _notify();
      }
    }();
    _pending.add(work);
    return work;
  }

  Future<void> refresh() => _act(() async {
    final selected = _job;
    if (selected != null) {
      final next = await repository.getDraft(selected.id);
      if (isCurrent) _accept(next);
    } else {
      final next = await repository.listDrafts();
      if (isCurrent) _history = next;
    }
  });
  Future<void> open(String id) => _act(() async {
    final next = await repository.getDraft(id);
    if (isCurrent) _accept(next, clearDirty: true);
  });

  Future<void> prepare({
    required String content,
    String format = 'text',
    String? name,
    String textCategory = 'playlists',
  }) => _act(() async {
    final inputRevision = _inputRevision;
    final previous = _job;
    _selection.clear();
    final next = previous != null && previous.editable
        ? await repository.updateDraft(
            previous,
            content: content,
            format: format,
            name: name,
            textCategory: textCategory,
          )
        : await repository.createDraft(
            content: content,
            format: format,
            name: name,
            textCategory: textCategory,
          );
    if (!isCurrent) return;
    _accept(next, clearDirty: inputRevision == _inputRevision);
    if (inputRevision != _inputRevision || !next.editable) return;
    final previewing = await repository.previewDraft(next);
    if (isCurrent) {
      _accept(previewing, clearDirty: inputRevision == _inputRevision);
    }
  });

  Future<void> confirm() {
    if (!canConfirm) return Future.value();
    final selected = Set<ImportDraftCategory>.of(_selection);
    final original = job!;
    return _act(() async {
      // A failed/ambiguous response keeps the job ID for read-only recovery.
      final next = await repository.confirmDraft(original, selected);
      if (isCurrent) _accept(next);
    });
  }

  Future<void> cancel() {
    final original = job;
    if (original == null || !original.cancellable) return Future.value();
    return _act(() async {
      final next = await repository.cancelDraft(original.id);
      if (isCurrent) _accept(next);
    });
  }

  Future<void> retry() {
    final original = job;
    if (original == null || !original.canRetryConfirmed) return Future.value();
    return _act(() async {
      final next = await repository.confirmDraft(
        original,
        original.confirmedCategories,
      );
      if (isCurrent) _accept(next);
    });
  }

  Future<void> close() => _closing ??= _close();
  Future<void> _close() async {
    if (_closed) return;
    _closed = true;
    await _changes.cancel();
    await Future.wait(_pending.toList());
    _job = null;
    _history = const [];
    _selection.clear();
    super.dispose();
  }
}
