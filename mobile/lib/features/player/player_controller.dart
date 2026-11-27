import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../core/model/app_failure.dart';
import '../../core/model/owner_key.dart';
import '../../core/model/track.dart';
import '../../core/session/session_authority.dart';
import '../../playback/playback_controller.dart';
import '../likes/likes_models.dart';
import '../likes/preference_controller.dart';

typedef PlayerTrackAction = FutureOr<void> Function(PlayerTrackTarget target);
typedef PlayerQueueAction = FutureOr<void> Function(PlayerQueueTarget target);

/// Composition revalidates this captured target after pickers and other awaits.
class PlayerTrackTarget {
  PlayerTrackTarget._(this.fence, this.entry, this._current, this._admit);
  final SessionFence fence;
  final QueueEntry entry;
  Track get track => entry.track;
  final bool Function() _current;
  final Future<void> Function() _admit;
  bool get isCurrent => _current();
  Future<void> assertCurrent() => _admit();
}

class PlayerQueueTarget {
  PlayerQueueTarget._(this.fence, this.snapshot, this._current, this._admit);
  final SessionFence fence;
  final QueueSnapshot snapshot;
  final bool Function() _current;
  final Future<void> Function() _admit;
  bool get isCurrent => _current();
  Future<void> assertCurrent() => _admit();

  /// Actual service order, including duplicates. T15 owns explicit subset review.
  List<Track> get tracks => [
    for (final id in snapshot.effectiveOrder)
      snapshot.entries.firstWhere((entry) => entry.entryId == id).track,
  ];
}

class PlayerCallbacks {
  const PlayerCallbacks({
    this.onLyrics,
    this.onRelated,
    this.onRadio,
    this.onArtist,
    this.onAlbum,
    this.onDownload,
    this.onAddToPlaylist,
    this.onShare,
    this.onSettings,
    this.onSaveQueue,
    this.isDownloaded,
    this.hasFullAudio,
    this.canManageAudio,
    this.onManageAudio,
  });
  final PlayerTrackAction? onLyrics,
      onRelated,
      onRadio,
      onArtist,
      onAlbum,
      onDownload,
      onAddToPlaylist,
      onShare,
      onSettings,
      onManageAudio;
  final PlayerQueueAction? onSaveQueue;
  final Future<bool> Function(PlayerTrackTarget)? isDownloaded;
  final Future<bool> Function(PlayerTrackTarget)? hasFullAudio;
  final Future<bool> Function(PlayerTrackTarget)? canManageAudio;
}

/// UI projection over the single service; owns neither audio nor a queue copy.
class PlayerController extends ChangeNotifier {
  PlayerController({
    required this.playback,
    required this.authority,
    required this.fence,
    required this.preferences,
    this.callbacks = const PlayerCallbacks(),
  }) {
    _playback = playback.snapshots.listen((_) => _changed());
    _session = authority.changes.listen((_) => _changed());
    preferences.addListener(_preferenceChanged);
    _loadPreference();
  }
  final PlaybackController playback;
  final SessionAuthority authority;
  final SessionFence fence;
  final PreferenceController preferences;
  final PlayerCallbacks callbacks;
  late final StreamSubscription<QueueSnapshot> _playback;
  late final StreamSubscription<SessionState> _session;
  bool _disposed = false, _revoked = false, _busy = false;
  AppFailure? _failure;
  String? _loadedPreference;
  double _lastVolume = 1;
  bool get isCurrent => !_disposed && !_revoked && authority.isCurrent(fence);
  QueueSnapshot get snapshot => isCurrent && playback.snapshot.fence == fence
      ? playback.snapshot
      : QueueSnapshot();
  bool get busy => _busy;
  AppFailure? get failure => isCurrent ? _failure : null;
  PreferenceState get preference => snapshot.currentEntry == null
      ? const PreferenceState()
      : preferences.current(snapshot.currentEntry!.track.ref);
  bool get canPrefer =>
      isCurrent &&
      preferences.fence == fence &&
      preferences.canMutate &&
      snapshot.currentEntry != null &&
      preferences.supports(
        snapshot.currentEntry!.track.ref,
        PreferenceSignal.like,
      );
  List<QueueEntry> get orderedEntries {
    final state = snapshot;
    final byId = {for (final e in state.entries) e.entryId: e};
    return [
      for (final id in state.effectiveOrder)
        if (byId[id] != null) byId[id]!,
    ];
  }

  void _changed() {
    if (!authority.isCurrent(fence)) _revoked = true;
    _loadPreference();
    if (!_disposed) notifyListeners();
  }

  void _preferenceChanged() {
    if (!_disposed) notifyListeners();
  }

  void _loadPreference() {
    final ref = snapshot.currentEntry?.track.ref;
    if (ref == null ||
        preferences.fence != fence ||
        _loadedPreference == ref.identityKey) {
      return;
    }
    _loadedPreference = ref.identityKey;
    unawaited(preferences.load(ref).catchError((Object _) {}));
  }

  bool _matches(QueueSnapshot captured, {bool track = true}) {
    final now = snapshot;
    return isCurrent &&
        now.fence == captured.fence &&
        now.lineage == captured.lineage &&
        listEquals(
          now.entries.map((e) => e.entryId).toList(),
          captured.entries.map((e) => e.entryId).toList(),
        ) &&
        listEquals(now.effectiveOrder, captured.effectiveOrder) &&
        now.shuffle == captured.shuffle &&
        (!track ||
            (now.generation == captured.generation &&
                now.currentEntryId == captured.currentEntryId));
  }

  Future<void> _admit(QueueSnapshot captured, {bool track = true}) async {
    await authority.assertCurrent(fence);
    if (!_matches(captured, track: track)) {
      throw const AppFailure(
        code: 'stale_player_action',
        message: 'Музыка изменилась. Выберите действие снова.',
      );
    }
  }

  PlayerTrackTarget? captureTrack() {
    final captured = snapshot;
    final entry = captured.currentEntry;
    if (entry == null) return null;
    return PlayerTrackTarget._(
      fence,
      entry,
      () => _matches(captured),
      () => _admit(captured),
    );
  }

  PlayerQueueTarget? captureQueue() {
    final captured = snapshot;
    if (captured.entries.isEmpty) return null;
    return PlayerQueueTarget._(
      fence,
      captured,
      () => _matches(captured, track: false),
      () => _admit(captured, track: false),
    );
  }

  Future<void> _run(Future<void> Function() action) async {
    if (!isCurrent || _busy) return;
    _busy = true;
    _failure = null;
    notifyListeners();
    try {
      await action();
    } catch (error) {
      if (isCurrent) {
        _failure = error is AppFailure
            ? error
            : const AppFailure(
                code: 'player_action',
                message: 'Не удалось выполнить действие. Попробуйте ещё раз.',
              );
      }
    } finally {
      _busy = false;
      if (!_disposed) notifyListeners();
    }
  }

  Future<void> _command(
    PlaybackCommand command, {
    PlayerQueueTarget? target,
    PlayerTrackTarget? trackTarget,
    bool queue = false,
  }) {
    final captured = snapshot;
    if (captured.currentEntry == null) return Future.value();
    return _run(() async {
      if (trackTarget != null) {
        await trackTarget.assertCurrent();
      } else if (target != null) {
        await target.assertCurrent();
      } else {
        await _admit(captured, track: !queue);
      }
      await playback.dispatch(command);
    });
  }

  Future<void> togglePlayback() =>
      _command(snapshot.playing ? const Pause() : const Resume());
  Future<void> retry() => _command(const Resume());
  Future<void> selectAudioVersion(
    PlayerTrackTarget target, {
    required bool standard,
  }) => _command(
    SetTrackAudioVersion(
      fence: fence,
      entryId: target.entry.entryId,
      generation: snapshot.generation,
      standard: standard,
    ),
    trackTarget: target,
  );
  Future<void> previous() => _command(const Previous());
  Future<void> next() =>
      _command(Next(expectedEntryId: snapshot.currentEntryId, fence: fence));
  Future<void> seek(Duration position, {PlayerTrackTarget? target}) =>
      _command(Seek(position), trackTarget: target);
  Future<void> setVolume(double value, {PlayerTrackTarget? target}) async {
    if (!value.isFinite) return;
    value = value.clamp(0, 1);
    final captured = target ?? captureTrack();
    if (captured == null) return;
    await _run(() async {
      await captured.assertCurrent();
      await playback.dispatch(SetVolume(value));
      if (value > 0) _lastVolume = value;
    });
  }

  Future<void> toggleMute({PlayerTrackTarget? target}) {
    final captured = target ?? captureTrack();
    final volume = snapshot.volume;
    if (captured == null) return Future.value();
    return _run(() async {
      await captured.assertCurrent();
      if (volume > 0) _lastVolume = volume;
      await playback.dispatch(SetVolume(volume > 0 ? 0 : _lastVolume));
    });
  }

  Future<void> toggleShuffle() => _command(SetShuffle(!snapshot.shuffle));
  Future<void> cycleRepeat() => _command(
    SetRepeat(switch (snapshot.repeat) {
      QueueRepeat.off => QueueRepeat.all,
      QueueRepeat.all => QueueRepeat.one,
      QueueRepeat.one => QueueRepeat.off,
    }),
  );
  Future<void> playEntry(String id, {PlayerQueueTarget? target}) =>
      _command(PlayEntry(id), target: target, queue: true);
  Future<void> remove(String id, {PlayerQueueTarget? target}) =>
      _command(Remove(id), target: target, queue: true);
  Future<void> reorder(List<String> ids, {PlayerQueueTarget? target}) =>
      _command(Reorder(ids), target: target, queue: true);
  Future<void> clear({required PlayerQueueTarget target}) =>
      _command(const Clear(), target: target, queue: true);
  Future<void> playNext(String id, {required PlayerQueueTarget target}) async {
    if (target.snapshot.shuffle) return;
    final ids = target.snapshot.entries.map((e) => e.entryId).toList();
    if (!ids.contains(id) || id == target.snapshot.currentEntryId) return;
    ids.remove(id);
    ids.insert(ids.indexOf(target.snapshot.currentEntryId!) + 1, id);
    await _run(() async {
      await target.assertCurrent();
      if (snapshot.currentEntryId != target.snapshot.currentEntryId) {
        throw const AppFailure(
          code: 'stale_player_action',
          message: 'Музыка изменилась. Выберите действие снова.',
        );
      }
      await playback.dispatch(Reorder(ids));
    });
  }

  Future<void> feedback(PreferenceSignal signal, {PlayerTrackTarget? target}) {
    target ??= captureTrack();
    final captured = target;
    if (captured == null || !canPrefer) return Future.value();
    return _run(() async {
      await captured.assertCurrent();
      final current = preferences.current(captured.track.ref).signal;
      await preferences.set(
        captured.track.ref,
        current == signal ? PreferenceSignal.clear : signal,
      );
    });
  }

  Future<void> invoke(PlayerTrackAction action, {PlayerTrackTarget? target}) {
    final captured = target ?? captureTrack();
    if (captured == null) return Future.value();
    return _run(() async {
      await captured.assertCurrent();
      await action(captured);
    });
  }

  Future<bool?> downloaded(PlayerTrackTarget target) async {
    final lookup = callbacks.isDownloaded;
    if (lookup == null) return false;
    bool? result;
    await _run(() async {
      await target.assertCurrent();
      final ready = await lookup(target);
      await target.assertCurrent();
      result = ready;
    });
    return result;
  }

  Future<bool> fullAudioAvailable(PlayerTrackTarget target) async {
    final lookup = callbacks.hasFullAudio;
    if (lookup == null ||
        target.entry.context.offlineMixGeneration != null ||
        target.entry.context.fromDownloads) {
      return false;
    }
    if (snapshot.publishedAudioVersionId != null) return true;
    var available = false;
    await _run(() async {
      await target.assertCurrent();
      available = await lookup(target) && target.isCurrent;
    });
    return available;
  }

  Future<void> saveQueue({PlayerQueueTarget? target}) {
    final captured = target ?? captureQueue();
    final action = callbacks.onSaveQueue;
    if (captured == null || action == null) return Future.value();
    return _run(() async {
      await captured.assertCurrent();
      await action(captured);
    });
  }

  @override
  void dispose() {
    _disposed = true;
    _playback.cancel();
    _session.cancel();
    preferences.removeListener(_preferenceChanged);
    super.dispose();
  }
}
