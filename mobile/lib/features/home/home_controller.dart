import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../core/model/app_failure.dart';
import '../../core/model/play_context.dart';
import '../../core/model/track.dart';
import '../../core/session/session_authority.dart';
import '../library/library_models.dart';
import 'home_models.dart';
import 'home_repository.dart';

final class HomeState {
  HomeState({
    HomeFeed? feed,
    this.loading = false,
    this.failure,
    this.stale = false,
    this.selectedMix,
    this.mixLoading = false,
    this.mixFailure,
    this.saveStatus = MixSaveStatus.idle,
    this.saveReceipt,
    this.saveFailure,
  }) : feed = feed ?? HomeFeed();
  final HomeFeed feed;
  final bool loading, stale, mixLoading;
  final AppFailure? failure, mixFailure, saveFailure;
  final MusicMix? selectedMix;
  final MixSaveStatus saveStatus;
  final MixSaveReceipt? saveReceipt;
}

/// Root recreates this owner scope after logout. A revoked instance never revives.
final class HomeController extends ChangeNotifier {
  HomeController({required this.repository, required this.request}) {
    _session = repository.authority.changes.listen((_) {
      if (!repository.isCurrent) {
        repository.revoke();
        ++_feedRevision;
        ++_mixRevision;
        _state = HomeState(stale: true);
        notifyListeners();
      }
    });
  }
  final HomeRepository repository;
  HomeRequest request;
  late final StreamSubscription<SessionState> _session;
  HomeState _state = HomeState();
  HomeState get state => isCurrent ? _state : HomeState(stale: true);
  bool get isCurrent => !_disposed && repository.isCurrent;
  bool get online => repository.networkPolicy.networkAllowed;
  SessionFence get fence => repository.fence;
  int get selectionRevision => _mixRevision;
  bool _disposed = false;
  int _feedRevision = 0, _mixRevision = 0;
  final _reported = <String, Set<String>>{};
  final _saves =
      <
        String,
        ({MixSaveStatus status, MixSaveReceipt? receipt, AppFailure? failure})
      >{};
  String _saveKey(MusicMix mix) => mix.kind == MusicMixKind.legacy
      ? mix.identity
      : '${mix.identity}:${mix.generationId ?? mix.tracks.map((t) => t.ref.identityKey).join(',')}';
  void _saveResult(
    MusicMix mix,
    MixSaveStatus status, {
    MixSaveReceipt? receipt,
    AppFailure? failure,
  }) {
    if (!isCurrent) return;
    final key = _saveKey(mix);
    _saves[key] = (status: status, receipt: receipt, failure: failure);
    if (_state.selectedMix != null && _saveKey(_state.selectedMix!) == key) {
      _publish(saveStatus: status, saveReceipt: receipt, saveFailure: failure);
    }
  }

  void _publish({
    HomeFeed? feed,
    bool? loading,
    AppFailure? failure,
    MusicMix? selectedMix,
    bool? mixLoading,
    AppFailure? mixFailure,
    MixSaveStatus? saveStatus,
    MixSaveReceipt? saveReceipt,
    AppFailure? saveFailure,
  }) {
    if (!isCurrent) return;
    _state = HomeState(
      feed: feed ?? _state.feed,
      loading: loading ?? _state.loading,
      failure: failure,
      selectedMix: selectedMix ?? _state.selectedMix,
      mixLoading: mixLoading ?? _state.mixLoading,
      mixFailure: mixFailure,
      saveStatus: saveStatus ?? _state.saveStatus,
      saveReceipt: saveReceipt ?? _state.saveReceipt,
      saveFailure: saveStatus == null
          ? saveFailure ?? _state.saveFailure
          : saveFailure,
    );
    notifyListeners();
  }

  Future<void> refresh({HomeRequest? request}) => _refresh(request: request);
  Future<void> retryFailed() => _refresh(
    sections: _state.feed.failures.isEmpty
        ? {'home'}
        : _state.feed.failures.keys.toSet(),
  );
  Future<void> _refresh({HomeRequest? request, Set<String>? sections}) async {
    if (!isCurrent) return;
    if (request != null) this.request = request;
    final revision = ++_feedRevision;
    final before = _state.feed;
    _publish(loading: true);
    try {
      final feed = await repository.load(this.request, sections: sections);
      if (!isCurrent || revision != _feedRevision) return;
      bool preserve(String key) =>
          feed.failures.containsKey(key) ||
          (sections != null && !sections.contains(key));
      final mainFailed = preserve('home');
      final preservedKinds = <MusicMixKind>{
        if (preserve('daily')) MusicMixKind.daily,
        if (preserve('dailyBlend')) MusicMixKind.dailyBlend,
        if (preserve('daypart')) MusicMixKind.daypart,
        if (preserve('weekly')) MusicMixKind.weekly,
        if (preserve('legacy')) MusicMixKind.legacy,
      };
      _publish(
        feed: HomeFeed(
          shelves: mainFailed ? before.shelves : feed.shelves,
          mixes: [
            ...feed.mixes,
            ...before.mixes.where(
              (m) =>
                  preservedKinds.contains(m.kind) &&
                  !feed.mixes.any((n) => n.identity == m.identity),
            ),
          ],
          failures: {
            if (sections != null)
              for (final entry in before.failures.entries)
                if (!sections.contains(entry.key)) entry.key: entry.value,
            ...feed.failures,
          },
          generationId: mainFailed ? before.generationId : feed.generationId,
          reason: mainFailed ? before.reason : feed.reason,
          languagePending: mainFailed
              ? before.languagePending
              : feed.languagePending,
          serverDegraded: mainFailed
              ? before.serverDegraded
              : feed.serverDegraded,
        ),
        loading: false,
      );
    } catch (error) {
      if (isCurrent && revision == _feedRevision) {
        _publish(loading: false, failure: homeFailure(error));
      }
    }
  }

  Future<void> openMix(MusicMix mix) async {
    if (!isCurrent) return;
    final revision = ++_mixRevision;
    final saved = _saves[_saveKey(mix)];
    _state = HomeState(
      feed: _state.feed,
      loading: _state.loading,
      selectedMix: mix,
      mixLoading: !mix.loaded,
      saveStatus: saved?.status ?? MixSaveStatus.idle,
      saveReceipt: saved?.receipt,
      saveFailure: saved?.failure,
    );
    notifyListeners();
    if (mix.loaded) return;
    try {
      final detail = await repository.detail(mix);
      if (isCurrent && revision == _mixRevision) {
        _publish(selectedMix: detail, mixLoading: false);
      }
    } catch (error) {
      if (isCurrent && revision == _mixRevision) {
        _publish(mixLoading: false, mixFailure: homeFailure(error));
      }
    }
  }

  /// Index is a displayed occurrence, never a recording identity lookup.
  CollectionPlaybackRequest playbackRequest(
    MusicMix mix,
    int displayedIndex, {
    bool shuffle = false,
  }) {
    if (!isCurrent) throw homeStale;
    if (displayedIndex < 0 ||
        displayedIndex >= mix.tracks.length ||
        !mix.tracks[displayedIndex].playable) {
      throw const AppFailure(
        code: 'mix_unavailable',
        message: 'Эта запись пока недоступна.',
      );
    }
    final tracks = mix.tracks.where((t) => t.playable).toList();
    final start = mix.tracks
        .take(displayedIndex)
        .where((t) => t.playable)
        .length;
    return CollectionPlaybackRequest(
      tracks: tracks,
      startIndex: start,
      fence: fence,
      shuffle: shuffle,
      context: PlayContext(
        surface: PlaySurface.home,
        recommendationGenerationId: mix.generationId,
      ),
    );
  }

  Future<void> reportVisible(
    HomeShelf shelf,
    List<int> indices, {
    bool Function()? isVisible,
  }) async {
    if (!isCurrent ||
        !online ||
        (isVisible != null && !isVisible()) ||
        !_state.feed.shelves.any((s) => identical(s, shelf)) ||
        shelf.generationId == null) {
      return;
    }
    final revision = _feedRevision;
    final seen = _reported.putIfAbsent(shelf.generationId!, () => {});
    final ordered = indices.toSet().toList()..sort();
    final tracks = <Track>[];
    for (final index in ordered) {
      if (index < 0 || index >= shelf.tracks.length) continue;
      final track = shelf.tracks[index];
      if (track.playable && !seen.contains(track.ref.identityKey)) {
        tracks.add(track);
      }
    }
    if (tracks.isEmpty || revision != _feedRevision || !isCurrent) return;
    try {
      await repository.reportVisible(
        shelf,
        tracks,
        admit: () {
          if (!isCurrent ||
              revision != _feedRevision ||
              (isVisible != null && !isVisible())) {
            return false;
          }
          tracks.removeWhere((t) => seen.contains(t.ref.identityKey));
          if (tracks.isEmpty) return false;
          seen.addAll(tracks.map((t) => t.ref.identityKey));
          return true;
        },
      );
    } catch (_) {
      // Impression loss does not disable listening or retry an ambiguous POST.
    }
    if (_reported.length > 16) _reported.remove(_reported.keys.first);
  }

  Future<void> saveSelected({SaveMusicMix? save}) async {
    final mix = _state.selectedMix;
    if (!isCurrent || mix == null || _state.saveStatus != MixSaveStatus.idle) {
      return;
    }
    if (!online) {
      _publish(
        saveFailure: const AppFailure(
          code: 'offline_mode',
          message: 'Для сохранения нужна сеть.',
        ),
      );
      return;
    }
    if (mix.kind != MusicMixKind.legacy && save == null) return;
    _saveResult(mix, MixSaveStatus.saving);
    try {
      final receipt = save == null
          ? await repository.saveLegacy(mix)
          : await save(mix, fence);
      _saveResult(
        mix,
        receipt == null ? MixSaveStatus.idle : MixSaveStatus.saved,
        receipt: receipt,
      );
    } catch (_) {
      if (isCurrent) {
        _saveResult(
          mix,
          MixSaveStatus.uncertain,
          failure: const AppFailure(
            code: 'mix_save_uncertain',
            message: 'Ответ о сохранении не получен. Проверьте плейлисты перед повторным действием.',
          ),
        );
      }
    }
  }

  /// Readback callback must use GET only and identify the original destination.
  Future<void> reconcileSelected(ReconcileMusicMix reconcile) async {
    final mix = _state.selectedMix;
    if (!isCurrent ||
        !online ||
        mix == null ||
        _state.saveStatus != MixSaveStatus.uncertain) {
      return;
    }
    try {
      final receipt = await reconcile(mix, fence);
      if (!isCurrent) return;
      if (receipt != null) {
        _saveResult(mix, MixSaveStatus.saved, receipt: receipt);
      }
    } catch (error) {
      if (isCurrent) {
        _saveResult(mix, MixSaveStatus.uncertain, failure: homeFailure(error));
      }
    }
  }

  @override
  void dispose() {
    _disposed = true;
    ++_feedRevision;
    ++_mixRevision;
    unawaited(_session.cancel());
    super.dispose();
  }
}
