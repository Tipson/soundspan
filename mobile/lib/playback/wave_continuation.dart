import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';

import '../core/model/app_failure.dart';
import '../core/model/owner_key.dart';
import '../core/model/track_ref.dart';
import '../core/session/session_authority.dart';
import '../features/recommendations/recommendation_repository.dart';
import 'playback_controller.dart';
import 'wave_selection.dart';
import 'finite_queue_admission_coordinator.dart';
export 'wave_selection.dart';

enum WaveStatus { detached, loading, active, exhausted, error }

final class WaveState {
  const WaveState({
    this.status = WaveStatus.detached,
    this.selection = const WaveSelection(),
    this.failure,
    this.cursor,
    this.generationId,
  });
  final WaveStatus status;
  final WaveSelection selection;
  final AppFailure? failure;
  final int? cursor;
  final String? generationId;
}

/// Owned by the audio service, never by a widget. No polling or UI timers.
final class WaveContinuation {
  WaveContinuation({
    required this.controller,
    required this.repository,
    required this.authority,
    this.finiteAdmission,
    String Function()? sessionId,
  }) : _newSession = sessionId ?? _randomSession {
    _snapshots = controller.snapshots.listen(_observe);
    _sessions = authority.changes.listen((_) {
      final fence = _fence;
      if (fence != null && !authority.isCurrent(fence)) detach();
    });
  }
  final PlaybackController controller;
  final RecommendationRepository repository;
  final SessionAuthority authority;
  final FiniteQueueAdmissionCoordinator? finiteAdmission;
  final String Function() _newSession;
  late final StreamSubscription<QueueSnapshot> _snapshots;
  late final StreamSubscription<SessionState> _sessions;
  final _states = StreamController<WaveState>.broadcast();
  WaveState _state = const WaveState();
  WaveState get state => _state;
  Stream<WaveState> get states => _states.stream;
  SessionFence? _fence;
  String? _session;
  int _revision = 0;
  int? _lineage;
  int? _inFlight;
  int? _applying;
  Set<String> _pendingReplacementEntries = const {};
  int? _pendingReplacementLineage;
  int _emptyPages = 0;
  bool _disposed = false;
  bool _needsReplacement = false;
  OrderedWavePage? _ordered;
  _OrderedQueueCheckpoint? _orderedCheckpoint;
  TrackRef? _lastWaveRecording;
  ({
    SessionFence fence,
    WaveSelection selection,
    TrackRef recording,
    int lineage,
  })?
  _clearedWave;
  int _sequenceResets = 0;
  bool _forceCapabilities = false;
  void _publish(WaveState value) {
    _state = value;
    if (!_disposed) _states.add(value);
  }

  void _status(
    WaveStatus status, {
    AppFailure? failure,
    int? cursor,
    String? generation,
  }) => _publish(
    WaveState(
      status: status,
      selection: _state.selection,
      failure: failure,
      cursor: cursor ?? _state.cursor,
      generationId: generation ?? _state.generationId,
    ),
  );

  Future<void> start(WaveSelection selection, SessionFence fence) async {
    if (_disposed) throw StateError('Wave continuation disposed');
    if (!authority.isCurrent(fence)) {
      throw const AppFailure(
        code: 'session_revoked',
        message: 'Сессия завершена',
      );
    }
    final cleared = _clearedWave;
    final current = controller.snapshot;
    if (cleared != null &&
        (cleared.fence != fence ||
            cleared.selection != selection ||
            current.entries.isNotEmpty ||
            current.lineage != cleared.lineage)) {
      _clearedWave = null;
    }
    ++_revision;
    _fence = fence;
    _session = _newSession();
    _lineage = controller.snapshot.lineage;
    _emptyPages = 0;
    _needsReplacement = true;
    _ordered = null;
    _orderedCheckpoint = null;
    _sequenceResets = 0;
    _forceCapabilities = false;
    _publish(WaveState(status: WaveStatus.loading, selection: selection));
    await _request(_revision);
  }

  /// Explicit Apply only. A settings-sheet close must not invoke this method.
  /// Existing playback remains untouched until the first newly ranked page is
  /// admitted; explicit Apply then starts its first new occurrence, as on web.
  Future<void> retune(WaveSelection selection) async {
    final fence = _fence;
    if (fence == null || !authority.isCurrent(fence) || _disposed) return;
    if (selection == _state.selection) return;
    final current = controller.snapshot;
    if (current.lineage != _lineage) {
      // ReplaceQueue publishes its admitted queue before awaiting source
      // preparation. A newer explicit Apply may supersede that preparation.
      if (_pendingReplacementEntries.contains(current.currentEntryId) &&
          current.lineage == (_pendingReplacementLineage ?? -2) + 1 &&
          current.fence == fence) {
        _lineage = current.lineage;
      } else {
        detach();
        return;
      }
    }
    ++_revision;
    _emptyPages = 0;
    _needsReplacement = true;
    _ordered = null;
    _orderedCheckpoint = null;
    _sequenceResets = 0;
    _forceCapabilities = false;
    _publish(WaveState(status: WaveStatus.loading, selection: selection));
    await _request(_revision);
  }

  void detach() {
    ++_revision;
    _fence = null;
    _lineage = null;
    _session = null;
    _lastWaveRecording = null;
    _clearedWave = null;
    _ordered = null;
    _orderedCheckpoint = null;
    _forceCapabilities = false;
    _publish(WaveState(selection: _state.selection));
  }

  Future<void> retry() async {
    if (_fence == null || _disposed) return;
    _emptyPages = 0;
    _status(WaveStatus.active);
    await _request(_revision);
  }

  bool _valid(int revision, int lineage, SessionFence fence) =>
      !_disposed &&
      revision == _revision &&
      _fence == fence &&
      authority.isCurrent(fence) &&
      controller.snapshot.lineage == lineage;
  void _observe(QueueSnapshot snapshot) {
    if (_disposed || _fence == null || _applying == _revision) return;
    final current = controller.snapshot;
    if (snapshot.lineage != current.lineage ||
        snapshot.fence != current.fence) {
      return;
    }
    if (snapshot.entries.isEmpty &&
        snapshot.fence == null &&
        snapshot.lineage == (_lineage ?? -2) + 1 &&
        _lastWaveRecording != null &&
        authority.isCurrent(_fence!)) {
      final cleared = (
        fence: _fence!,
        selection: _state.selection,
        recording: _lastWaveRecording!,
        lineage: snapshot.lineage,
      );
      detach();
      _clearedWave = cleared;
      return;
    }
    if (snapshot.fence == _fence &&
        snapshot.lineage == _lineage &&
        snapshot.currentEntry?.context.surface == PlaySurface.wave) {
      _lastWaveRecording = snapshot.currentEntry!.track.ref;
    }
    if (_orderedCheckpoint != null &&
        (current.fence != _fence ||
            (current.lineage != _lineage &&
                !current.entries.any(
                  (entry) => entry.context.surface == PlaySurface.wave,
                )))) {
      detach();
      return;
    }
    if (_orderedCheckpoint != null &&
        !_orderedCheckpoint!.matches(current, finiteAdmission)) {
      _invalidateOrdered();
      return;
    }
    if (snapshot.lineage != _lineage || snapshot.fence != _fence) {
      detach();
      return;
    }
    if (_state.status != WaveStatus.active || _inFlight == _revision) return;
    final index = snapshot.effectiveOrder.indexOf(
      snapshot.currentEntryId ?? '',
    );
    final byId = {for (final e in snapshot.entries) e.entryId: e};
    final remaining = snapshot.effectiveOrder
        .skip(index < 0 ? 0 : index + 1)
        .where((id) => byId[id]?.track.playable == true)
        .length;
    if (remaining <= 2) unawaited(_request(_revision));
  }

  Future<void> _request(int revision) async {
    final fence = _fence;
    final lineage = _lineage;
    final session = _session;
    if (fence == null ||
        lineage == null ||
        session == null ||
        _inFlight == revision ||
        !_valid(revision, lineage, fence)) {
      return;
    }
    _inFlight = revision;
    final selection = _state.selection;
    final cursor = _state.cursor;
    final replace = _needsReplacement;
    final restart = replace ? _clearedWave : null;
    final requestedQueue = _OrderedQueueCheckpoint(
      controller.snapshot,
      finiteAdmission,
    );
    final forceCapabilities = _forceCapabilities;
    _forceCapabilities = false;
    var resetSequence = false;
    try {
      final before = controller.snapshot;
      final excluded = replace
          ? [
              if (before.currentEntry != null)
                before.currentEntry!.track.ref
              else if (restart != null)
                restart.recording,
            ]
          : before.entries.map((e) => e.track.ref).toList();
      final page = await repository.wave(
        selection,
        fence,
        cursor: cursor,
        exclusions: excluded,
        sessionId: session,
        continuation: _ordered,
        forceCapabilityRefresh: forceCapabilities,
      );
      if (!_valid(revision, lineage, fence)) return;
      final current = controller.snapshot;
      if (page.orderedWave != null &&
          (!requestedQueue.matches(current, finiteAdmission) ||
              !requestedQueue.mutationsCurrent(finiteAdmission))) {
        _invalidateOrdered();
        return;
      }
      final context = PlayContext(
        surface: PlaySurface.wave,
        waveMode: selection.mode,
        recommendationGenerationId: page.generationId,
        recommendationSessionId: session,
      );
      final existing = replace
          ? {
              if (current.currentEntry != null)
                current.currentEntry!.track.ref.identityKey,
            }
          : current.entries.map((e) => e.track.ref.identityKey).toSet();
      if (page.orderedWave != null &&
          page.tracks.any(
            (track) =>
                !track.playable ||
                !current.allowsRecommendation(track.ref, context),
          )) {
        throw invalidOrderedWave;
      }
      final tracks = page.orderedWave != null
          ? List.of(page.tracks)
          : page.tracks
                .where(
                  (t) =>
                      t.playable &&
                      current.allowsRecommendation(t.ref, context) &&
                      existing.add(t.ref.identityKey),
                )
                .take(25)
                .toList();
      if (tracks.isEmpty) {
        if (page.temporaryFailure) {
          _status(
            WaveStatus.error,
            failure: const AppFailure(
              code: 'wave_provider_unavailable',
              message: 'Рекомендации временно недоступны',
              retryable: true,
            ),
          );
          return;
        }
        _consumeEmptyPage(page);
        return;
      }
      final entries = controller.createEntries(tracks, context);
      String? initialEntryId;
      if (restart != null) {
        final previous = entries.indexWhere(
          (entry) => entry.track.ref == restart.recording,
        );
        if (previous >= 0 && previous + 1 < entries.length) {
          initialEntryId = entries[previous + 1].entryId;
        } else {
          initialEntryId = entries
              .where((entry) => entry.track.ref != restart.recording)
              .firstOrNull
              ?.entryId;
        }
      }
      _applying = revision;
      if (replace) {
        _pendingReplacementEntries = entries.map((e) => e.entryId).toSet();
        _pendingReplacementLineage = lineage;
        await controller.dispatch(
          ReplaceQueue(
            entries,
            fence: fence,
            expectedLineage: lineage,
            automaticRecommendation: true,
            orderedRecommendation: page.orderedWave != null,
            initialEntryId: initialEntryId,
            preparationCurrent: restart == null
                ? null
                : () =>
                      _valid(revision, lineage, fence) &&
                      requestedQueue.mutationsCurrent(finiteAdmission),
          ),
        );
      } else {
        await controller.dispatch(
          Enqueue(
            entries,
            fence: fence,
            expectedLineage: lineage,
            automaticRecommendation: true,
            orderedRecommendation: page.orderedWave != null,
          ),
        );
      }
      if (revision != _revision || !authority.isCurrent(fence) || _disposed) {
        return;
      }
      final applied = controller.snapshot;
      if (page.orderedWave != null) {
        final ids = entries.map((e) => e.entryId).toList();
        final expected = replace
            ? ids
            : [...requestedQueue.snapshot.effectiveOrder, ...ids];
        if (!requestedQueue.mutationsCurrent(finiteAdmission)) {
          _invalidateOrdered();
          return;
        }
        if (!listEquals(applied.effectiveOrder, expected)) {
          throw invalidOrderedWave;
        }
      }
      final submittedIds = entries.map((e) => e.entryId).toSet();
      final admitted = applied.entries.any(
        (entry) => submittedIds.contains(entry.entryId),
      );
      if (applied.fence != fence || !admitted) {
        if (applied.lineage != lineage) {
          detach();
          return;
        }
        if (applied.fence == fence &&
            entries.every(
              (entry) =>
                  !applied.allowsRecommendation(entry.track.ref, entry.context),
            )) {
          _consumeEmptyPage(page);
          return;
        }
        _status(
          WaveStatus.error,
          failure: const AppFailure(
            code: 'wave_current_changed',
            message: 'Очередь изменилась. Повторите выбор',
            retryable: true,
          ),
        );
        return;
      }
      if (applied.lineage != lineage + (replace ? 1 : 0)) {
        detach();
        return;
      }
      _emptyPages = 0;
      _clearedWave = null;
      _lastWaveRecording = applied.currentEntry?.track.ref;
      _lineage = applied.lineage;
      _needsReplacement = false;
      _ordered = page.orderedWave;
      _orderedCheckpoint = page.orderedWave == null
          ? null
          : _OrderedQueueCheckpoint(applied, finiteAdmission);
      _publish(
        WaveState(
          status: page.orderedWave != null
              ? WaveStatus.active
              : page.nextCursor == null
              ? WaveStatus.exhausted
              : WaveStatus.active,
          selection: selection,
          cursor: page.nextCursor,
          generationId: page.generationId,
        ),
      );
    } catch (error) {
      if (_valid(revision, lineage, fence)) {
        if (error is AppFailure &&
            error.code == 'wave_sequence_reset' &&
            (!requestedQueue.matches(controller.snapshot, finiteAdmission) ||
                !requestedQueue.mutationsCurrent(finiteAdmission))) {
          _invalidateOrdered();
        } else if (error is AppFailure &&
            error.code == 'wave_sequence_reset' &&
            _sequenceResets == 0) {
          _sequenceResets++;
          _ordered = null;
          _orderedCheckpoint = null;
          _session = _newSession();
          _needsReplacement = controller.snapshot.entries.isEmpty;
          _forceCapabilities = true;
          resetSequence = true;
          _publish(WaveState(status: WaveStatus.loading, selection: selection));
        } else {
          _status(
            WaveStatus.error,
            failure: switch (error) {
              AppFailure(statusCode: 504) => const AppFailure(
                code: 'wave_request_timeout',
                message: 'Волна не успела подготовиться. Попробуйте ещё раз',
                retryable: true,
                statusCode: 504,
              ),
              AppFailure() => error,
              _ => const AppFailure(
                code: 'wave_request_failed',
                message: 'Не удалось продолжить Волну',
                retryable: true,
              ),
            },
          );
        }
      }
    } finally {
      if (_inFlight == revision) _inFlight = null;
      if (_applying == revision) _applying = null;
      if (resetSequence && revision == _revision) {
        unawaited(_request(revision));
      } else if (revision == _revision && _state.status == WaveStatus.active) {
        if (_emptyPages > 0) {
          unawaited(_request(revision));
        } else {
          _observe(controller.snapshot);
        }
      }
    }
  }

  void _consumeEmptyPage(RecommendationPage page) {
    if (page.orderedWave != null) {
      _ordered = page.orderedWave;
      _status(WaveStatus.exhausted, generation: page.generationId);
      return;
    }
    _emptyPages++;
    _status(
      _emptyPages >= 2 || page.nextCursor == null
          ? WaveStatus.exhausted
          : WaveStatus.active,
      cursor: page.nextCursor,
      generation: page.generationId,
    );
  }

  void _invalidateOrdered() {
    ++_revision;
    _ordered = null;
    _orderedCheckpoint = null;
    _session = _newSession();
    _lineage = controller.snapshot.lineage;
    _needsReplacement = controller.snapshot.entries.isEmpty;
    _emptyPages = 0;
    _sequenceResets = 0;
    _forceCapabilities = true;
    _publish(
      WaveState(
        status: WaveStatus.active,
        selection: _state.selection,
        generationId: _state.generationId,
      ),
    );
  }

  Future<void> dispose() async {
    if (_disposed) return;
    detach();
    _disposed = true;
    await _snapshots.cancel();
    await _sessions.cancel();
    await _states.close();
  }

  static String _randomSession() {
    final random = Random.secure();
    return List.generate(
      24,
      (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'),
    ).join();
  }
}

/// Existing finite-policy epochs catch manual changes even if the array returns
/// to its old value. Position/current handoffs retain the immutable future order.
final class _OrderedQueueCheckpoint {
  _OrderedQueueCheckpoint(
    this.snapshot,
    FiniteQueueAdmissionCoordinator? policy,
  ) : queueEpoch = policy?.queueEpoch,
      orderEpoch = policy?.orderEpoch,
      mutationEpoch = policy?.mutationEpoch;
  final QueueSnapshot snapshot;
  final int? queueEpoch, orderEpoch, mutationEpoch;
  bool mutationsCurrent(FiniteQueueAdmissionCoordinator? policy) =>
      policy == null ||
      (policy.queueEpoch == queueEpoch &&
          mutationEpoch != null &&
          policy.isMutationCurrent(mutationEpoch!));
  bool matches(QueueSnapshot latest, FiniteQueueAdmissionCoordinator? policy) =>
      (policy == null || policy.orderEpoch == orderEpoch) &&
      latest.fence == snapshot.fence &&
      latest.lineage == snapshot.lineage &&
      latest.shuffle == snapshot.shuffle &&
      listEquals(latest.effectiveOrder, snapshot.effectiveOrder) &&
      setEquals(
        latest.closedRecommendationScopes,
        snapshot.closedRecommendationScopes,
      ) &&
      latest.recommendationExclusions.length ==
          snapshot.recommendationExclusions.length &&
      snapshot.recommendationExclusions.entries.every(
        (item) =>
            setEquals(item.value, latest.recommendationExclusions[item.key]),
      );
}
