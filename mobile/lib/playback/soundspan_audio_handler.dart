import 'dart:async';

import 'package:audio_service/audio_service.dart';

import '../core/session/session_authority.dart';
import 'audio_focus_coordinator.dart';
import 'just_audio_engine.dart';
import 'playback_controller.dart';
import 'playback_engine.dart';
import 'queue_coordinator.dart';

/// Construct exactly once for the process, then attach to AudioService when
/// application owner restoration is ready.
final class SoundspanAudioHandler extends BaseAudioHandler {
  SoundspanAudioHandler({required this.coordinator, this.focus}) {
    _subscription = coordinator.events.listen(
      (event) => _publish(
        event.snapshot,
        elapsed: event.elapsed,
        force: event.kind != PlaybackEventKind.position,
      ),
    );
    _publish(coordinator.snapshot);
  }
  static Future<SoundspanAudioHandler> create({
    required SessionAuthority authority,
    required PrepareAudio prepare,
  }) async {
    final coordinator = QueueCoordinator(
      authority: authority,
      engine: JustAudioEngine(),
      prepare: prepare,
    );
    final focus = AudioFocusCoordinator(coordinator);
    try {
      await focus.attach();
    } catch (_) {
      await focus.dispose();
      await coordinator.dispose();
      rethrow;
    }
    return SoundspanAudioHandler(coordinator: coordinator, focus: focus);
  }

  final QueueCoordinator coordinator;
  final AudioFocusCoordinator? focus;
  late final StreamSubscription<PlaybackEvent> _subscription;
  QueueSnapshot? _lastSystemState;
  Duration _lastSystemElapsed = Duration.zero;
  PlaybackController get controller => coordinator;
  static MediaItem _item(QueueEntry entry, {Duration? duration}) => MediaItem(
    id: entry.entryId,
    title: entry.track.title,
    artist: entry.track.artist,
    album: entry.track.album,
    duration: duration ?? entry.track.duration,
  );
  void _publish(
    QueueSnapshot state, {
    Duration elapsed = Duration.zero,
    bool force = true,
  }) {
    final previous = _lastSystemState;
    final sameQueue =
        previous != null &&
        (!force ||
            (previous.entries.length == state.entries.length &&
                _sameEntries(previous.entries, state.entries)));
    final sameMedia =
        previous != null &&
        previous.currentEntryId == state.currentEntryId &&
        previous.duration == state.duration;
    final sameState =
        previous != null &&
        previous.processing == state.processing &&
        previous.playingIntent == state.playingIntent &&
        previous.focusSuspended == state.focusSuspended &&
        previous.audible == state.audible &&
        previous.repeat == state.repeat &&
        previous.shuffle == state.shuffle &&
        previous.failure == state.failure;
    if (!force &&
        sameQueue &&
        sameMedia &&
        sameState &&
        elapsed - _lastSystemElapsed < const Duration(milliseconds: 500)) {
      return;
    }
    _lastSystemState = state;
    _lastSystemElapsed = elapsed;
    if (!sameQueue) queue.add(state.entries.map(_item).toList(growable: false));
    final current = state.currentEntry;
    if (!sameQueue || !sameMedia) {
      mediaItem.add(
        current == null ? null : _item(current, duration: state.duration),
      );
    }
    playbackState.add(
      PlaybackState(
        controls: [
          MediaControl.skipToPrevious,
          state.playing ? MediaControl.pause : MediaControl.play,
          MediaControl.skipToNext,
          MediaControl.stop,
        ],
        androidCompactActionIndices: const [0, 1, 2],
        systemActions: const {MediaAction.seek},
        processingState: switch (state.processing) {
          PlaybackProcessing.idle => AudioProcessingState.idle,
          PlaybackProcessing.loading => AudioProcessingState.loading,
          PlaybackProcessing.buffering => AudioProcessingState.buffering,
          PlaybackProcessing.ready => AudioProcessingState.ready,
          PlaybackProcessing.completed => AudioProcessingState.completed,
          PlaybackProcessing.failed => AudioProcessingState.error,
        },
        playing: state.playing,
        updatePosition: state.position,
        bufferedPosition: state.bufferedPosition,
        queueIndex: current == null ? null : state.entries.indexOf(current),
        repeatMode: switch (state.repeat) {
          QueueRepeat.off => AudioServiceRepeatMode.none,
          QueueRepeat.one => AudioServiceRepeatMode.one,
          QueueRepeat.all => AudioServiceRepeatMode.all,
        },
        shuffleMode: state.shuffle
            ? AudioServiceShuffleMode.all
            : AudioServiceShuffleMode.none,
        errorCode: state.failure == null ? null : 1,
        errorMessage: state.failure?.message,
      ),
    );
  }

  static bool _sameEntries(
    List<QueueEntry> previous,
    List<QueueEntry> current,
  ) {
    for (var i = 0; i < current.length; i++) {
      if (!identical(previous[i], current[i])) return false;
    }
    return true;
  }

  @override
  Future<void> play() => coordinator.dispatch(const Resume());
  @override
  Future<void> pause() => coordinator.dispatch(const Pause());
  @override
  Future<void> stop() => coordinator.dispatch(const Clear());
  @override
  Future<void> seek(Duration position) => coordinator.dispatch(Seek(position));
  @override
  Future<void> skipToNext() => coordinator.dispatch(const Next());
  @override
  Future<void> skipToPrevious() => coordinator.dispatch(const Previous());
  @override
  Future<void> skipToQueueItem(int index) async {
    final entries = coordinator.snapshot.entries;
    if (index >= 0 && index < entries.length) {
      await coordinator.dispatch(PlayEntry(entries[index].entryId));
    }
  }

  @override
  Future<void> setRepeatMode(AudioServiceRepeatMode repeatMode) =>
      coordinator.dispatch(
        SetRepeat(switch (repeatMode) {
          AudioServiceRepeatMode.one => QueueRepeat.one,
          AudioServiceRepeatMode.all ||
          AudioServiceRepeatMode.group => QueueRepeat.all,
          AudioServiceRepeatMode.none => QueueRepeat.off,
        }),
      );
  @override
  Future<void> setShuffleMode(AudioServiceShuffleMode shuffleMode) =>
      coordinator.dispatch(
        SetShuffle(shuffleMode != AudioServiceShuffleMode.none),
      );
  Future<void> dispose() async {
    await _subscription.cancel();
    await focus?.dispose();
    await coordinator.dispose();
  }
}
