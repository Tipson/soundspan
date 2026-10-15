import 'dart:async';
import 'dart:math';

import '../core/model/app_failure.dart';
import '../core/model/owner_key.dart';
import '../core/session/session_authority.dart';
import '../features/recommendations/recommendation_repository.dart';
import 'playback_controller.dart';
import 'wave_selection.dart';
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
  String? _pendingReplacementEntry;
  int? _pendingReplacementLineage;
  int _emptyPages = 0;
  bool _disposed = false;
  bool _needsReplacement = false;
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
    ++_revision;
    _fence = fence;
    _session = _newSession();
    _lineage = controller.snapshot.lineage;
    _emptyPages = 0;
    _needsReplacement = true;
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
      if (current.currentEntryId == _pendingReplacementEntry &&
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
    _publish(WaveState(status: WaveStatus.loading, selection: selection));
    await _request(_revision);
  }

  void detach() {
    ++_revision;
    _fence = null;
    _lineage = null;
    _session = null;
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
    try {
      final before = controller.snapshot;
      final excluded = replace
          ? [if (before.currentEntry != null) before.currentEntry!.track.ref]
          : before.entries.map((e) => e.track.ref).toList();
      final page = await repository.wave(
        selection,
        fence,
        cursor: cursor,
        exclusions: excluded,
        sessionId: session,
      );
      if (!_valid(revision, lineage, fence)) return;
      final current = controller.snapshot;
      final existing = replace
          ? {
              if (current.currentEntry != null)
                current.currentEntry!.track.ref.identityKey,
            }
          : current.entries.map((e) => e.track.ref.identityKey).toSet();
      final tracks = page.tracks
          .where((t) => t.playable && existing.add(t.ref.identityKey))
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
        _emptyPages++;
        _status(
          _emptyPages >= 2 || page.nextCursor == null
              ? WaveStatus.exhausted
              : WaveStatus.active,
          cursor: page.nextCursor,
          generation: page.generationId,
        );
        return;
      }
      _emptyPages = 0;
      final entries = controller.createEntries(
        tracks,
        PlayContext(
          surface: PlaySurface.wave,
          waveMode: selection.mode,
          recommendationGenerationId: page.generationId,
          recommendationSessionId: session,
        ),
      );
      _applying = revision;
      if (replace) {
        _pendingReplacementEntry = entries.first.entryId;
        _pendingReplacementLineage = lineage;
        await controller.dispatch(
          ReplaceQueue(entries, fence: fence, expectedLineage: lineage),
        );
      } else {
        await controller.dispatch(
          Enqueue(entries, fence: fence, expectedLineage: lineage),
        );
      }
      if (revision != _revision || !authority.isCurrent(fence) || _disposed) {
        return;
      }
      final applied = controller.snapshot;
      if (applied.fence != fence ||
          !applied.entries.any((e) => e.entryId == entries.first.entryId)) {
        if (applied.lineage != lineage) {
          detach();
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
      _lineage = applied.lineage;
      _needsReplacement = false;
      _publish(
        WaveState(
          status: page.nextCursor == null
              ? WaveStatus.exhausted
              : WaveStatus.active,
          selection: selection,
          cursor: page.nextCursor,
          generationId: page.generationId,
        ),
      );
    } catch (_) {
      if (_valid(revision, lineage, fence)) {
        _status(
          WaveStatus.error,
          failure: const AppFailure(
            code: 'wave_request_failed',
            message: 'Не удалось продолжить Волну',
            retryable: true,
          ),
        );
      }
    } finally {
      if (_inFlight == revision) _inFlight = null;
      if (_applying == revision) _applying = null;
      if (revision == _revision && _state.status == WaveStatus.active) {
        if (_emptyPages > 0) {
          unawaited(_request(revision));
        } else {
          _observe(controller.snapshot);
        }
      }
    }
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
