import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../core/model/app_failure.dart';
import '../../core/session/session_authority.dart';
import '../library/library_models.dart';
import 'taste_repository.dart';

class TasteController extends ChangeNotifier {
  TasteController(this.repository) {
    _session = repository.authority.changes.listen((_) => _notify());
  }
  late final StreamSubscription<SessionState> _session;
  final TasteRepository repository;
  TasteProfileState? _state;
  TasteProfileState? get state => isCurrent ? _state : null;
  List<String> _genres = [], _artists = [], _catalog = [], _search = [];
  List<String> get genres => isCurrent ? List.unmodifiable(_genres) : const [];
  List<String> get artists =>
      isCurrent ? List.unmodifiable(_artists) : const [];
  List<String> get catalog =>
      isCurrent ? List.unmodifiable(_catalog) : const [];
  List<String> get searchResults =>
      isCurrent ? List.unmodifiable(_search) : const [];
  String genreFilter = 'all', searchQuery = '';
  int? nextPage = 1;
  int _catalogRevision = 0, _searchRevision = 0;
  bool loading = false,
      saving = false,
      catalogLoading = false,
      searching = false,
      _disposed = false;
  AppFailure? failure, catalogFailure, searchFailure;
  Timer? _debounce;
  bool get isCurrent => !_disposed && repository.isCurrent;
  int get count => genres.length + artists.length;
  double get progress => (count / 5).clamp(0, 1);
  bool get canEdit => isCurrent && !loading && !saving && state != null;
  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> load() async {
    if (!isCurrent || loading || saving) return;
    loading = true;
    failure = null;
    _notify();
    try {
      final next = await repository.load(current: () => isCurrent);
      if (!isCurrent) return;
      _state = next;
      _genres = next.genres.toList();
      _artists = next.artists.toList();
    } catch (e) {
      if (isCurrent) failure = collectionFailure(e);
    } finally {
      loading = false;
      _notify();
    }
    if (isCurrent && state != null && _catalog.isEmpty) await loadCatalog();
  }

  void toggle(String label, {required bool artist}) {
    if (!canEdit) return;
    try {
      final value = normalizeTasteLabels([label]).single;
      final selected = artist ? _artists : _genres;
      final index = selected.indexWhere(
        (s) => s.toLowerCase() == value.toLowerCase(),
      );
      if (index < 0) {
        selected.add(value);
      } else {
        selected.removeAt(index);
      }
      failure = null;
    } catch (e) {
      failure = collectionFailure(e);
    }
    _notify();
  }

  Future<void> filter(String genre) async {
    if (!canEdit || genre == genreFilter) return;
    _catalogRevision++;
    genreFilter = genre;
    nextPage = 1;
    _catalog = [];
    catalogLoading = false;
    await loadCatalog();
  }

  Future<void> loadCatalog() async {
    if (!isCurrent || catalogLoading || nextPage == null) return;
    final revision = _catalogRevision;
    bool current() => isCurrent && revision == _catalogRevision;
    catalogLoading = true;
    catalogFailure = null;
    _notify();
    try {
      final page = await repository.catalog(
        genre: genreFilter,
        page: nextPage!,
        current: current,
      );
      if (current()) {
        _catalog = normalizeTasteLabels([..._catalog, ...page.artists]);
        nextPage = page.nextPage;
      }
    } catch (e) {
      if (current()) catalogFailure = collectionFailure(e);
    } finally {
      if (current()) {
        catalogLoading = false;
        _notify();
      }
    }
  }

  void search(String query) {
    if (!canEdit) return;
    _debounce?.cancel();
    final revision = ++_searchRevision;
    searchQuery = query;
    _search = [];
    searchFailure = null;
    searching = query.trim().length >= 2;
    _notify();
    if (!searching) return;
    _debounce = Timer(const Duration(milliseconds: 250), () async {
      bool current() => isCurrent && revision == _searchRevision;
      try {
        final next = await repository.search(query, current: current);
        if (current()) _search = next;
      } catch (e) {
        if (current()) searchFailure = collectionFailure(e);
      } finally {
        if (current()) {
          searching = false;
          _notify();
        }
      }
    });
  }

  Future<bool> save({bool skip = false}) async {
    if (!canEdit) return false;
    saving = true;
    failure = null;
    _notify();
    final replace = !_state!.needsOnboarding;
    try {
      final next = skip
          ? await repository.skip(replace: replace, current: () => isCurrent)
          : await repository.save(
              genres: _genres,
              artists: _artists,
              replace: replace,
              current: () => isCurrent,
            );
      if (!isCurrent) return false;
      _state = next;
      return true;
    } catch (e) {
      if (isCurrent) failure = collectionFailure(e);
      return false;
    } finally {
      saving = false;
      _notify();
    }
  }

  @override
  void dispose() {
    _disposed = true;
    unawaited(_session.cancel());
    _debounce?.cancel();
    super.dispose();
  }
}
