import 'dart:async';

import '../core/model/owner_key.dart';
import '../core/model/track_ref.dart';
import '../core/network/network_policy.dart';
import '../core/network/api_transport.dart';
import '../core/session/session_authority.dart';
import '../features/recommendations/recommendation_repository.dart';
import 'feedback_outbox.dart';
import 'playback_controller.dart';
import 'playback_event_models.dart';
import 'play_create_journal.dart';
export 'playback_event_models.dart';

/// Service-owned, synchronous event accounting with detached network effects.
/// UI disposal does not affect this object; the composition root owns dispose.
final class PlaybackReporter {
  PlaybackReporter({
    required this.controller,
    required this.repository,
    required this.outbox,
    required this.authority,
    this.journal,
    this.networkPolicy = const NetworkPolicy.online(),
  }) {
    _events = controller.events.listen(_onEvent);
    _sessions = authority.changes.listen((_) {
      if (_active != null && !authority.isCurrent(_active!.fence)) {
        _active = null;
        _publish(const PlaybackReportState());
      }
    });
  }
  final PlaybackController controller;
  final RecommendationRepository repository;
  final FeedbackOutbox outbox;
  final SessionAuthority authority;
  final PlayCreateJournal? journal;
  final NetworkPolicy networkPolicy;
  late final StreamSubscription<PlaybackEvent> _events;
  late final StreamSubscription<SessionState> _sessions;
  final _states = StreamController<PlaybackReportState>.broadcast();
  PlaybackReportState _state = const PlaybackReportState();
  PlaybackReportState get state => _state;
  Stream<PlaybackReportState> get states => _states.stream;
  _Run? _active;
  String? _terminalKey;
  SessionFence? _observedFence;
  int _highestGeneration = -1;
  bool _disposed = false;
  void _publish(PlaybackReportState value) {
    _state = value;
    if (!_disposed) _states.add(value);
  }

  void _status(_Run run, {String? error}) {
    if (identical(_active, run)) {
      _publish(
        PlaybackReportState(
          entryId: run.entry.entryId,
          createState: run.createState,
          listenedSeconds: run.listened,
          errorCode: error,
        ),
      );
    }
  }

  String _key(QueueSnapshot snapshot) =>
      '${snapshot.currentEntryId}:${snapshot.generation}';
  void _onEvent(PlaybackEvent event) {
    if (_disposed) return;
    final snapshot = event.snapshot;
    final fence = snapshot.fence;
    // A delayed A broadcast must not finalize or recreate the active B run.
    if (fence != null && !authority.isCurrent(fence)) return;
    if (fence == null) {
      if (controller.snapshot.fence != null) return;
      final previous = _active;
      if (snapshot.generation > _highestGeneration) {
        _highestGeneration = snapshot.generation;
      }
      if (previous != null && authority.isCurrent(previous.fence)) {
        _finish(previous, PlayOutcome.skipped);
        _terminalKey = previous.key;
      }
      _active = null;
      return;
    }
    if (_observedFence != fence) {
      _observedFence = fence;
      _highestGeneration = -1;
      _terminalKey = null;
    }
    if (snapshot.generation < _highestGeneration) return;
    if (snapshot.generation > _highestGeneration) {
      _highestGeneration = snapshot.generation;
    }
    var run = _active;
    final key = _key(snapshot);
    if (run != null &&
        (snapshot.generation < run.generation ||
            event.elapsed < run.last.elapsed)) {
      return;
    }
    final terminal =
        event.kind == PlaybackEventKind.failure ||
        event.kind == PlaybackEventKind.completed;
    if (run != null &&
        (run.fence != fence ||
            (run.key != key &&
                !(terminal && run.entry.entryId == snapshot.currentEntryId)))) {
      _finish(run, PlayOutcome.skipped);
      _active = null;
      run = null;
    }
    if (run == null) {
      final entry = snapshot.currentEntry;
      if (entry == null ||
          !snapshot.audible ||
          snapshot.processing != PlaybackProcessing.ready ||
          key == _terminalKey) {
        return;
      }
      run = _Run(key: key, entry: entry, fence: fence, last: event);
      _active = run;
      _status(run);
      final grant = journal?.capabilities.playCreationGrant;
      final source = switch (entry.track.ref) {
        YoutubeTrackRef() => 'youtube',
        NativeTrackRef(:final recording) => recording.provider.name,
        _ => null,
      };
      if (networkPolicy.networkAllowed &&
          grant != null &&
          source != null &&
          grant.allowsNew(source, fence)) {
        run.keyed = true;
        try {
          final capturedRun = run;
          run.ticket = journal!.begin(
            entry,
            grant,
            playbackRunId: run.traceId,
            onUnknown: () {
              if (!_disposed && authority.isCurrent(capturedRun.fence)) {
                capturedRun.createState = PlayCreateState.ambiguous;
                _status(capturedRun, error: 'play_create_ambiguous');
              }
            },
          );
        } catch (_) {
          run.createState = PlayCreateState.ambiguous;
          _status(run, error: 'play_create_store_failed');
        }
      }
      unawaited(_create(run));
    } else {
      final previous = run.last;
      final elapsed =
          (event.elapsed - previous.elapsed).inMicroseconds / 1000000;
      final progress =
          (snapshot.position - previous.snapshot.position).inMicroseconds /
          1000000;
      if (event.kind != PlaybackEventKind.seek &&
          event.kind != PlaybackEventKind.transition &&
          previous.snapshot.audible &&
          previous.snapshot.processing == PlaybackProcessing.ready &&
          ((snapshot.audible &&
                  snapshot.processing == PlaybackProcessing.ready) ||
              event.kind == PlaybackEventKind.completed) &&
          elapsed > 0 &&
          progress > 0 &&
          // Native background events may be sparse. Bound against this actual
          // monotonic interval, allowing one second of position sampling jitter,
          // rather than assuming a foreground timer frequency. Explicit seek
          // events are excluded above; an implausible unmarked jump is neutral.
          progress <= elapsed + 1) {
        run.listened =
            (run.listened + (progress < elapsed ? progress : elapsed))
                .clamp(0, 86400)
                .toDouble();
      }
      run.last = event;
      _status(run);
    }
    if (event.kind == PlaybackEventKind.failure) {
      _finish(run, PlayOutcome.failed);
      _active = null;
      _terminalKey = key;
      return;
    }
    if (event.kind == PlaybackEventKind.completed) {
      _finish(run, PlayOutcome.completed);
      _active = null;
      _terminalKey = key;
      return;
    }
    if ((run.playId != null || run.ticket != null) &&
        run.listened - run.lastQueued >= 30) {
      final engagement = _engagement(run, PlayOutcome.skipped);
      // Never create an early-skip or positive training signal merely because
      // a checkpoint timer elapsed. Only an already meaningful run checkpoints.
      if (engagement.outcome == PlayOutcome.meaningful) {
        run.lastQueued = run.listened;
        unawaited(_queue(run, engagement));
      }
    }
  }

  Future<void> _create(_Run run) async {
    if (!networkPolicy.networkAllowed) {
      run.createState = PlayCreateState.idle;
      _status(run, error: 'offline_mode');
      return;
    }
    try {
      if (run.keyed) {
        final ticket = run.ticket;
        if (ticket == null) return;
        run.playId = await ticket.created;
        if (_disposed || !authority.isCurrent(run.fence)) return;
        run.createState = PlayCreateState.known;
        _status(run);
        if (run.finalEngagement != null) {
          await _queue(run, run.finalEngagement!);
        }
        return;
      }
      await authority.assertCurrent(run.fence);
      if (_disposed || !authority.isCurrent(run.fence)) return;
      networkPolicy.requireNetwork();
      run.playId = await repository.startPlay(
        run.entry,
        run.fence,
        playbackRunId: run.traceId,
      );
      if (_disposed || !authority.isCurrent(run.fence)) return;
      run.createState = PlayCreateState.known;
      _status(run);
      if (run.finalEngagement != null) await _queue(run, run.finalEngagement!);
    } catch (_) {
      // A failed/lost POST response may already have created a server play. Never
      // retry it on subsequent ticks and never fabricate an ID for engagement.
      run.createState = PlayCreateState.ambiguous;
      _status(run, error: 'play_create_ambiguous');
    }
  }

  PlayEngagement _engagement(_Run run, PlayOutcome reason) {
    final duration =
        (run.last.snapshot.duration ?? run.entry.track.duration)
            ?.inMicroseconds ??
        0;
    final ratio = duration > 0
        ? (run.listened * 1000000 / duration).clamp(0, 1).toDouble()
        : 0.0;
    final outcome =
        reason == PlayOutcome.skipped && (run.listened >= 30 && ratio > 0.2)
        ? PlayOutcome.meaningful
        : reason;
    return PlayEngagement(
      listenedSeconds: run.listened,
      completionRatio: reason == PlayOutcome.completed ? 1 : ratio,
      outcome: outcome,
    );
  }

  void _finish(_Run run, PlayOutcome reason) {
    if (run.finalEngagement != null) return;
    run.finalEngagement = _engagement(run, reason);
    if (run.playId != null || run.ticket != null) {
      unawaited(_queue(run, run.finalEngagement!));
    }
  }

  Future<void> _queue(_Run run, PlayEngagement engagement) async {
    if (_disposed || !authority.isCurrent(run.fence)) {
      return;
    }
    try {
      if (run.keyed && run.ticket != null) {
        await journal!.checkpoint(
          run.ticket!,
          engagement,
          finalTotals: run.finalEngagement != null,
        );
        return;
      }
      if (run.playId == null) return;
      await outbox.enqueue(
        run.playId!,
        engagement,
        run.fence,
        playbackRunId: run.traceId,
      );
      if (authority.isCurrent(run.fence)) await outbox.flush(run.fence);
    } catch (_) {
      _status(run, error: 'play_engagement_store_failed');
    }
  }

  Future<void> dispose() async {
    if (_disposed) return;
    final run = _active;
    final saved = run?.ticket != null && authority.isCurrent(run!.fence)
        ? journal!.checkpoint(
            run.ticket!,
            _engagement(run, PlayOutcome.skipped),
            finalTotals: true,
          )
        : null;
    _disposed = true;
    await _events.cancel();
    await _sessions.cancel();
    _active = null;
    await saved;
    await _states.close();
  }
}

final class _Run {
  _Run({
    required this.key,
    required this.entry,
    required this.fence,
    required this.last,
  }) : generation = last.snapshot.generation;
  final String key;
  final QueueEntry entry;
  final SessionFence fence;
  final int generation;
  final String traceId = newPlaybackTraceId();
  PlaybackEvent last;
  double listened = 0;
  double lastQueued = 0;
  String? playId;
  PlayCreateState createState = PlayCreateState.pending;
  PlayEngagement? finalEngagement;
  bool keyed = false;
  PlayCreateTicket? ticket;
}
