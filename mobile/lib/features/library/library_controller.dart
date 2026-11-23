import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../core/model/app_failure.dart';
import '../../core/session/session_authority.dart';
import 'library_models.dart';
import 'library_repository.dart';

final class LibraryState {
  LibraryState({
    LibraryCollection? collection,
    this.loading = false,
    this.loadingMore = false,
    this.failure,
    this.stale = false,
    Set<String> pending = const {},
  }) : collection = collection ?? LibraryCollection(),
       pending = Set.unmodifiable(pending);
  final LibraryCollection collection;
  final bool loading;
  final bool loadingMore;
  final bool stale;
  final AppFailure? failure;
  final Set<String> pending;
}

final class LibraryController extends ChangeNotifier {
  LibraryController({required this.repository}) {
    _session = repository.authority.changes.listen((_) {
      if (!isCurrent) {
        _generation++;
        _state = LibraryState(stale: true);
        notifyListeners();
      } else {
        notifyListeners();
      }
    });
  }
  final LibraryRepository repository;
  late final StreamSubscription<SessionState> _session;
  LibraryState _state = LibraryState();
  LibraryState get state => isCurrent ? _state : LibraryState(stale: true);
  bool get isCurrent => !_disposed && repository.isCurrent;
  bool get canMutate => isCurrent && repository.canMutate;
  bool _disposed = false;
  int _generation = 0;
  final _pending = <String>{};

  Future<void> refresh() async {
    if (!isCurrent) return;
    final generation = ++_generation;
    final before = _state.collection;
    _state = LibraryState(collection: before, loading: true, pending: _pending);
    notifyListeners();
    try {
      final collection = await repository.load();
      if (!isCurrent || generation != _generation) return;
      _state = LibraryState(
        collection: LibraryCollection(
          saved: collection.savedFailure == null
              ? collection.saved
              : before.saved,
          playlists: collection.playlistsFailure == null
              ? collection.playlists
              : before.playlists,
          totalSaved: collection.savedFailure == null
              ? collection.totalSaved
              : before.totalSaved,
          hasMoreSaved: collection.savedFailure == null
              ? collection.hasMoreSaved
              : before.hasMoreSaved,
          savedFailure: collection.savedFailure,
          playlistsFailure: collection.playlistsFailure,
        ),
        pending: _pending,
      );
    } catch (error) {
      if (!isCurrent || generation != _generation) return;
      _state = LibraryState(
        collection: before,
        failure: collectionFailure(error),
        pending: _pending,
      );
    }
    if (isCurrent) notifyListeners();
  }

  Future<void> retrySaved() => _retrySection(saved: true);
  Future<void> retryPlaylists() => _retrySection(saved: false);

  Future<void> _retrySection({required bool saved}) async {
    if (!isCurrent || _state.loading || _state.loadingMore) return;
    final generation = ++_generation;
    final before = _state.collection;
    _state = LibraryState(collection: before, loading: true, pending: _pending);
    notifyListeners();
    try {
      final page = saved ? await repository.loadSaved() : null;
      final playlists = saved ? null : await repository.loadPlaylists();
      if (!isCurrent || generation != _generation) return;
      _state = LibraryState(
        collection: LibraryCollection(
          saved: page?.items ?? before.saved,
          playlists: playlists ?? before.playlists,
          totalSaved: page?.total ?? before.totalSaved,
          hasMoreSaved: page?.hasMore ?? before.hasMoreSaved,
          savedFailure: saved ? null : before.savedFailure,
          playlistsFailure: saved ? before.playlistsFailure : null,
        ),
        pending: _pending,
      );
    } catch (error) {
      if (!isCurrent || generation != _generation) return;
      _state = LibraryState(
        collection: LibraryCollection(
          saved: before.saved,
          playlists: before.playlists,
          totalSaved: before.totalSaved,
          hasMoreSaved: before.hasMoreSaved,
          savedFailure: saved ? collectionFailure(error) : before.savedFailure,
          playlistsFailure: saved
              ? before.playlistsFailure
              : collectionFailure(error),
        ),
        pending: _pending,
      );
    }
    if (isCurrent) notifyListeners();
  }

  Future<void> loadMore() async {
    final before = _state.collection;
    if (!isCurrent ||
        _state.loading ||
        _state.loadingMore ||
        !before.hasMoreSaved) {
      return;
    }
    final generation = _generation;
    _state = LibraryState(
      collection: before,
      loadingMore: true,
      pending: _pending,
    );
    notifyListeners();
    try {
      final page = await repository.loadSaved(offset: before.saved.length);
      if (!isCurrent || generation != _generation) return;
      _state = LibraryState(
        collection: LibraryCollection(
          saved: [...before.saved, ...page.items],
          playlists: before.playlists,
          totalSaved: page.total,
          hasMoreSaved: page.hasMore,
          playlistsFailure: before.playlistsFailure,
        ),
        pending: _pending,
      );
    } catch (error) {
      if (!isCurrent || generation != _generation) return;
      _state = LibraryState(
        collection: before,
        failure: collectionFailure(error),
        pending: _pending,
      );
    }
    if (isCurrent) notifyListeners();
  }

  Future<void> save(SavedEntityRef entity, bool saved) async {
    if (!isCurrent) throw collectionStaleSession;
    repository.networkPolicy.requireNetwork();
    if (!_pending.add(entity.identityKey)) {
      throw const AppFailure(
        code: 'collection_busy',
        message: 'Предыдущее изменение ещё сохраняется.',
      );
    }
    // A list admitted before this intent cannot publish an old saved state.
    _generation++;
    _state = LibraryState(collection: _state.collection, pending: _pending);
    notifyListeners();
    try {
      await repository.save(entity, saved);
      if (!isCurrent) return;
      final before = _state.collection;
      final existed = before.saved.any(
        (e) => e.identityKey == entity.identityKey,
      );
      _state = LibraryState(
        collection: LibraryCollection(
          saved: [
            if (saved) entity,
            ...before.saved.where((e) => e.identityKey != entity.identityKey),
          ],
          playlists: before.playlists,
          totalSaved:
              before.totalSaved +
              (saved && !existed
                  ? 1
                  : !saved && existed
                  ? -1
                  : 0),
          hasMoreSaved: before.hasMoreSaved,
          savedFailure: before.savedFailure,
          playlistsFailure: before.playlistsFailure,
        ),
      );
    } catch (error) {
      if (isCurrent) {
        _state = LibraryState(
          collection: _state.collection,
          failure: collectionFailure(error),
        );
      }
      rethrow;
    } finally {
      _pending.remove(entity.identityKey);
      if (isCurrent) {
        // Also invalidate list reads admitted while the mutation was pending.
        _generation++;
        _state = LibraryState(
          collection: _state.collection,
          failure: _state.failure,
          pending: _pending,
        );
        notifyListeners();
      }
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _generation++;
    _session.cancel();
    super.dispose();
  }
}
