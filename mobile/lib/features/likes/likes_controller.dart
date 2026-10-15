import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../core/model/owner_key.dart';
import '../../core/model/track.dart';
import '../../core/session/session_authority.dart';
import '../library/library_models.dart';
import 'likes_models.dart';
import 'likes_repository.dart';
import 'preference_controller.dart';

/// Explicit continuation avoids hidden count caps or provider-derived cursors.
final class LikesController extends ChangeNotifier {
  LikesController({required this.repository, this.preferences}) {
    _session = repository.authority.changes.listen((_) {
      if (!repository.isCurrent) {
        _generation++;
        _state = LikesState(stale: true);
        notifyListeners();
      }
    });
  }
  final LikesRepository repository;
  final PreferenceController? preferences;
  late final StreamSubscription<SessionState> _session;
  LikesState _state = LikesState();
  LikesState get state =>
      repository.isCurrent ? _state : LikesState(stale: true);
  SessionFence get fence => repository.fence;
  bool get isCurrent => !_disposed && repository.isCurrent;
  bool _disposed = false;
  int _generation = 0;
  LikedCursor? _cursor;
  final _seenCursors = <LikedCursor>{};
  bool _retryMore = false;
  Future<void> retry() => _retryMore ? loadMore() : refresh();

  Future<void> refresh() async {
    if (!isCurrent) return;
    _retryMore = false;
    final generation = ++_generation;
    final before = _state;
    _state = LikesState(
      tracks: before.tracks,
      total: before.total,
      loading: true,
      hasMore: before.hasMore,
    );
    notifyListeners();
    try {
      final page = await repository.page(null);
      if (!isCurrent || generation != _generation) return;
      _cursor = page.nextCursor;
      _seenCursors.clear();
      if (_cursor != null) _seenCursors.add(_cursor!);
      _seed(page.tracks);
      _state = LikesState(
        tracks: page.tracks,
        total: page.total,
        hasMore: page.hasMore,
      );
    } catch (error) {
      if (!isCurrent || generation != _generation) return;
      _state = LikesState(
        tracks: before.tracks,
        total: before.total,
        hasMore: before.hasMore,
        failure: collectionFailure(error),
      );
    }
    if (isCurrent) notifyListeners();
  }

  Future<void> loadMore() async {
    if (!isCurrent || _state.loading || _state.loadingMore || !_state.hasMore) {
      return;
    }
    final generation = _generation;
    _retryMore = true;
    final before = _state;
    _state = LikesState(
      tracks: before.tracks,
      total: before.total,
      hasMore: true,
      loadingMore: true,
    );
    notifyListeners();
    try {
      final page = await repository.page(_cursor);
      if (!isCurrent || generation != _generation) return;
      if (page.nextCursor != null && !_seenCursors.add(page.nextCursor!)) {
        throw collectionFailure(StateError('cursor loop'));
      }
      _cursor = page.nextCursor;
      _seed(page.tracks);
      final keys = before.tracks.map((t) => t.ref.identityKey).toSet();
      _state = LikesState(
        tracks: [
          ...before.tracks,
          ...page.tracks.where((t) => keys.add(t.ref.identityKey)),
        ],
        total: page.total,
        hasMore: page.hasMore,
      );
    } catch (error) {
      if (!isCurrent || generation != _generation) return;
      _state = LikesState(
        tracks: before.tracks,
        total: before.total,
        hasMore: true,
        failure: collectionFailure(error),
      );
    }
    if (isCurrent) notifyListeners();
  }

  void _seed(Iterable<Track> tracks) {
    for (final track in tracks) {
      preferences?.seed(track.ref, PreferenceSignal.like);
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
