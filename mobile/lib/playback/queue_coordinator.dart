import 'dart:async';
import 'dart:math';
import 'dart:convert';

import '../core/model/app_failure.dart';
import '../core/model/owner_key.dart';
import '../core/model/track.dart';
import '../core/session/session_authority.dart';
import 'playback_controller.dart';
import 'playback_engine.dart';
import 'native_loudness_controller.dart';

/// One service-owned occurrence queue; widgets only send commands.
final class QueueCoordinator implements PlaybackController {
  QueueCoordinator({
    required this.authority,
    required this.engine,
    required this.prepare,
    this.prepareTimeout = const Duration(seconds: 30),
    Duration Function()? elapsed,
    Random? random,
  }) : _elapsed = elapsed ?? (Stopwatch()..start()).elapsedDuration,
       _random = random ?? Random.secure() {
    _engineSubscription = engine.events.listen(_onEngine);
    _sessionSubscription = authority.changes.listen((_) {
      if (_fence != null && !authority.isCurrent(_fence!)) unawaited(_clear());
    });
  }
  final SessionAuthority authority;
  final PlaybackEngine engine;
  final PrepareAudio prepare;
  final Duration prepareTimeout;
  final Duration Function() _elapsed;
  final Random _random;
  // Async delivery lets reporters/persistence issue commands from callbacks.
  // State mutation and logout stop/revoke still begin synchronously.
  final _snapshots = StreamController<QueueSnapshot>.broadcast();
  final _events = StreamController<PlaybackEvent>.broadcast();
  late final StreamSubscription<EngineEvent> _engineSubscription;
  late final StreamSubscription<SessionState> _sessionSubscription;
  List<QueueEntry> _entries = [];
  List<String> _order = [];
  String? _current;
  SessionFence? _fence;
  PreparedAudio? _resource;
  Duration _position = Duration.zero;
  Duration? _duration;
  Duration _buffer = Duration.zero;
  PlaybackProcessing _processing = PlaybackProcessing.idle;
  bool _intent = false, _audible = false, _shuffle = false, _disposed = false;
  QueueRepeat _repeat = QueueRepeat.off;
  double _volume = 1;
  AppFailure? _failure;
  int _generation = 0;
  int _replacementIntent = 0;
  int? _pendingManualReplacementIntent;
  int _queueEpoch = 0;
  int _queueBoundary = 0;
  int _intentRevision = 0;
  // Runtime-only permission from a natural Wave end; never restored/persisted.
  ({
    SessionFence fence,
    int lineage,
    int generation,
    int revision,
    String entryId,
  })?
  _naturalContinuation;
  // Seek commands target this run's requested position until its source loads.
  int? _preparingGeneration;
  Duration _requestedPosition = Duration.zero;
  int _seekRevision = 0;
  bool _focusSuspended = false;
  int get intentRevision => _intentRevision;
  @override
  QueueSnapshot get snapshot => QueueSnapshot(
    entries: _entries,
    effectiveOrder: _order,
    currentEntryId: _current,
    fence: _fence,
    position: _position,
    duration: _duration,
    bufferedPosition: _buffer,
    processing: _processing,
    playingIntent: _intent,
    audible: _audible,
    shuffle: _shuffle,
    repeat: _repeat,
    volume: _volume,
    failure: _failure,
    generation: _generation,
    lineage: _queueEpoch,
  );
  @override
  Stream<QueueSnapshot> get snapshots => _snapshots.stream;
  @override
  Stream<PlaybackEvent> get events => _events.stream;
  @override
  List<QueueEntry> createEntries(Iterable<Track> tracks, PlayContext context) =>
      List.unmodifiable(
        tracks.map(
          (track) => QueueEntry(
            entryId: base64Url.encode(
              List.generate(24, (_) => _random.nextInt(256)),
            ),
            track: track,
            context: context,
          ),
        ),
      );

  void _publish([
    PlaybackEventKind kind = PlaybackEventKind.state,
    String? previous,
  ]) {
    if (_disposed) return;
    final state = snapshot;
    if (engine case LoudnessPlaybackEngine gainEngine) {
      gainEngine.updateLoudnessContext(state);
    }
    _snapshots.add(state);
    _events.add(
      PlaybackEvent(
        kind: kind,
        snapshot: state,
        elapsed: _elapsed(),
        previousEntryId: previous,
      ),
    );
  }

  void _validate(Iterable<QueueEntry> entries) {
    final ids = entries.map((e) => e.entryId).toList();
    if (ids.any((id) => id.isEmpty) || ids.toSet().length != ids.length) {
      throw ArgumentError('Queue entry IDs must be unique');
    }
  }

  bool _valid(int generation, SessionFence fence) =>
      !_disposed &&
      _generation == generation &&
      _fence == fence &&
      authority.isCurrent(fence);

  bool _matchesLineage(SessionFence fence, int lineage) =>
      !_disposed &&
      authority.isCurrent(fence) &&
      _queueEpoch == lineage &&
      (_fence == fence || (_fence == null && _entries.isEmpty)) &&
      _pendingManualReplacementIntent != _replacementIntent;

  /// Releases only this exact local decoder source, retaining paused metadata.
  /// The caller must block new preparations of this file until deletion finishes.
  /// False means a concurrent intent/preparation won; the caller must not delete.
  Future<bool> releaseLocalFile(
    Uri file, {
    required SessionFence fence,
    required String? expectedEntryId,
    required int expectedGeneration,
    required int expectedLineage,
  }) async {
    if (file.scheme != 'file' || file.hasQuery || file.hasFragment) {
      throw ArgumentError('Expected a private local file');
    }
    bool matches() =>
        !_disposed &&
        authority.isCurrent(fence) &&
        _current == expectedEntryId &&
        _generation == expectedGeneration &&
        _queueEpoch == expectedLineage &&
        _pendingManualReplacementIntent != _replacementIntent &&
        (_fence == fence || _fence == null);
    if (!matches()) return false;
    final selection = _replacementIntent;
    final intent = _intentRevision;
    final seek = _seekRevision;
    try {
      await authority.assertCurrent(fence);
    } catch (_) {
      return false;
    }
    if (!matches() ||
        selection != _replacementIntent ||
        intent != _intentRevision ||
        seek != _seekRevision) {
      return false;
    }
    // A pending prepare may have read the ready file before deletion admission.
    if (_preparingGeneration != null) return false;
    final resource = _resource;
    if (resource == null || resource.uri != file) return true;
    _resource = null;
    ++_generation;
    ++_replacementIntent;
    ++_intentRevision;
    _naturalContinuation = null;
    _intent = false;
    _audible = false;
    _processing = PlaybackProcessing.idle;
    _buffer = Duration.zero;
    _publish();
    await Future.wait<void>([engine.stop(), resource.revoke()]);
    return _resource?.uri != file && _preparingGeneration == null;
  }

  void _validateRestored(QueueSnapshot state, SessionFence fence) {
    _validate(state.entries);
    final ids = state.entries.map((entry) => entry.entryId).toSet();
    if (state.fence != fence ||
        state.effectiveOrder.length != ids.length ||
        state.effectiveOrder.toSet().length != ids.length ||
        !ids.containsAll(state.effectiveOrder) ||
        (ids.isEmpty
            ? state.currentEntryId != null
            : !ids.contains(state.currentEntryId)) ||
        state.position < Duration.zero ||
        (state.duration != null && state.duration! < Duration.zero) ||
        !state.volume.isFinite ||
        state.volume < 0 ||
        state.volume > 1) {
      throw ArgumentError('Invalid restored queue metadata');
    }
  }

  @override
  Future<void> dispatch(PlaybackCommand command) async {
    if (_disposed) throw StateError('Playback disposed');
    if (command is ReplaceQueue &&
        command.expectedLineage != null &&
        !_matchesLineage(command.fence, command.expectedLineage!)) {
      return;
    }
    if (command is Enqueue &&
        command.expectedLineage != null &&
        !_matchesLineage(command.fence, command.expectedLineage!)) {
      return;
    }
    int? replacementIntent;
    if (command is RestoreQueue) {
      if (!_matchesLineage(command.fence, command.expectedLineage)) return;
      _validateRestored(command.snapshot, command.fence);
      replacementIntent = ++_replacementIntent;
      _naturalContinuation = null;
    }
    if (command is ReplaceQueue) {
      // A cached negative result may reject an obsolete owner immediately, but
      // only the broker can admit a positive result. Reject before reserving
      // the intent so old-owner responses cannot cancel a valid pending one.
      if (!authority.isCurrent(command.fence)) {
        throw const AppFailure(
          code: 'session_revoked',
          message: 'Сессия завершена',
        );
      }
      _validate(command.entries);
      if (command.initialEntryId != null &&
          !command.entries.any((e) => e.entryId == command.initialEntryId)) {
        throw ArgumentError('Unknown initial occurrence');
      }
      replacementIntent = ++_replacementIntent;
      _naturalContinuation = null;
      if (command.expectedLineage == null) {
        _pendingManualReplacementIntent = replacementIntent;
      }
    }
    if (command is Enqueue &&
        command.expectedLineage == null &&
        authority.isCurrent(command.fence)) {
      _naturalContinuation = null;
    }
    if (command is Clear) {
      await _clear();
      return;
    }
    if (command is! ReplaceQueue &&
        command is! RestoreQueue &&
        _fence != null &&
        !authority.isCurrent(_fence!)) {
      await _clear();
    }
    switch (command) {
      case RestoreQueue():
        try {
          await authority.assertCurrent(command.fence);
        } catch (_) {
          return;
        }
        if (_replacementIntent != replacementIntent ||
            !_matchesLineage(command.fence, command.expectedLineage)) {
          return;
        }
        if (command.snapshot.entries.isEmpty) {
          await _clear();
          return;
        }
        final restored = command.snapshot;
        final oldEntry = _current;
        final oldResource = _resource;
        _resource = null;
        ++_generation;
        ++_queueEpoch;
        ++_queueBoundary;
        ++_intentRevision;
        _preparingGeneration = null;
        _entries = List.of(restored.entries);
        _order = List.of(restored.effectiveOrder);
        _current = restored.currentEntryId;
        _fence = command.fence;
        _position = restored.position;
        _duration = restored.duration;
        _buffer = Duration.zero;
        _shuffle = restored.shuffle;
        _repeat = restored.repeat;
        _volume = restored.volume;
        _processing = PlaybackProcessing.idle;
        _intent = false;
        _audible = false;
        _failure = null;
        _publish(PlaybackEventKind.transition, oldEntry);
        final stopped = engine.stop();
        await oldResource?.revoke();
        await stopped;
      case ReplaceQueue():
        final fence = command.fence;
        try {
          await authority.assertCurrent(fence);
        } catch (_) {
          if (command.expectedLineage != null) return;
          rethrow;
        } finally {
          if (_pendingManualReplacementIntent == replacementIntent) {
            _pendingManualReplacementIntent = null;
          }
        }
        if (_disposed ||
            _replacementIntent != replacementIntent ||
            !authority.isCurrent(fence) ||
            (command.expectedLineage != null &&
                !_matchesLineage(fence, command.expectedLineage!))) {
          return;
        }
        if (command.entries.isEmpty) {
          await _clear();
          return;
        }
        ++_queueEpoch;
        ++_queueBoundary;
        _entries = List.of(command.entries);
        _fence = fence;
        _order = _entries.map((e) => e.entryId).toList();
        if (_shuffle) _order.shuffle(_random);
        _intent = command.play;
        _intentRevision++;
        await _select(command.initialEntryId ?? _entries.first.entryId);
      case Enqueue():
        final boundary = _queueBoundary;
        try {
          await authority.assertCurrent(command.fence);
        } catch (_) {
          if (command.expectedLineage != null) return;
          rethrow;
        }
        if (_disposed ||
            _queueBoundary != boundary ||
            !authority.isCurrent(command.fence) ||
            (command.expectedLineage != null &&
                !_matchesLineage(command.fence, command.expectedLineage!))) {
          return;
        }
        if (_fence != null && _fence != command.fence) {
          throw const AppFailure(
            code: 'session_revoked',
            message: 'Сессия завершена',
          );
        }
        if (_entries.isEmpty) {
          if (command.entries.isEmpty) return;
          _validate(command.entries);
          if (command.expectedLineage == null) ++_queueEpoch;
          _entries = List.of(command.entries);
          _fence = command.fence;
          _order = _entries.map((e) => e.entryId).toList();
          if (_shuffle) _order.shuffle(_random);
          _intent = false;
          _intentRevision++;
          await _select(_entries.first.entryId);
          return;
        }
        _validate([..._entries, ...command.entries]);
        if (command.entries.isEmpty) return;
        if (command.expectedLineage == null) ++_queueEpoch;
        _entries.addAll(command.entries);
        final ids = command.entries.map((e) => e.entryId).toList();
        if (_shuffle) ids.shuffle(_random);
        _order.addAll(ids);
        final continuation = _naturalContinuation;
        if (command.expectedLineage != null &&
            continuation != null &&
            _valid(continuation.generation, continuation.fence) &&
            continuation.fence == command.fence &&
            continuation.lineage == _queueEpoch &&
            continuation.revision == _intentRevision &&
            continuation.entryId == _current &&
            _processing == PlaybackProcessing.completed &&
            !_intent) {
          _naturalContinuation = null;
          _intent = true;
          _intentRevision++;
          await _select(ids.first);
        } else {
          _publish();
        }
      case PlayEntry():
        if (!_entries.any((e) => e.entryId == command.entryId)) {
          throw ArgumentError('Unknown occurrence');
        }
        ++_replacementIntent;
        _naturalContinuation = null;
        _intent = true;
        _intentRevision++;
        await _select(command.entryId);
      case Seek():
        if (_current == null) return;
        ++_replacementIntent;
        _naturalContinuation = null;
        final target = command.position < Duration.zero
            ? Duration.zero
            : (_duration != null && command.position > _duration!
                  ? _duration!
                  : command.position);
        _position = target;
        _requestedPosition = target;
        _seekRevision++;
        _publish(PlaybackEventKind.seek);
        if (_preparingGeneration == _generation) return;
        await engine.seek(target);
      case Next():
        if ((command.expectedEntryId == null) != (command.fence == null)) {
          throw ArgumentError(
            'Guarded Next requires entry ID and session fence',
          );
        }
        if (command.fence != null) {
          final beforeAdmission = _generation;
          if (_current != command.expectedEntryId || _fence != command.fence) {
            return;
          }
          final selectionIntent = ++_replacementIntent;
          _naturalContinuation = null;
          try {
            await authority.assertCurrent(command.fence!);
          } catch (_) {
            return;
          }
          if (!_valid(beforeAdmission, command.fence!) ||
              _current != command.expectedEntryId ||
              _replacementIntent != selectionIntent) {
            return;
          }
        } else {
          ++_replacementIntent;
          _naturalContinuation = null;
        }
        await _advance(completion: false);
      case Previous():
        ++_replacementIntent;
        _naturalContinuation = null;
        if (_position >= const Duration(seconds: 3)) {
          await dispatch(const Seek(Duration.zero));
          return;
        }
        final index = _order.indexOf(_current ?? '');
        if (index > 0) {
          await _select(_order[index - 1]);
        } else {
          await dispatch(const Seek(Duration.zero));
        }
      case Remove():
        final index = _order.indexOf(command.entryId);
        if (index < 0) return;
        _naturalContinuation = null;
        ++_queueEpoch;
        _entries.removeWhere((e) => e.entryId == command.entryId);
        _order.removeAt(index);
        if (_order.isEmpty) {
          await _clear();
          return;
        }
        if (_current == command.entryId) {
          ++_replacementIntent;
          await _select(_order[min(index, _order.length - 1)]);
        } else {
          _publish();
        }
      case Reorder():
        if (command.entryIds.length != _entries.length ||
            command.entryIds.toSet().length != _entries.length ||
            !command.entryIds.toSet().containsAll(
              _entries.map((e) => e.entryId),
            )) {
          throw ArgumentError('Reorder must contain each occurrence once');
        }
        final items = {for (final e in _entries) e.entryId: e};
        _naturalContinuation = null;
        ++_queueEpoch;
        _entries = command.entryIds.map((id) => items[id]!).toList();
        if (!_shuffle) _order = List.of(command.entryIds);
        _publish();
      case SetShuffle():
        _shuffle = command.enabled;
        _order = _entries.map((e) => e.entryId).toList();
        if (_shuffle) {
          _order.shuffle(_random);
          if (_current != null) {
            _order.remove(_current);
            _order.insert(0, _current!);
          }
        }
        _publish();
      case SetRepeat():
        _repeat = command.repeat;
        _publish();
      case Pause():
        _naturalContinuation = null;
        _intent = false;
        _audible = false;
        _intentRevision++;
        _publish();
        await engine.pause();
      case Resume():
        if (_current == null) return;
        _naturalContinuation = null;
        _intent = true;
        _intentRevision++;
        _publish();
        if (_processing == PlaybackProcessing.completed ||
            _processing == PlaybackProcessing.failed ||
            _processing == PlaybackProcessing.idle) {
          ++_replacementIntent;
          await _select(
            _current!,
            initialPosition:
                _processing == PlaybackProcessing.failed ||
                    _processing == PlaybackProcessing.idle
                ? _position
                : Duration.zero,
          );
        } else if (_processing == PlaybackProcessing.ready ||
            _processing == PlaybackProcessing.buffering) {
          await _play(_generation, _fence!);
        }
      case SetVolume():
        if (!command.volume.isFinite ||
            command.volume < 0 ||
            command.volume > 1) {
          throw ArgumentError('Invalid volume');
        }
        _volume = command.volume;
        _publish();
        await engine.setVolume(_volume);
      case Clear():
        break;
    }
  }

  Future<void> _select(
    String id, {
    Duration initialPosition = Duration.zero,
  }) async {
    final old = _current;
    _current = id;
    final generation = ++_generation;
    _naturalContinuation = null;
    _preparingGeneration = generation;
    _requestedPosition = initialPosition;
    _seekRevision++;
    final fence = _fence!;
    final previousResource = _resource;
    _resource = null;
    _position = initialPosition;
    _duration = null;
    _buffer = Duration.zero;
    _audible = false;
    _failure = null;
    _processing = PlaybackProcessing.loading;
    _publish(PlaybackEventKind.transition, old);
    final stop = engine.stop();
    await previousResource?.revoke();
    await stop;
    if (!_valid(generation, fence)) return;
    PreparedAudio? resource;
    try {
      final entry = _entries.firstWhere((e) => e.entryId == id);
      if (!entry.track.playable) {
        throw const AppFailure(
          code: 'recording_unavailable',
          message: 'Запись недоступна',
        );
      }
      var abandoned = false;
      final preparing = prepare(entry, fence).then((value) {
        if (abandoned) unawaited(value.revoke());
        return value;
      });
      resource = await preparing.timeout(
        prepareTimeout,
        onTimeout: () {
          abandoned = true;
          throw TimeoutException('Media preparation timed out');
        },
      );
      if (!_valid(generation, fence)) {
        await resource.revoke();
        return;
      }
      _resource = resource;
      await authority.assertCurrent(fence);
      if (!_valid(generation, fence)) {
        await resource.revoke();
        return;
      }
      await engine.load(resource.uri, generation);
      if (!_valid(generation, fence)) return;
      await engine.setVolume(_volume);
      if (!_valid(generation, fence)) return;
      int? appliedRevision;
      do {
        final revision = _seekRevision;
        final target = _requestedPosition;
        if (target > Duration.zero || appliedRevision != null) {
          await engine.seek(target);
        }
        if (!_valid(generation, fence)) return;
        appliedRevision = revision;
      } while (appliedRevision != _seekRevision);
      _position = _requestedPosition;
      _preparingGeneration = null;
      _processing = PlaybackProcessing.ready;
      _publish();
      if (_intent) await _play(generation, fence);
    } catch (error) {
      if (!_valid(generation, fence)) {
        await resource?.revoke();
        return;
      }
      await resource?.revoke();
      if (!_valid(generation, fence)) return;
      _resource = null;
      if (error is AppFailure && error.code == 'session_revoked') {
        await _clear();
      } else {
        _fail();
      }
    }
  }

  Future<void> _play(int generation, SessionFence fence) async {
    if (_focusSuspended) return;
    try {
      await authority.assertCurrent(fence);
      if (!_valid(generation, fence) || !_intent || _focusSuspended) return;
    } catch (error) {
      if (_generation != generation || _fence != fence || _disposed) return;
      if (error is AppFailure && error.code == 'session_revoked') {
        await _clear();
      } else {
        _fail();
      }
      return;
    }
    unawaited(
      engine.play().catchError((Object _) {
        if (_valid(generation, fence)) _fail();
      }),
    );
  }

  void _fail() {
    _naturalContinuation = null;
    _preparingGeneration = null;
    ++_generation;
    final resource = _resource;
    _resource = null;
    unawaited(engine.stop());
    if (resource != null) unawaited(resource.revoke());
    _failure = const AppFailure(
      code: 'playback_failed',
      message: 'Не удалось воспроизвести запись',
      retryable: true,
    );
    _processing = PlaybackProcessing.failed;
    _audible = false;
    _intent = false;
    _publish(PlaybackEventKind.failure);
  }

  Future<void> _advance({required bool completion}) async {
    if (_current == null) return;
    final index = _order.indexOf(_current!);
    if (completion && _repeat == QueueRepeat.one) {
      await _select(_current!);
      return;
    }
    if (index + 1 < _order.length) {
      await _select(_order[index + 1]);
      return;
    }
    if (_repeat == QueueRepeat.all) {
      await _select(_order.first);
      return;
    }
    final allowContinuation =
        completion &&
        _intent &&
        snapshot.currentEntry?.context.surface == PlaySurface.wave;
    ++_generation;
    _naturalContinuation = allowContinuation
        ? (
            fence: _fence!,
            lineage: _queueEpoch,
            generation: _generation,
            revision: _intentRevision,
            entryId: _current!,
          )
        : null;
    _intent = false;
    _audible = false;
    _processing = PlaybackProcessing.completed;
    final resource = _resource;
    _resource = null;
    _publish();
    await engine.stop();
    await resource?.revoke();
  }

  void _onEngine(EngineEvent event) {
    final fence = _fence;
    if (fence == null || !_valid(event.generation, fence) || _current == null) {
      return;
    }
    if (event.failed) {
      _fail();
      return;
    }
    if (_preparingGeneration == event.generation) {
      _duration = event.duration ?? _duration;
      _buffer = event.bufferedPosition;
      return;
    }
    if (event.processing == PlaybackProcessing.completed) {
      _position = event.position;
      _duration = event.duration ?? _duration;
      _buffer = event.bufferedPosition;
      _processing = PlaybackProcessing.completed;
      _audible = false;
      _publish(PlaybackEventKind.completed);
      unawaited(_advance(completion: true));
      return;
    }
    final buffering = event.processing == PlaybackProcessing.buffering;
    _position = event.position;
    _duration = event.duration ?? _duration;
    _buffer = event.bufferedPosition;
    _processing = event.processing;
    _audible =
        event.playing &&
        _intent &&
        !_focusSuspended &&
        event.processing == PlaybackProcessing.ready;
    _publish(
      buffering ? PlaybackEventKind.buffering : PlaybackEventKind.position,
    );
  }

  /// Focus pauses preserve user intent; resume needs the exact saved revision.
  Future<void> suspendForFocus() async {
    _focusSuspended = true;
    _audible = false;
    _publish();
    await engine.pause();
  }

  Future<void> resumeAfterFocus(
    int generation,
    int revision, {
    bool allowResume = true,
  }) async {
    _focusSuspended = false;
    final fence = _fence;
    if (allowResume &&
        fence != null &&
        _valid(generation, fence) &&
        revision == _intentRevision &&
        _intent) {
      await _play(generation, fence);
    }
  }

  Future<void> _clear() async {
    _naturalContinuation = null;
    _preparingGeneration = null;
    ++_replacementIntent;
    ++_queueEpoch;
    ++_queueBoundary;
    ++_generation;
    _intentRevision++;
    final resource = _resource;
    _resource = null;
    _entries = [];
    _order = [];
    _current = null;
    _fence = null;
    _position = Duration.zero;
    _duration = null;
    _buffer = Duration.zero;
    _intent = false;
    _audible = false;
    _processing = PlaybackProcessing.idle;
    _failure = null;
    _publish();
    final stop = engine.stop();
    await resource?.revoke();
    await stop;
  }

  @override
  Future<void> dispose() async {
    if (_disposed) return;
    await _clear();
    _disposed = true;
    await _engineSubscription.cancel();
    await _sessionSubscription.cancel();
    await engine.dispose();
    await _snapshots.close();
    await _events.close();
  }
}

extension on Stopwatch {
  Duration elapsedDuration() => elapsed;
}
