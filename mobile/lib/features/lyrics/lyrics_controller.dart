import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../core/model/app_failure.dart';
import '../../core/model/owner_key.dart';
import '../../core/model/track.dart';
import '../../core/session/session_authority.dart';
import '../../playback/playback_controller.dart';
import '../library/library_models.dart';
import 'lyrics_repository.dart';

/// Captures one view revision; downstream callbacks revalidate after each await.
class ExtrasActionTarget {
  ExtrasActionTarget._(this.fence, this.tracks, this._current, this._guard);
  final SessionFence fence;
  final List<Track> tracks;
  final bool Function() _current;
  final Future<void> Function() _guard;
  bool get isCurrent => _current();
  Future<void> assertCurrent() => _guard();
}

/// Feature scope only: shares the injected playback service, never reports plays.
abstract class ExtrasController extends ChangeNotifier {
  ExtrasController(this.repository, this.playback) {
    _session = repository.authority.changes.listen((_) {
      if (!repository.isCurrent) {
        cancel();
      }
      changed();
    });
  }
  final ExtrasRepository repository;
  final PlaybackController playback;
  late final StreamSubscription<SessionState> _session;
  bool _disposed = false;
  int revision = 0;
  bool busy = false;
  AppFailure? _failure;
  bool get isCurrent => !_disposed && repository.isCurrent;
  AppFailure? get failure => isCurrent ? _failure : collectionStaleSession;
  bool current(int value) => isCurrent && value == revision;
  void changed() {
    if (!_disposed) notifyListeners();
  }

  void cancel() {
    revision++;
    busy = false;
    _failure = null;
  }

  void reset() {
    cancel();
    changed();
  }

  Future<void> guard(int value) => repository.guard(() => current(value));
  ExtrasActionTarget target(Iterable<Track> tracks) {
    final value = revision;
    return ExtrasActionTarget._(
      repository.fence,
      List.unmodifiable(tracks),
      () => current(value),
      () => guard(value),
    );
  }

  Future<void> work(
    Future<void> Function(int) operation, {
    bool newRevision = false,
  }) async {
    if (!isCurrent || (busy && !newRevision)) return;
    if (newRevision) cancel();
    final value = revision;
    busy = true;
    _failure = null;
    changed();
    try {
      await guard(value);
      await operation(value);
    } catch (e) {
      if (current(value)) _failure = collectionFailure(e);
    } finally {
      if (current(value)) {
        busy = false;
        changed();
      }
    }
  }

  Future<void> playTracks(
    List<Track> tracks,
    int index, {
    PlayContext? context,
  }) async {
    if (index < 0 || index >= tracks.length || !tracks[index].playable) return;
    final selected = tracks[index];
    final lineage = playback.snapshot.lineage;
    final playable = tracks.where((t) => t.playable).toList();
    // Duplicate occurrences retain selection index, independent of track IDs.
    final at = tracks.take(index).where((t) => t.playable).length;
    await work((value) async {
      final entries = _createEntries(
        playable,
        context ??
            PlayContext(
              surface: PlaySurface.library,
              recommendationGenerationId: selected.recommendationGenerationId,
            ),
      );
      await guard(value);
      if (playback.snapshot.lineage != lineage) throw collectionStaleSession;
      await playback.dispatch(
        ReplaceQueue(
          entries,
          fence: repository.fence,
          expectedLineage: lineage,
          initialEntryId: entries[at].entryId,
        ),
      );
    });
  }

  List<QueueEntry> _createEntries(List<Track> tracks, PlayContext context) => [
    for (final entry in playback.createEntries(tracks, context))
      QueueEntry(
        entryId: entry.entryId,
        track: entry.track,
        context: PlayContext(
          surface: context.surface,
          waveMode: context.waveMode,
          recommendationSessionId: context.recommendationSessionId,
          recommendationGenerationId:
              entry.track.recommendationGenerationId ??
              context.recommendationGenerationId,
        ),
      ),
  ];

  Future<void> enqueueTracks(List<Track> tracks, {PlayContext? context}) async {
    final state = playback.snapshot;
    final rows = tracks.where((t) => t.playable).toList();
    if (rows.isEmpty) return;
    await work((value) async {
      final entries = _createEntries(
        rows,
        context ?? const PlayContext(surface: PlaySurface.library),
      );
      await guard(value);
      if (playback.snapshot.lineage != state.lineage ||
          (state.fence != null && state.fence != repository.fence)) {
        throw collectionStaleSession;
      }
      await playback.dispatch(
        Enqueue(
          entries,
          fence: repository.fence,
          expectedLineage: state.lineage,
        ),
      );
    });
  }

  @override
  void dispose() {
    cancel();
    _disposed = true;
    unawaited(_session.cancel());
    repository.dispose();
    super.dispose();
  }
}

class LyricsController extends ExtrasController {
  LyricsController({
    required LyricsRepository repository,
    required PlaybackController playback,
  }) : super(repository, playback) {
    _updates = playback.snapshots.listen((_) => follow());
  }
  late final StreamSubscription<QueueSnapshot> _updates;
  QueueSnapshot? _selection;
  LyricsDocument? _document;
  LyricsDocument? get document => isCurrent ? _document : null;
  Track? get track => isCurrent ? _selection?.currentEntry?.track : null;
  Duration get position =>
      isCurrent ? playback.snapshot.position : Duration.zero;
  int get activeLine {
    final lines = document?.lines ?? [];
    var active = -1;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].position > position) break;
      active = i;
    }
    return active;
  }

  Future<void> follow({bool force = false}) async {
    final state = playback.snapshot;
    if (!force &&
        _selection?.currentEntryId == state.currentEntryId &&
        _selection?.generation == state.generation &&
        _selection?.lineage == state.lineage &&
        _selection?.fence == state.fence) {
      changed();
      return;
    }
    cancel();
    _selection = state;
    _document = null;
    if (!isCurrent ||
        state.fence != repository.fence ||
        state.currentEntry == null) {
      changed();
      return;
    }
    await work((value) async {
      final doc = await (repository as LyricsRepository).get(
        state.currentEntry!.track,
      );
      if (current(value)) _document = doc;
    });
  }

  Future<void> seek(LyricsLine line) async {
    final selected = _selection;
    if (selected == null) return;
    bool matches() {
      final now = playback.snapshot;
      return now.fence == repository.fence &&
          now.currentEntryId == selected.currentEntryId &&
          now.generation == selected.generation &&
          now.lineage == selected.lineage;
    }

    await work((value) async {
      await guard(value);
      if (!matches() ||
          !(document?.lines.any(
                (l) => l.position == line.position && l.text == line.text,
              ) ??
              false)) {
        throw collectionStaleSession;
      }
      final duration = playback.snapshot.duration;
      if (line.position < Duration.zero ||
          (duration != null && line.position > duration)) {
        return;
      }
      await playback.dispatch(Seek(line.position));
    });
  }

  @override
  void dispose() {
    unawaited(_updates.cancel());
    super.dispose();
  }
}
