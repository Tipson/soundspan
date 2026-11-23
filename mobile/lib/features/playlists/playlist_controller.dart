import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../core/model/app_failure.dart';
import '../../core/model/owner_key.dart';
import '../../core/model/track.dart';
import '../../core/session/session_authority.dart';
import '../library/library_models.dart';
import 'playlist_models.dart';
import 'playlist_repository.dart';

final class PlaylistState {
  PlaylistState({
    Iterable<PlaylistSummary> playlists = const [],
    this.detail,
    this.loading = false,
    this.loadingMore = false,
    this.busy = false,
    this.uncertain = false,
    this.failure,
    this.stale = false,
    this.deleted = false,
    this.pendingIntent,
    this.reconciled = false,
  }) : playlists = List.unmodifiable(playlists);
  final List<PlaylistSummary> playlists;
  final PlaylistDetail? detail;
  final bool loading, loadingMore, busy, uncertain, stale, deleted;
  final AppFailure? failure;
  final String? pendingIntent;
  final bool reconciled;
}

/// One owner-scoped feature controller. An uncertain intent is never replayed.
final class PlaylistController extends ChangeNotifier {
  PlaylistController({required this.repository}) {
    _subscription = repository.authority.changes.listen((_) {
      if (!isCurrent) {
        _revoked = true;
        _generation++;
        _state = PlaylistState(stale: true);
        notifyListeners();
      }
    });
  }
  final PlaylistRepository repository;
  late final StreamSubscription<SessionState> _subscription;
  PlaylistState _state = PlaylistState();
  PlaylistState get state => isCurrent ? _state : PlaylistState(stale: true);
  bool _disposed = false;
  bool _revoked = false;
  bool _mutationTouched = false;
  int _generation = 0;
  String? _id;
  String? _deletingId;
  final _cursors = <String>{};
  bool get isCurrent => !_disposed && !_revoked && repository.isCurrent;
  bool get canMutate =>
      isCurrent && repository.canMutate && !_state.busy && !_state.uncertain;
  SessionFence get fence => repository.fence;
  void _emit({
    List<PlaylistSummary>? playlists,
    PlaylistDetail? detail,
    bool? loading,
    bool? loadingMore,
    bool? busy,
    bool? uncertain,
    AppFailure? failure,
    bool? deleted,
    String? pendingIntent,
    bool? reconciled,
  }) {
    if (!isCurrent) return;
    _state = PlaylistState(
      playlists: playlists ?? _state.playlists,
      detail: detail ?? _state.detail,
      loading: loading ?? false,
      loadingMore: loadingMore ?? false,
      busy: busy ?? _state.busy,
      uncertain: uncertain ?? _state.uncertain,
      failure: failure,
      deleted: deleted ?? _state.deleted,
      pendingIntent: pendingIntent ?? _state.pendingIntent,
      reconciled: reconciled ?? _state.reconciled,
    );
    notifyListeners();
  }

  Future<void> refreshList() async {
    if (!isCurrent || _state.busy) return;
    final generation = ++_generation;
    _emit(loading: true);
    try {
      final rows = await repository.list();
      if (isCurrent && generation == _generation) _emit(playlists: rows);
    } catch (e) {
      if (isCurrent && generation == _generation) {
        _emit(failure: collectionFailure(e));
      }
    }
  }

  Future<void> open(String id) async {
    if (!isCurrent || _state.busy) return;
    if (_id != id) {
      _state = PlaylistState(
        playlists: _state.playlists,
        uncertain: _state.uncertain,
        pendingIntent: _state.pendingIntent,
      );
    }
    _id = id;
    final generation = ++_generation;
    _emit(loading: true, deleted: false);
    try {
      final page = await repository.page(id, null);
      if (!isCurrent || generation != _generation) return;
      _cursors.clear();
      if (page.nextCursor != null) _cursors.add(page.nextCursor!);
      _emit(
        detail: PlaylistDetail(
          playlist: page.playlist,
          items: page.items,
          total: page.total,
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
        ),
      );
    } catch (e) {
      if (isCurrent && generation == _generation) {
        _emit(failure: collectionFailure(e));
      }
    }
  }

  Future<void> refresh() => _id == null ? refreshList() : open(_id!);
  Future<void> loadMore() async {
    final before = _state.detail;
    if (!isCurrent ||
        _state.busy ||
        _state.loading ||
        _state.loadingMore ||
        before == null ||
        !before.hasMore) {
      return;
    }
    final generation = _generation;
    _emit(loadingMore: true);
    try {
      final page = await repository.page(before.playlist.id, before.nextCursor);
      if (!isCurrent || generation != _generation) return;
      final keys = before.items.map((e) => e.id).toSet();
      if (page.items.any((e) => !keys.add(e.id)) ||
          (page.nextCursor != null && !_cursors.add(page.nextCursor!))) {
        throw collectionFailure(StateError('repeated page'));
      }
      final items = [...before.items, ...page.items];
      if (items.length > page.total ||
          (!page.hasMore && items.length != page.total)) {
        throw collectionFailure(StateError('inconsistent page'));
      }
      _emit(
        detail: PlaylistDetail(
          playlist: page.playlist,
          items: items,
          total: page.total,
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
        ),
      );
    } catch (e) {
      if (isCurrent && generation == _generation) {
        _emit(failure: collectionFailure(e));
      }
    }
  }

  void _requireMutation({bool owner = true}) {
    if (!isCurrent) throw collectionStaleSession;
    repository.networkPolicy.requireNetwork();
    if (_state.busy) throw playlistBusy;
    if (_state.uncertain) throw playlistUncertain;
    if (owner && _state.detail?.playlist.isOwner != true) {
      throw playlistForbidden;
    }
  }

  bool _ambiguous(Object e) =>
      e is! AppFailure ||
      (e.statusCode != null && e.statusCode! >= 500) ||
      const {
        'network_timeout',
        'network_unavailable',
        'invalid_json',
        'invalid_json_type',
        'invalid_http_response',
        'response_too_large',
        'invalid_collection',
      }.contains(e.code);
  Future<T> _mutate<T>(
    String intent,
    Future<T> Function() action, {
    bool owner = true,
    String? deletingId,
  }) async {
    _requireMutation(owner: owner);
    ++_generation;
    _mutationTouched = false;
    _deletingId = deletingId;
    _emit(busy: true, pendingIntent: intent, reconciled: false);
    try {
      final value = await action();
      if (!isCurrent) throw collectionStaleSession;
      _emit(busy: false);
      return value;
    } catch (e) {
      if (isCurrent) {
        _emit(
          busy: false,
          uncertain: _mutationTouched || _ambiguous(e),
          failure: _mutationTouched || _ambiguous(e)
              ? playlistUncertain
              : collectionFailure(e),
        );
      }
      rethrow;
    } finally {
      _generation++;
    }
  }

  Future<PlaylistSummary> create(PlaylistDraft draft) async {
    draft.payload;
    final created = await _mutate(
      'Создание «${draft.name}»',
      () => repository.create(draft),
      owner: false,
    );
    if (isCurrent) _emit(playlists: [created, ..._state.playlists]);
    return created;
  }

  Future<void> update(PlaylistPatch patch) async {
    patch.payload;
    final id = _state.detail?.playlist.id;
    _requireMutation();
    await _mutate('Изменение плейлиста', () => repository.update(id!, patch));
    if (isCurrent) await open(id!);
  }

  Future<void> delete() async {
    final id = _state.detail?.playlist.id;
    _requireMutation();
    await _mutate(
      'Удаление плейлиста',
      () => repository.delete(id!),
      deletingId: id,
    );
    if (isCurrent) {
      _id = null;
      _state = PlaylistState(
        playlists: _state.playlists.where((e) => e.id != id),
        deleted: true,
      );
      notifyListeners();
    }
  }

  Future<void> hide(bool hidden) async {
    final id = _state.detail?.playlist.id;
    if (id == null) throw playlistForbidden;
    await _mutate(
      hidden ? 'Скрытие плейлиста' : 'Возврат плейлиста',
      () => repository.hide(id, hidden),
      owner: false,
    );
    if (isCurrent) await open(id);
  }

  Future<void> add(List<Track> tracks) async {
    for (final t in tracks) {
      playlistAddPayload(t);
    }
    final id = _state.detail?.playlist.id;
    _requireMutation();
    await _mutate('Добавление ${tracks.length} записей', () async {
      for (final track in List<Track>.of(tracks)) {
        await repository.add(id!, [track]);
        _mutationTouched = true;
      }
    });
    if (isCurrent) await open(id!);
  }

  Future<void> remove(PlaylistItem item) async {
    final d = _state.detail;
    _requireMutation();
    if (!d!.items.any((e) => e.id == item.id && e.pending == item.pending)) {
      throw ArgumentError('Unknown item');
    }
    await _mutate(
      'Удаление записи',
      () => repository.remove(d.playlist.id, item.id, pending: item.pending),
    );
    if (isCurrent) await open(d.playlist.id);
  }

  Future<void> reorder(List<String> ids) async {
    _requireMutation();
    final before = _state.detail!;
    final reason = before.reorderBlockedReason;
    if (reason != null) {
      throw AppFailure(code: 'playlist_order_unavailable', message: reason);
    }
    final keys = before.items.map((e) => e.id).toSet();
    if (ids.length != keys.length ||
        ids.toSet().length != keys.length ||
        !keys.containsAll(ids)) {
      throw ArgumentError('Order must be exact permutation');
    }
    final byId = {for (final item in before.items) item.id: item};
    _emit(detail: before.withItems(ids.map((id) => byId[id]!)));
    try {
      await _mutate(
        'Сортировка плейлиста',
        () => repository.reorder(before.playlist.id, List.of(ids)),
      );
    } catch (e) {
      if (isCurrent) _emit(detail: before, failure: _state.failure);
      rethrow;
    }
  }

  /// Read-only reconciliation intentionally retains the unresolved intent banner.
  Future<void> reconcile() async {
    if (!isCurrent || _state.busy) return;
    await refreshList();
    if (!isCurrent || _state.failure != null) return;
    if (_id != null && isCurrent) await open(_id!);
    if (isCurrent &&
        _deletingId != null &&
        _state.failure?.statusCode == 404 &&
        !_state.playlists.any((e) => e.id == _deletingId)) {
      _id = null;
      _state = PlaylistState(
        playlists: _state.playlists,
        deleted: true,
        uncertain: true,
        reconciled: true,
        pendingIntent: _state.pendingIntent,
      );
      notifyListeners();
      return;
    }
    if (isCurrent && _state.failure == null) _emit(reconciled: true);
  }

  /// Acknowledgment is explicit after inspecting the read-back, never a retry.
  void acknowledgeReconciliation() {
    if (isCurrent && !_state.busy && !_state.loading && _state.reconciled) {
      _state = PlaylistState(
        playlists: _state.playlists,
        detail: _state.detail,
        deleted: _state.deleted,
      );
      notifyListeners();
    }
  }

  Future<PlaylistSummary> saveQueue(
    PlaylistDraft draft,
    List<Track> tracks,
  ) async {
    final snapshot = List<Track>.unmodifiable(tracks);
    validatePlaylistQueue(snapshot);
    draft.payload;
    return _mutate('Сохранение очереди «${draft.name}»', () async {
      final created = await repository.create(draft);
      _mutationTouched = true;
      _id = created.id;
      _emit(
        busy: true,
        playlists: [created, ..._state.playlists],
        pendingIntent:
            'Очередь: создан плейлист «${created.name}», добавляем ${snapshot.length} записей',
      );
      await repository.add(created.id, snapshot);
      return created;
    }, owner: false);
  }

  @override
  void dispose() {
    _disposed = true;
    _generation++;
    _subscription.cancel();
    super.dispose();
  }
}
