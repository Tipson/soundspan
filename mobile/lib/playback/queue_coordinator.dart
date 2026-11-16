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
import 'finite_queue_admission_coordinator.dart';
import 'finite_queue_admission_api.dart';
import 'recommendation_queue_policy.dart';

typedef _AdmissionChoice = ({
  String? next,
  bool unavailable,
  bool Function()? permitted,
});

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
  FiniteQueueAdmissionCoordinator? _finiteAdmission;
  StreamSubscription<void>? _finiteChanges;
  int _finiteObservedMutation = 0;
  bool _finiteMutationPending = false;

  /// Mounted owner policy; each settled mutation gets one future-tail check.
  FiniteQueueAdmissionCoordinator? get finiteAdmission => _finiteAdmission;
  set finiteAdmission(FiniteQueueAdmissionCoordinator? policy) {
    if (identical(policy, _finiteAdmission)) return;
    unawaited(_finiteChanges?.cancel());
    _finiteChanges = null;
    _finiteAdmission = policy;
    _finiteObservedMutation = policy?.mutationEpoch ?? 0;
    _finiteMutationPending = (policy?.pendingMutations ?? 0) > 0;
    if (policy == null) return;
    _finiteChanges = policy.changes.listen((_) {
      if (!identical(finiteAdmission, policy) || _disposed) return;
      if (_finiteObservedMutation != policy.mutationEpoch) {
        _finiteObservedMutation = policy.mutationEpoch;
        _finiteMutationPending = true;
      }
      if (!_finiteMutationPending || policy.pendingMutations != 0) return;
      _finiteMutationPending = false;
      unawaited(_readmitFuture(policy));
    });
  }

  static const _admissionUnavailable = AppFailure(
    code: 'recommendation_admission_unavailable',
    message: 'Не удалось проверить следующую рекомендацию. Повторите попытку.',
    retryable: true,
  );
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
  int _advanceRevision = 0;
  final _recommendationExclusions = <String, Set<String>>{};
  final _closedRecommendationScopes = <String>{};
  static const _maxRecommendationExclusions =
      RecommendationQueuePolicy.maxExclusions;
  int _recommendationIntentSequence = 0;
  final _recommendationIntents = <String, int>{};
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
  Timer? _playStartTimer;
  int _playStartAttempt = 0;
  Duration _playStartPosition = Duration.zero;
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
    focusSuspended: _focusSuspended,
    audible: _audible,
    shuffle: _shuffle,
    repeat: _repeat,
    volume: _volume,
    failure: _failure,
    generation: _generation,
    lineage: _queueEpoch,
    recommendationExclusions: _recommendationExclusions,
    closedRecommendationScopes: _closedRecommendationScopes,
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

  bool _ownsLineage(SessionFence fence, int lineage) =>
      !_disposed &&
      authority.isCurrent(fence) &&
      _queueEpoch == lineage &&
      (_fence == fence || (_fence == null && _entries.isEmpty));

  bool _matchesLineage(
    SessionFence fence,
    int lineage, {
    bool allowPendingManual = false,
  }) =>
      _ownsLineage(fence, lineage) &&
      (allowPendingManual ||
          _pendingManualReplacementIntent != _replacementIntent);

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
    if ((command is ReplaceQueue &&
            command.automaticRecommendation &&
            command.expectedLineage == null) ||
        (command is Enqueue &&
            command.automaticRecommendation &&
            command.expectedLineage == null)) {
      throw ArgumentError('Automatic recommendations need a captured lineage');
    }
    if (command is ReplaceQueue &&
        command.expectedLineage != null &&
        !_matchesLineage(
          command.fence,
          command.expectedLineage!,
          allowPendingManual: !command.automaticRecommendation,
        )) {
      return;
    }
    if (command is Enqueue &&
        command.expectedLineage != null &&
        !_matchesLineage(
          command.fence,
          command.expectedLineage!,
          allowPendingManual: !command.automaticRecommendation,
        )) {
      return;
    }
    int? recommendationIntent;
    if (command is SetRecommendationExclusion) {
      if ((command.advanceEntryId == null) !=
              (command.advanceGeneration == null) ||
          (!command.exclude && command.advanceEntryId != null)) {
        throw ArgumentError(
          'A guarded negative advance needs its original run',
        );
      }
      if (!_matchesLineage(command.fence, command.expectedLineage) ||
          _currentRecommendationScope != command.recommendationScope) {
        return;
      }
      // Reserve before admission: a later clear/negative invalidates a command
      // even while its authoritative owner check is still in flight.
      recommendationIntent = ++_recommendationIntentSequence;
      _recommendationIntents[command.ref.identityKey] = recommendationIntent;
    }
    int? replacementIntent;
    Stopwatch? replacementClock;
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
      if (!command.automaticRecommendation) {
        finiteAdmission?.invalidateQueue(orderChanged: true);
        _pendingManualReplacementIntent = replacementIntent;
      }
      replacementClock = Stopwatch()..start();
    }
    if (command is Enqueue &&
        !command.automaticRecommendation &&
        authority.isCurrent(command.fence)) {
      finiteAdmission?.invalidateQueue(orderChanged: true);
      _naturalContinuation = null;
    }
    if (command is PlayEntry ||
        command is Previous ||
        command is Seek ||
        command is Remove ||
        command is Reorder ||
        command is SetShuffle ||
        command is SetRepeat ||
        command is Pause ||
        command is Resume ||
        command is RestoreQueue) {
      finiteAdmission?.invalidateQueue(
        orderChanged:
            command is Remove ||
            command is Reorder ||
            command is SetShuffle ||
            command is RestoreQueue,
      );
      ++_advanceRevision;
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
        final restoredScopes = _entries
            .map((entry) => entry.context.recommendationScopeKey)
            .whereType<String>()
            .toSet();
        _recommendationExclusions.removeWhere(
          (scope, _) => !restoredScopes.contains(scope),
        );
        _closedRecommendationScopes.retainAll(restoredScopes);
        var exclusionCount = _recommendationExclusions.values.fold(
          0,
          (sum, refs) => sum + refs.length,
        );
        for (final entry in restored.recommendationExclusions.entries) {
          if (!restoredScopes.contains(entry.key)) continue;
          final refs = _recommendationExclusions.putIfAbsent(
            entry.key,
            () => <String>{},
          );
          for (final ref in entry.value) {
            if (refs.contains(ref)) continue;
            if (exclusionCount >= _maxRecommendationExclusions) {
              _closedRecommendationScopes.add(entry.key);
              break;
            }
            refs.add(ref);
            exclusionCount++;
          }
        }
        _closedRecommendationScopes.addAll(
          restored.closedRecommendationScopes.intersection(restoredScopes),
        );
        _pruneExcludedFuture();
        _publish(PlaybackEventKind.transition, oldEntry);
        final stopped = engine.stop();
        await oldResource?.revoke();
        await stopped;
      case ReplaceQueue():
        final fence = command.fence;
        try {
          final budget = prepareTimeout < const Duration(seconds: 10)
              ? prepareTimeout
              : const Duration(seconds: 10);
          if (!command.automaticRecommendation || finiteAdmission == null) {
            await authority.assertCurrent(fence).timeout(budget);
          }
        } catch (error) {
          if (error is TimeoutException) {
            // This intent has finished admission. Its own manual marker must
            // not make a still-current fenced timeout look superseded.
            if (_pendingManualReplacementIntent == replacementIntent) {
              _pendingManualReplacementIntent = null;
            }
            if (_disposed ||
                _replacementIntent != replacementIntent ||
                !authority.isCurrent(fence) ||
                (command.expectedLineage != null &&
                    !_matchesLineage(
                      fence,
                      command.expectedLineage!,
                      allowPendingManual: !command.automaticRecommendation,
                    ))) {
              return;
            }
            throw const AppFailure(
              code: 'playback_admission_timeout',
              message: 'Не удалось начать воспроизведение. Повторите попытку',
              retryable: true,
            );
          }
          if (command.automaticRecommendation) return;
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
                !_matchesLineage(
                  fence,
                  command.expectedLineage!,
                  allowPendingManual: !command.automaticRecommendation,
                ))) {
          return;
        }
        if (command.entries.isEmpty) {
          if (!command.automaticRecommendation) await _clear();
          return;
        }
        final admission = snapshot;
        final incoming = !command.automaticRecommendation
            ? command.entries
            : command.entries
                  .where(
                    (entry) => admission.allowsRecommendation(
                      entry.track.ref,
                      entry.context,
                    ),
                  )
                  .toList();
        if (incoming.isEmpty) return;
        String? automaticInitial;
        bool Function()? replacementPermit;
        if (command.automaticRecommendation && finiteAdmission != null) {
          final candidates = List<QueueEntry>.of(incoming);
          if (_shuffle && !command.orderedRecommendation) {
            candidates.shuffle(_random);
          }
          final choice = await _admitAutomatic(
            admission,
            candidates,
            emptyQueueFence: fence,
          );
          if (_disposed ||
              _replacementIntent != replacementIntent ||
              !authority.isCurrent(fence) ||
              !_matchesLineage(fence, command.expectedLineage!)) {
            return;
          }
          if (choice.unavailable || choice.next == null) {
            _failure = _admissionUnavailable;
            _publish();
            return;
          }
          automaticInitial = choice.next;
          replacementPermit = choice.permitted;
        }
        if (!command.automaticRecommendation) {
          _recommendationExclusions.clear();
          _closedRecommendationScopes.clear();
        } else {
          final scopes = incoming
              .map((entry) => entry.context.recommendationScopeKey)
              .whereType<String>()
              .toSet();
          _recommendationExclusions.removeWhere(
            (scope, _) => !scopes.contains(scope),
          );
          _closedRecommendationScopes.retainAll(scopes);
        }
        ++_queueEpoch;
        ++_queueBoundary;
        if (command.orderedRecommendation) _shuffle = false;
        _entries = List.of(incoming);
        _fence = fence;
        _order = _entries.map((e) => e.entryId).toList();
        if (_shuffle) _order.shuffle(_random);
        _intent = command.play;
        _intentRevision++;
        final initial = command.initialEntryId;
        await _select(
          automaticInitial ??
              (initial != null &&
                      _entries.any((entry) => entry.entryId == initial)
                  ? initial
                  : _entries.first.entryId),
          preparationClock: replacementClock,
          admissionCurrent: replacementPermit == null
              ? null
              : () =>
                    replacementPermit!() &&
                    _replacementIntent == replacementIntent,
        );
      case Enqueue():
        final boundary = _queueBoundary;
        final captured = snapshot;
        final selection =
            command.automaticRecommendation &&
                (_entries.isEmpty || _acceptsContinuation(command.fence))
            ? ++_advanceRevision
            : null;
        final replacement = _replacementIntent;
        _AdmissionChoice? choice;
        Set<String>? admittedFuture;
        try {
          if (command.automaticRecommendation &&
              selection == null &&
              finiteAdmission != null) {
            admittedFuture = await _admitIncomingFuture(
              captured,
              command.entries,
            );
            if (admittedFuture == null) return;
          } else if (selection != null && finiteAdmission != null) {
            choice = await _admitAutomatic(
              captured,
              command.entries
                  .where(
                    (entry) => captured.allowsRecommendation(
                      entry.track.ref,
                      entry.context,
                    ),
                  )
                  .toList(),
              emptyQueueFence: command.fence,
            );
          } else {
            final check = authority.assertCurrent(command.fence);
            await (command.automaticRecommendation
                ? check.timeout(const Duration(seconds: 17))
                : check);
          }
        } catch (_) {
          if (command.automaticRecommendation) return;
          rethrow;
        }
        if (_disposed ||
            (selection != null &&
                (selection != _advanceRevision ||
                    replacement != _replacementIntent)) ||
            _queueBoundary != boundary ||
            !authority.isCurrent(command.fence) ||
            (command.expectedLineage != null &&
                !_matchesLineage(
                  command.fence,
                  command.expectedLineage!,
                  allowPendingManual: !command.automaticRecommendation,
                ))) {
          return;
        }
        if (choice != null && (choice.unavailable || choice.next == null)) {
          _failure = _admissionUnavailable;
          _publish();
          return;
        }
        // An active append's metadata grant cannot become a source-selection
        // grant if natural completion acquired the queue while it was pending.
        if (admittedFuture != null && _acceptsContinuation(command.fence)) {
          return;
        }
        if (_fence != null && _fence != command.fence) {
          throw const AppFailure(
            code: 'session_revoked',
            message: 'Сессия завершена',
          );
        }
        _validate([..._entries, ...command.entries]);
        final admission = snapshot;
        final incoming = !command.automaticRecommendation
            ? command.entries
            : command.entries
                  .where(
                    (entry) =>
                        admission.allowsRecommendation(
                          entry.track.ref,
                          entry.context,
                        ) &&
                        (admittedFuture == null ||
                            admittedFuture.contains(entry.entryId)),
                  )
                  .toList();
        if (incoming.isEmpty) return;
        if (choice?.next != null &&
            !incoming.any((entry) => entry.entryId == choice!.next)) {
          return;
        }
        if (!command.automaticRecommendation) {
          _recommendationExclusions.clear();
          _closedRecommendationScopes.clear();
        }
        if (_entries.isEmpty) {
          if (!command.automaticRecommendation) ++_queueEpoch;
          _entries = List.of(incoming);
          _fence = command.fence;
          _order = _entries.map((e) => e.entryId).toList();
          if (_shuffle) _order.shuffle(_random);
          _intent = false;
          _intentRevision++;
          await _select(
            choice?.next ?? _entries.first.entryId,
            admissionCurrent: choice?.permitted == null
                ? null
                : () =>
                      choice!.permitted!() &&
                      selection == _advanceRevision &&
                      replacement == _replacementIntent,
          );
          return;
        }
        if (!command.automaticRecommendation) ++_queueEpoch;
        _entries.addAll(incoming);
        final ids = incoming.map((e) => e.entryId).toList();
        if (_shuffle && !command.orderedRecommendation) ids.shuffle(_random);
        _order.addAll(ids);
        final continuation = _naturalContinuation;
        if (command.automaticRecommendation &&
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
          await _select(
            choice?.next ?? ids.first,
            admissionCurrent: choice?.permitted == null
                ? null
                : () =>
                      choice!.permitted!() &&
                      selection == _advanceRevision &&
                      replacement == _replacementIntent,
          );
        } else {
          _publish();
        }
      case SetRecommendationExclusion():
        try {
          try {
            await authority.assertCurrent(command.fence);
          } catch (_) {
            return;
          }
          bool latest() =>
              _recommendationIntents[command.ref.identityKey] ==
                  recommendationIntent &&
              _matchesLineage(command.fence, command.expectedLineage) &&
              _currentRecommendationScope == command.recommendationScope;
          if (!latest()) return;
          final current = snapshot.currentEntry;
          final scope = current?.context.recommendationScopeKey;
          final index = _order.indexOf(_current ?? '');
          if (scope == null || index < 0) return;
          if (!command.exclude) {
            _recommendationExclusions[scope]?.remove(command.ref.identityKey);
            _publish();
            return;
          }
          final total = _recommendationExclusions.values.fold(
            0,
            (sum, refs) => sum + refs.length,
          );
          if (total >= _maxRecommendationExclusions &&
              !(_recommendationExclusions[scope]?.contains(
                    command.ref.identityKey,
                  ) ??
                  false)) {
            _closedRecommendationScopes.add(scope);
          } else {
            _recommendationExclusions
                .putIfAbsent(scope, () => <String>{})
                .add(command.ref.identityKey);
          }
          final future = _order.skip(index + 1).toSet();
          final removed = _entries
              .where(
                (entry) =>
                    future.contains(entry.entryId) &&
                    entry.track.ref == command.ref &&
                    entry.context.recommendationScopeKey == scope,
              )
              .map((entry) => entry.entryId)
              .toSet();
          _entries.removeWhere((entry) => removed.contains(entry.entryId));
          _order.removeWhere(removed.contains);
          _publish();
          if (latest() &&
              command.advanceEntryId != null &&
              _current == command.advanceEntryId &&
              _generation == command.advanceGeneration) {
            ++_replacementIntent;
            _naturalContinuation = null;
            // Selection starts synchronously; provider preparation remains
            // service-owned and must not delay preference ACK/clear delivery.
            final advancing = _advance(completion: false);
            final generation = _generation;
            unawaited(
              advancing.catchError((Object error) {
                if (_valid(generation, command.fence)) {
                  _fail(failure: error is AppFailure ? error : null);
                }
              }),
            );
          }
        } finally {
          if (_recommendationIntents[command.ref.identityKey] ==
              recommendationIntent) {
            _recommendationIntents.remove(command.ref.identityKey);
          }
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
        if (_playStartTimer != null) _playStartPosition = target;
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
          if (_current != command.expectedEntryId || _fence != command.fence) {
            return;
          }
        }
        _naturalContinuation = null;
        await _advance(
          completion: false,
          requireOwnerAdmission: command.fence != null,
        );
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
        _cancelPlayStartWatchdog();
        _naturalContinuation = null;
        _intent = false;
        _audible = false;
        _intentRevision++;
        _publish();
        await engine.pause();
      case Resume():
        if (_current == null) return;
        _naturalContinuation = null;
        // An explicit Play may reclaim focus after a permanent loss, which has
        // no matching end callback. Late callbacks cannot replay this revision.
        _focusSuspended = false;
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

  String? get _currentRecommendationScope => _entries
      .where((entry) => entry.entryId == _current)
      .firstOrNull
      ?.context
      .recommendationScopeKey;

  bool _acceptsContinuation(SessionFence fence) {
    final continuation = _naturalContinuation;
    return continuation != null &&
        _valid(continuation.generation, continuation.fence) &&
        continuation.fence == fence &&
        continuation.lineage == _queueEpoch &&
        continuation.revision == _intentRevision &&
        continuation.entryId == _current &&
        _processing == PlaybackProcessing.completed &&
        !_intent;
  }

  Future<void> _readmitFuture(FiniteQueueAdmissionCoordinator policy) async {
    final captured = snapshot;
    final scope = captured.currentEntry?.context.recommendationScopeKey;
    final fence = captured.fence;
    if (scope == null ||
        fence == null ||
        !_matchesLineage(fence, captured.lineage)) {
      return;
    }
    final current = captured.effectiveOrder.indexOf(
      captured.currentEntryId ?? '',
    );
    if (current < 0) return;
    final future = captured.effectiveOrder.skip(current + 1).toSet();
    final refs = <FiniteQueueAdmissionReference>[];
    final referenced = <String>[];
    for (final entry in captured.entries) {
      if (!future.contains(entry.entryId) ||
          entry.context.recommendationScopeKey != scope) {
        continue;
      }
      final ref = FiniteQueueAdmissionReference.fromTrack(
        entry.track.ref,
        generationId: entry.context.recommendationGenerationId,
      );
      if (ref != null) {
        refs.add(ref);
        referenced.add(entry.entryId);
      }
    }
    if (refs.isEmpty) return;
    final result = await policy.admit(
      captured: captured,
      references: refs,
      futureTail: true,
    );
    if (!identical(finiteAdmission, policy) ||
        !result.isCurrent ||
        result.mode != FiniteQueueAdmissionMode.authoritative ||
        !_matchesLineage(fence, captured.lineage) ||
        _currentRecommendationScope != scope) {
      return;
    }
    final denied = <String>{
      for (var i = 0; i < referenced.length; i++)
        if (result.stateAt(i) == FiniteQueueAdmissionState.denied)
          referenced[i],
    };
    if (_pruneExcludedFuture(denied: denied)) _publish();
  }

  Future<Set<String>?> _admitIncomingFuture(
    QueueSnapshot captured,
    List<QueueEntry> entries,
  ) async {
    final policy = finiteAdmission!;
    final refs = <FiniteQueueAdmissionReference>[];
    final referenced = <String>[];
    final allowed = <String>{};
    for (final entry in entries) {
      if (!captured.allowsRecommendation(entry.track.ref, entry.context)) {
        continue;
      }
      if (entry.context.recommendationScopeKey == null) {
        allowed.add(entry.entryId);
        continue;
      }
      final ref = FiniteQueueAdmissionReference.fromTrack(
        entry.track.ref,
        generationId: entry.context.recommendationGenerationId,
      );
      if (ref != null) {
        refs.add(ref);
        referenced.add(entry.entryId);
      }
    }
    if (refs.isEmpty) {
      await authority
          .assertCurrent(captured.fence!)
          .timeout(const Duration(seconds: 17));
      return allowed;
    }
    final result = await policy.admit(
      captured: captured,
      references: refs,
      futureTail: true,
    );
    if (!identical(finiteAdmission, policy) ||
        !result.isCurrent ||
        _currentRecommendationScope !=
            captured.currentEntry?.context.recommendationScopeKey ||
        result.mode == FiniteQueueAdmissionMode.unavailable) {
      return null;
    }
    for (var i = 0; i < referenced.length; i++) {
      if (result.mode == FiniteQueueAdmissionMode.legacyExact ||
          result.stateAt(i) == FiniteQueueAdmissionState.allowed) {
        allowed.add(referenced[i]);
      }
    }
    return allowed;
  }

  bool _pruneExcludedFuture({Set<String> denied = const {}}) {
    final index = _order.indexOf(_current ?? '');
    if (index < 0) return false;
    final admission = snapshot;
    final future = _order.skip(index + 1).toSet();
    final removed = _entries
        .where(
          (entry) =>
              future.contains(entry.entryId) &&
              (denied.contains(entry.entryId) ||
                  !admission.allowsRecommendation(
                    entry.track.ref,
                    entry.context,
                  )),
        )
        .map((entry) => entry.entryId)
        .toSet();
    _entries.removeWhere((entry) => removed.contains(entry.entryId));
    _order.removeWhere(removed.contains);
    return removed.isNotEmpty;
  }

  Future<void> _select(
    String id, {
    Duration initialPosition = Duration.zero,
    Stopwatch? preparationClock,
    bool Function()? admissionCurrent,
  }) async {
    if (admissionCurrent?.call() == false) return;
    _cancelPlayStartWatchdog();
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
    PreparedAudio? resource;
    var handedToQueue = false;
    var abandoned = false;
    preparationClock ??= Stopwatch()..start();
    Future<T> withinDeadline<T>(Future<T> Function() operation) {
      final remaining = prepareTimeout - preparationClock!.elapsed;
      if (remaining <= Duration.zero) {
        throw TimeoutException('Media preparation timed out');
      }
      return operation().timeout(remaining);
    }

    try {
      final stop = engine.stop();
      await withinDeadline(() async => previousResource?.revoke());
      await withinDeadline(() => stop);
      if (!_valid(generation, fence)) return;
      if (admissionCurrent?.call() == false) throw _admissionUnavailable;
      final entry = _entries.firstWhere((e) => e.entryId == id);
      if (!entry.track.playable) {
        throw const AppFailure(
          code: 'recording_unavailable',
          message: 'Запись недоступна',
        );
      }
      final prepared = await withinDeadline(
        () => prepare(entry, fence).then((value) {
          if (abandoned) unawaited(value.revoke());
          return value;
        }),
      );
      resource = prepared;
      if (!_valid(generation, fence)) {
        await resource.revoke();
        return;
      }
      if (admissionCurrent?.call() == false) throw _admissionUnavailable;
      _resource = resource;
      handedToQueue = true;
      await withinDeadline(() => authority.assertCurrent(fence));
      if (!_valid(generation, fence)) {
        // A replacement/Clear already released the source owned by the queue.
        return;
      }
      if (admissionCurrent?.call() == false) throw _admissionUnavailable;
      await withinDeadline(() => engine.load(prepared.uri, generation));
      if (!_valid(generation, fence)) return;
      if (admissionCurrent?.call() == false) throw _admissionUnavailable;
      await withinDeadline(() => engine.setVolume(_volume));
      if (!_valid(generation, fence)) return;
      int? appliedRevision;
      do {
        final revision = _seekRevision;
        final target = _requestedPosition;
        if (target > Duration.zero || appliedRevision != null) {
          await withinDeadline(() => engine.seek(target));
        }
        if (!_valid(generation, fence)) return;
        appliedRevision = revision;
      } while (appliedRevision != _seekRevision);
      _position = _requestedPosition;
      _preparingGeneration = null;
      _processing = PlaybackProcessing.ready;
      _publish();
      if (_intent) {
        if (admissionCurrent?.call() == false) throw _admissionUnavailable;
        await withinDeadline(
          () => _play(
            generation,
            fence,
            budget: prepareTimeout - preparationClock!.elapsed,
            admissionCurrent: admissionCurrent,
          ),
        );
      }
    } catch (error) {
      abandoned = true;
      if (!_valid(generation, fence)) {
        if (!handedToQueue) await resource?.revoke();
        return;
      }
      await resource?.revoke();
      if (!_valid(generation, fence)) return;
      _resource = null;
      if (error is AppFailure && error.code == 'session_revoked') {
        await _clear();
      } else {
        _fail(
          failure: error is TimeoutException
              ? const AppFailure(
                  code: 'playback_prepare_timeout',
                  message: 'Не удалось подготовить запись. Повторите попытку',
                  retryable: true,
                )
              : error is AppFailure
              ? error
              : null,
        );
      }
    }
  }

  Future<void> _play(
    int generation,
    SessionFence fence, {
    Duration? budget,
    bool Function()? admissionCurrent,
  }) async {
    if (_focusSuspended) return;
    _cancelPlayStartWatchdog();
    final attempt = _playStartAttempt;
    final revision = _intentRevision;
    final startClock = Stopwatch()..start();
    final available = budget ?? prepareTimeout;
    final startBudget = available < const Duration(seconds: 10)
        ? available
        : const Duration(seconds: 10);
    try {
      await authority.assertCurrent(fence).timeout(startBudget);
      if (!_valid(generation, fence) ||
          attempt != _playStartAttempt ||
          revision != _intentRevision ||
          !_intent ||
          _focusSuspended) {
        return;
      }
    } catch (error) {
      if (_generation != generation ||
          attempt != _playStartAttempt ||
          _fence != fence ||
          _disposed ||
          revision != _intentRevision ||
          !_intent ||
          _focusSuspended) {
        return;
      }
      if (error is AppFailure && error.code == 'session_revoked') {
        await _clear();
      } else {
        _fail(
          failure: error is TimeoutException
              ? const AppFailure(
                  code: 'playback_start_timeout',
                  message: 'Воспроизведение не началось. Повторите попытку',
                  retryable: true,
                )
              : error is AppFailure
              ? error
              : null,
        );
      }
      return;
    }
    if (admissionCurrent?.call() == false) {
      _fail(failure: _admissionUnavailable);
      return;
    }
    _playStartPosition = _position;
    _playStartTimer = Timer(startBudget - startClock.elapsed, () {
      _playStartTimer = null;
      if (!_valid(generation, fence) ||
          attempt != _playStartAttempt ||
          revision != _intentRevision ||
          !_intent ||
          _focusSuspended) {
        return;
      }
      _fail(
        failure: const AppFailure(
          code: 'playback_start_timeout',
          message: 'Воспроизведение не началось. Повторите попытку',
          retryable: true,
        ),
      );
    });
    unawaited(
      engine.play().catchError((Object _) {
        if (_valid(generation, fence) &&
            attempt == _playStartAttempt &&
            revision == _intentRevision &&
            _intent &&
            !_focusSuspended) {
          _fail();
        }
      }),
    );
    if (engine case PlaybackStartConfirmation probe
        when probe.requiresNativeStartConfirmation) {
      unawaited(
        _confirmNativeStart(probe, generation, fence, revision, attempt),
      );
    }
  }

  Future<void> _confirmNativeStart(
    PlaybackStartConfirmation probe,
    int generation,
    SessionFence fence,
    int revision,
    int attempt,
  ) async {
    bool current() =>
        _playStartTimer != null &&
        attempt == _playStartAttempt &&
        _valid(generation, fence) &&
        revision == _intentRevision &&
        _intent &&
        !_focusSuspended;
    while (current()) {
      var confirmed = false;
      try {
        confirmed = await probe.confirmPlaying();
      } catch (_) {
        // The watchdog owns the bounded, retryable failure. No restart loop.
      }
      if (!current()) return;
      if (confirmed) {
        _cancelPlayStartWatchdog(invalidate: false);
        return;
      }
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
  }

  void _cancelPlayStartWatchdog({bool invalidate = true}) {
    if (invalidate) _playStartAttempt++;
    _playStartTimer?.cancel();
    _playStartTimer = null;
  }

  /// Native refusal recovery retains the exact queue and position. Admission
  /// before and after the await prevents a delayed platform observation from
  /// stopping a replacement track, owner, or a later manual Play.
  Future<void> reportPlatformFailure(
    QueueSnapshot expected,
    int revision,
  ) async {
    final fence = expected.fence;
    bool current() =>
        fence != null &&
        _valid(expected.generation, fence) &&
        _queueEpoch == expected.lineage &&
        _current == expected.currentEntryId &&
        _intentRevision == revision &&
        snapshot.playing;
    if (!current()) return;
    try {
      await authority.assertCurrent(fence!);
    } catch (_) {
      return;
    }
    if (!current()) return;
    _intentRevision++;
    _focusSuspended = false;
    _fail(
      failure: const AppFailure(
        code: 'background_playback_unavailable',
        message: 'Android не разрешил фоновое воспроизведение. Откройте приложение и нажмите «Продолжить».',
        retryable: true,
      ),
    );
  }

  void _fail({AppFailure? failure}) {
    _cancelPlayStartWatchdog();
    _naturalContinuation = null;
    _preparingGeneration = null;
    ++_generation;
    final resource = _resource;
    _resource = null;
    unawaited(engine.stop());
    if (resource != null) unawaited(resource.revoke());
    _failure =
        failure ??
        const AppFailure(
          code: 'playback_failed',
          message: 'Не удалось воспроизвести запись',
          retryable: true,
        );
    _processing = PlaybackProcessing.failed;
    _audible = false;
    _intent = false;
    _publish(PlaybackEventKind.failure);
  }

  Future<_AdmissionChoice> _admitAutomatic(
    QueueSnapshot captured,
    List<QueueEntry> candidates, {
    SessionFence? emptyQueueFence,
    bool requireOwnerAdmission = false,
  }) async {
    final policy = finiteAdmission;
    if (policy == null) {
      return (
        next: candidates.firstOrNull?.entryId,
        unavailable: false,
        permitted: null,
      );
    }
    final automatic = candidates
        .takeWhile((entry) => entry.context.recommendationScopeKey != null)
        .toList();
    final manual = candidates.skip(automatic.length).firstOrNull?.entryId;
    if (automatic.isEmpty && !requireOwnerAdmission) {
      return (next: manual, unavailable: false, permitted: null);
    }
    final refs = <FiniteQueueAdmissionReference>[];
    final referenced = <String>[];
    for (final entry in automatic) {
      final ref = FiniteQueueAdmissionReference.fromTrack(
        entry.track.ref,
        generationId: entry.context.recommendationGenerationId,
      );
      if (ref != null) {
        refs.add(ref);
        referenced.add(entry.entryId);
      }
    }
    final result = await policy.admit(
      captured: captured,
      references: refs,
      emptyQueueFence: emptyQueueFence,
    );
    if (!result.isCurrent) {
      return (next: null, unavailable: true, permitted: null);
    }
    final epoch = policy.mutationEpoch, queue = policy.queueEpoch;
    bool permitted() =>
        identical(finiteAdmission, policy) &&
        policy.isMutationCurrent(epoch) &&
        policy.queueEpoch == queue;
    if (automatic.isEmpty) {
      return (
        next: manual,
        unavailable: result.mode == FiniteQueueAdmissionMode.unavailable,
        permitted: permitted,
      );
    }
    if (result.mode == FiniteQueueAdmissionMode.unavailable) {
      return (
        next: manual,
        unavailable: manual == null,
        permitted: requireOwnerAdmission ? permitted : null,
      );
    }
    String? next;
    if (result.mode == FiniteQueueAdmissionMode.legacyExact) {
      next = automatic.firstOrNull?.entryId;
    } else {
      for (var i = 0; i < referenced.length; i++) {
        if (result.stateAt(i) == FiniteQueueAdmissionState.allowed) {
          next = referenced[i];
          break;
        }
      }
    }
    if (next == null) {
      final unavailable =
          refs.isEmpty ||
          List.generate(
            refs.length,
            result.stateAt,
          ).contains(FiniteQueueAdmissionState.unavailable);
      return (
        next: manual,
        unavailable: manual == null && unavailable,
        permitted: requireOwnerAdmission ? permitted : null,
      );
    }
    return (next: next, unavailable: false, permitted: permitted);
  }

  Future<void> _advance({
    required bool completion,
    bool requireOwnerAdmission = false,
  }) async {
    if (_current == null) return;
    // Both native completion and Next reserve before their first await.
    final operation = ++_advanceRevision;
    final replacement = ++_replacementIntent;
    final index = _order.indexOf(_current!);
    final admission = snapshot;
    final intentRevision = _intentRevision;
    bool current() =>
        operation == _advanceRevision &&
        replacement == _replacementIntent &&
        admission.fence != null &&
        _valid(admission.generation, admission.fence!) &&
        _queueEpoch == admission.lineage &&
        _intentRevision == intentRevision &&
        _current == admission.currentEntryId;
    // With a finite coordinator this check is inside its sole deadline below,
    // including owner-only manual successors (an empty recording batch).
    if (requireOwnerAdmission && finiteAdmission == null) {
      try {
        await authority
            .assertCurrent(admission.fence!)
            .timeout(const Duration(seconds: 17));
      } catch (_) {
        if (current()) {
          _failure = _admissionUnavailable;
          _publish();
        }
        return;
      }
      if (!current()) return;
    }
    final byId = {for (final entry in _entries) entry.entryId: entry};
    bool allowed(String id) {
      final entry = byId[id];
      return entry != null &&
          admission.allowsRecommendation(entry.track.ref, entry.context);
    }

    final candidates =
        completion && _repeat == QueueRepeat.one && allowed(_current!)
        ? [_current!]
        : [
            ..._order.skip(index + 1).where(allowed),
            if (_repeat == QueueRepeat.all)
              ..._order.take(index + 1).where(allowed),
          ];
    final _AdmissionChoice choice = finiteAdmission == null
        ? (next: candidates.firstOrNull, unavailable: false, permitted: null)
        : await _admitAutomatic(
            admission,
            candidates.map((id) => byId[id]!).toList(),
            requireOwnerAdmission: requireOwnerAdmission,
          );
    if (!current()) return;
    if (choice.unavailable) {
      _failure = _admissionUnavailable;
      _publish();
      return;
    }
    final next = choice.next;
    if (next != null) {
      await _select(
        next,
        admissionCurrent: choice.permitted == null
            ? null
            : () =>
                  choice.permitted!() &&
                  operation == _advanceRevision &&
                  replacement == _replacementIntent,
      );
      return;
    }
    if (finiteAdmission != null && !completion && candidates.isNotEmpty) {
      _failure = const AppFailure(
        code: 'recommendation_tail_blocked',
        message: 'В очереди нет доступной следующей рекомендации.',
        retryable: true,
      );
      _publish();
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
      _cancelPlayStartWatchdog();
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
    final nativeConfirmation =
        engine is PlaybackStartConfirmation &&
        (engine as PlaybackStartConfirmation).requiresNativeStartConfirmation;
    // UI position is extrapolated. Android acknowledges the exact native source.
    if (!nativeConfirmation &&
        _audible &&
        event.position >
            _playStartPosition + const Duration(milliseconds: 150)) {
      _cancelPlayStartWatchdog(invalidate: false);
    }
    _publish(
      buffering ? PlaybackEventKind.buffering : PlaybackEventKind.position,
    );
  }

  /// Focus pauses preserve user intent; resume needs the exact saved revision.
  Future<void> suspendForFocus({bool resumeOnGain = true}) async {
    _cancelPlayStartWatchdog();
    _focusSuspended = resumeOnGain;
    if (!resumeOnGain) {
      _intent = false;
      _intentRevision++;
    }
    _audible = false;
    _publish();
    await engine.pause();
  }

  Future<void> resumeAfterFocus(
    int generation,
    int revision, {
    bool allowResume = true,
  }) async {
    if (!_focusSuspended) return;
    _focusSuspended = false;
    final fence = _fence;
    if (allowResume &&
        fence != null &&
        _valid(generation, fence) &&
        revision == _intentRevision &&
        _intent) {
      await _play(generation, fence);
    } else {
      _intent = false;
      _intentRevision++;
      _publish();
    }
  }

  Future<void> _clear() async {
    finiteAdmission?.invalidateQueue(orderChanged: true);
    ++_advanceRevision;
    _cancelPlayStartWatchdog();
    _focusSuspended = false;
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
    _recommendationExclusions.clear();
    _closedRecommendationScopes.clear();
    _recommendationIntents.clear();
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
    await _finiteChanges?.cancel();
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
