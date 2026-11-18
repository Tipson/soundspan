import '../../core/model/owner_key.dart';

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../core/model/app_failure.dart';
import '../../core/model/play_context.dart';
import '../../core/session/session_authority.dart';
import '../library/library_models.dart';
import 'catalog_models.dart';
import 'search_repository.dart';

final class SearchState {
  SearchState({
    this.query = '',
    this.kind = SearchKind.all,
    SearchPage? page,
    this.loading = false,
    this.loadingMore = false,
    this.refreshingSaved = false,
    this.retrying = false,
    this.failure,
    this.stale = false,
  }) : page = page ?? SearchPage();
  final String query;
  final SearchKind kind;
  final SearchPage page;
  final bool loading, loadingMore, refreshingSaved, retrying, stale;
  final AppFailure? failure;
}

/// Search revisions include query, category, pagination and clear intents.
final class SearchController extends ChangeNotifier {
  SearchController({required this.repository}) {
    _session = repository.authority.changes.listen((_) {
      if (!isCurrent) {
        _timer?.cancel();
        ++_revision;
        _state = SearchState(stale: true);
        notifyListeners();
      }
    });
  }
  final SearchRepository repository;
  late final StreamSubscription<SessionState> _session;
  SearchState _state = SearchState();
  SearchState get state => isCurrent ? _state : SearchState(stale: true);
  bool _disposed = false;
  int _revision = 0;
  Timer? _timer;
  int get revision => _revision;
  bool get isCurrent => !_disposed && repository.isCurrent;
  SessionFence get fence => repository.fence;
  void changeQuery(String query) {
    _timer?.cancel();
    ++_revision;
    if (!isCurrent) return;
    _state = SearchState(
      query: query,
      kind: _state.kind,
      loading: query.trim().isNotEmpty,
    );
    notifyListeners();
    if (query.trim().isNotEmpty) {
      _timer = Timer(
        const Duration(milliseconds: 300),
        () => unawaited(submit(query)),
      );
    }
  }

  void clear() {
    _timer?.cancel();
    ++_revision;
    if (!isCurrent) return;
    _state = SearchState(kind: _state.kind);
    notifyListeners();
  }

  Future<void> setKind(SearchKind kind) => submit(_state.query, kind: kind);
  Future<void> submit(String query, {SearchKind? kind}) async {
    _timer?.cancel();
    if (!isCurrent) return;
    final revision = ++_revision, selected = kind ?? _state.kind;
    _state = SearchState(
      query: query,
      kind: selected,
      loading: query.trim().isNotEmpty,
    );
    notifyListeners();
    if (query.trim().isEmpty) return;
    try {
      final page = await repository.search(query, selected);
      if (isCurrent && revision == _revision) {
        _state = SearchState(query: query, kind: selected, page: page);
        notifyListeners();
      }
    } catch (e) {
      if (isCurrent && revision == _revision) {
        _state = SearchState(
          query: query,
          kind: selected,
          failure: collectionFailure(e),
        );
        notifyListeners();
      }
    }
  }

  Future<void> loadMore() async {
    if (!isCurrent ||
        _state.loading ||
        _state.loadingMore ||
        _state.retrying ||
        _state.refreshingSaved ||
        !_state.page.hasMore) {
      return;
    }
    final before = _state, revision = _revision;
    _state = SearchState(
      query: before.query,
      kind: before.kind,
      page: before.page,
      loadingMore: true,
    );
    notifyListeners();
    try {
      final page = await repository.search(
        before.query,
        before.kind,
        previous: before.page,
      );
      if (isCurrent && revision == _revision) {
        _state = SearchState(
          query: before.query,
          kind: before.kind,
          page: page,
        );
        notifyListeners();
      }
    } catch (e) {
      if (isCurrent && revision == _revision) {
        _state = SearchState(
          query: before.query,
          kind: before.kind,
          page: before.page,
          failure: collectionFailure(e),
        );
        notifyListeners();
      }
    }
  }

  /// Retry failed sources of this exact query without clearing useful siblings.
  Future<void> retry() async {
    _timer?.cancel();
    if (!isCurrent ||
        _state.loading ||
        _state.loadingMore ||
        _state.refreshingSaved ||
        _state.retrying ||
        _state.query.trim().isEmpty) {
      return;
    }
    final before = _state, revision = ++_revision;
    _state = SearchState(
      query: before.query,
      kind: before.kind,
      page: before.page,
      retrying: true,
    );
    notifyListeners();
    try {
      final page = await repository.retry(
        before.query,
        before.kind,
        before.page,
      );
      if (isCurrent && revision == _revision) {
        _state = SearchState(
          query: before.query,
          kind: before.kind,
          page: page,
        );
        notifyListeners();
      }
    } catch (error) {
      if (isCurrent && revision == _revision) {
        _state = SearchState(
          query: before.query,
          kind: before.kind,
          page: before.page,
          failure: collectionFailure(error),
        );
        notifyListeners();
      }
    }
  }

  /// Detail changes only invalidate saved membership, never the playing queue.
  Future<void> refreshSaved() => _saved();

  /// Retry the failed private page while keeping ordinary results intact.
  Future<void> retrySaved() => _saved(retry: true);

  Future<void> _saved({bool retry = false}) async {
    if (!isCurrent ||
        _state.loading ||
        _state.refreshingSaved ||
        _state.query.trim().isEmpty ||
        _state.kind == SearchKind.tracks) {
      return;
    }
    final before = _state, revision = ++_revision;
    _state = SearchState(
      query: before.query,
      kind: before.kind,
      page: before.page,
      refreshingSaved: true,
    );
    notifyListeners();
    try {
      final page = await (retry
          ? repository.retrySaved
          : repository.refreshSaved)(before.query, before.kind, before.page);
      if (isCurrent && revision == _revision) {
        _state = SearchState(
          query: before.query,
          kind: before.kind,
          page: page,
        );
        notifyListeners();
      }
    } catch (e) {
      if (isCurrent && revision == _revision) {
        _state = SearchState(
          query: before.query,
          kind: before.kind,
          page: before.page,
          failure: collectionFailure(e),
        );
        notifyListeners();
      }
    }
  }

  CollectionPlaybackRequest playbackRequest(int index) {
    if (!isCurrent) throw collectionStaleSession;
    final tracks = _state.page.tracks;
    if (index < 0 || index >= tracks.length || !tracks[index].playable) {
      throw ArgumentError('Unavailable selection');
    }
    return CollectionPlaybackRequest(
      tracks: tracks.where((t) => t.playable),
      startIndex: tracks.take(index).where((t) => t.playable).length,
      fence: fence,
      context: const PlayContext(surface: PlaySurface.search),
    );
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    ++_revision;
    unawaited(_session.cancel());
    repository.dispose();
    super.dispose();
  }
}
