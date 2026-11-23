import '../../core/model/owner_key.dart';

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../core/model/app_failure.dart';
import '../../core/model/play_context.dart';
import '../../core/session/session_authority.dart';
import '../library/library_models.dart';
import 'catalog_models.dart';
import 'catalog_repository.dart';

final class CatalogDetailState {
  const CatalogDetailState({
    this.detail,
    this.loading = false,
    this.loadingMore = false,
    this.failure,
    this.stale = false,
  });
  final CatalogDetail? detail;
  final bool loading, loadingMore, stale;
  final AppFailure? failure;
}

/// Captures entity revision as well as the owner so old sheets cannot retarget.
class CatalogDetailController extends ChangeNotifier {
  CatalogDetailController({
    required this.repository,
    required this.loadDetail,
    this.loadContinuation,
  }) {
    _session = repository.authority.changes.listen((_) {
      if (!isCurrent) {
        ++_revision;
        _state = const CatalogDetailState(stale: true);
        notifyListeners();
      }
    });
  }
  final CatalogRepository repository;
  final Future<CatalogDetail> Function(CatalogEntityRef) loadDetail;
  final Future<CatalogDetail> Function(CatalogDetail)? loadContinuation;
  late final StreamSubscription<SessionState> _session;
  CatalogDetailState _state = const CatalogDetailState();
  CatalogDetailState get state =>
      isCurrent ? _state : const CatalogDetailState(stale: true);
  bool _disposed = false;
  int _revision = 0;
  int get revision => _revision;
  bool get isCurrent => !_disposed && repository.isCurrent;
  SessionFence get fence => repository.fence;
  Future<void> open(CatalogEntityRef ref) async {
    if (!isCurrent) return;
    final revision = ++_revision;
    _state = const CatalogDetailState(loading: true);
    notifyListeners();
    try {
      final detail = await loadDetail(ref);
      if (isCurrent && revision == _revision) {
        _state = CatalogDetailState(detail: detail);
        notifyListeners();
      }
    } catch (e) {
      if (isCurrent && revision == _revision) {
        _state = CatalogDetailState(failure: collectionFailure(e));
        notifyListeners();
      }
    }
  }

  Future<void> loadMore() async {
    final detail = _state.detail, loader = loadContinuation;
    if (!isCurrent ||
        detail == null ||
        !detail.hasMore ||
        loader == null ||
        _state.loadingMore) {
      return;
    }
    final revision = _revision;
    _state = CatalogDetailState(detail: detail, loadingMore: true);
    notifyListeners();
    try {
      final next = await loader(detail);
      if (isCurrent && revision == _revision) {
        _state = CatalogDetailState(detail: next);
        notifyListeners();
      }
    } catch (e) {
      if (isCurrent && revision == _revision) {
        _state = CatalogDetailState(
          detail: detail,
          failure: collectionFailure(e),
        );
        notifyListeners();
      }
    }
  }

  CollectionPlaybackRequest playbackRequest(int index, {bool shuffle = false}) {
    final d = _state.detail;
    if (!isCurrent) throw collectionStaleSession;
    if (d == null ||
        index < 0 ||
        index >= d.tracks.length ||
        !d.tracks[index].playable) {
      throw ArgumentError('Unavailable selection');
    }
    return CollectionPlaybackRequest(
      tracks: d.tracks.where((t) => t.playable),
      startIndex: d.tracks.take(index).where((t) => t.playable).length,
      fence: fence,
      shuffle: shuffle,
      context: PlayContext(
        surface: d.ref.kind == CatalogEntityKind.artist
            ? PlaySurface.artist
            : PlaySurface.album,
      ),
    );
  }

  @override
  void dispose() {
    _disposed = true;
    ++_revision;
    unawaited(_session.cancel());
    repository.dispose();
    super.dispose();
  }
}
