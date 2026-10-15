import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../core/model/app_failure.dart';
import '../../core/model/owner_key.dart';
import '../../core/model/track_ref.dart';
import '../../core/network/api_transport.dart';
import '../../core/network/network_policy.dart';
import '../../core/session/session_authority.dart';
import '../../playback/playback_controller.dart';
import '../library/library_models.dart';
import 'likes_models.dart';

/// One shared preference authority for rows, mini player and full player.
/// Writes are serialized per exact identity, including different native versions.
/// A later UI intent stays visible while older writes finish on the server.
final class PreferenceController extends ChangeNotifier {
  PreferenceController({
    required this.transport,
    required this.authority,
    required this.fence,
    this.networkPolicy = const NetworkPolicy.online(),
    this.playback,
  }) {
    _session = authority.changes.listen((_) {
      if (!isCurrent) {
        _clear();
      } else {
        notifyListeners();
      }
    });
  }
  final ApiTransport transport;
  final SessionAuthority authority;
  final SessionFence fence;
  final NetworkPolicy networkPolicy;
  final PlaybackController? playback;
  late final StreamSubscription<SessionState> _session;
  final _slots = <String, _PreferenceSlot>{};
  final _watchers = <String, ValueNotifier<PreferenceState>>{};
  final _skippedSelections = <(String, int)>{};
  final _applied = StreamController<PreferenceChange>.broadcast(sync: true);
  Stream<PreferenceChange> get applied => _applied.stream;
  bool _disposed = false;
  bool get isCurrent => !_disposed && authority.isCurrent(fence);
  bool get canMutate => isCurrent && networkPolicy.networkAllowed;

  bool supports(TrackRef ref, PreferenceSignal signal) =>
      ref is! UnavailableTrackRef ||
      (signal == PreferenceSignal.clear && _historicalTidal(ref));

  bool _historicalTidal(UnavailableTrackRef ref) =>
      ref.reason == 'retired_provider' &&
      RegExp(r'^tidal:[1-9]\d*$').hasMatch(ref.identityKey);

  PreferenceState current(TrackRef ref) => isCurrent
      ? (_slots[ref.identityKey]?.state ?? const PreferenceState())
      : const PreferenceState();
  ValueListenable<PreferenceState> watch(TrackRef ref) =>
      _watchers.putIfAbsent(ref.identityKey, () => ValueNotifier(current(ref)));

  /// Authoritative list reads may seed likes, but never overwrite a local intent.
  void seed(TrackRef ref, PreferenceSignal signal) {
    if (!isCurrent || _slots.containsKey(ref.identityKey)) return;
    _slots[ref.identityKey] = _PreferenceSlot()
      ..confirmed = signal
      ..state = PreferenceState(signal: signal);
    _publish(ref.identityKey);
  }

  Future<void> load(TrackRef ref) async {
    if (!isCurrent) throw collectionStaleSession;
    final slot = _slots.putIfAbsent(ref.identityKey, _PreferenceSlot.new);
    if (slot.loading != null) return slot.loading!;
    final revision = slot.revision;
    final future = _load(ref, slot, revision);
    slot.loading = future;
    try {
      await future;
    } finally {
      if (identical(slot.loading, future)) slot.loading = null;
    }
  }

  Future<void> _load(TrackRef ref, _PreferenceSlot slot, int revision) async {
    try {
      final response = await _request(ref, ApiMethod.get);
      final signal = _readSignal(ref, response.data);
      if (isCurrent && slot.revision == revision && !slot.running) {
        slot.confirmed = signal;
        slot.state = PreferenceState(signal: signal);
        _publish(ref.identityKey);
      }
    } catch (error) {
      if (isCurrent && slot.revision == revision && !slot.running) {
        slot.state = PreferenceState(
          signal: slot.confirmed,
          failure: collectionFailure(error),
        );
        _publish(ref.identityKey);
      }
      rethrow;
    }
  }

  Future<void> set(TrackRef ref, PreferenceSignal signal) {
    if (!isCurrent) return Future.error(collectionStaleSession);
    try {
      networkPolicy.requireNetwork();
    } catch (error, stack) {
      return Future.error(error, stack);
    }
    if (!supports(ref, signal)) {
      return Future.error(
        const AppFailure(
          code: 'unsupported_preference',
          message: 'Предпочтение для этой записи недоступно.',
        ),
      );
    }
    // Captured synchronously, before either network or another selected entry.
    final captured = playback?.snapshot;
    final slot = _slots.putIfAbsent(ref.identityKey, _PreferenceSlot.new);
    final pending = _PreferenceIntent(signal);
    slot.revision++;
    slot.pending.add(pending);
    slot.state = PreferenceState(signal: signal, pending: true);
    _publish(ref.identityKey);
    if (signal == PreferenceSignal.dislike &&
        captured?.fence == fence &&
        captured?.currentEntry?.track.ref == ref &&
        _skippedSelections.add((
          captured!.currentEntryId!,
          captured.generation,
        ))) {
      // Admission rechecks entry + fence in the queue authority after its await.
      unawaited(_advance(captured));
    }
    if (!slot.running) {
      slot.running = true;
      unawaited(_drain(ref, slot));
    }
    return pending.done.future;
  }

  Future<void> _advance(QueueSnapshot captured) async {
    // Publishing the preference can synchronously select another playback run.
    final current = playback!.snapshot;
    if (!isCurrent ||
        current.fence != captured.fence ||
        current.currentEntryId != captured.currentEntryId ||
        current.generation != captured.generation) {
      return;
    }
    try {
      await playback!.dispatch(
        Next(expectedEntryId: captured.currentEntryId, fence: fence),
      );
    } catch (error) {
      // Skip failure is separate from preference persistence; never undo a like.
      if (isCurrent) {
        _playbackFailure = collectionFailure(error);
        notifyListeners();
      }
    }
  }

  AppFailure? _playbackFailure;
  AppFailure? get playbackFailure => isCurrent ? _playbackFailure : null;

  Future<void> _drain(TrackRef ref, _PreferenceSlot slot) async {
    while (slot.pending.isNotEmpty) {
      final intent = slot.pending.first;
      try {
        final response = await _request(
          ref,
          ApiMethod.post,
          body: {'signal': intent.signal.wire},
        );
        slot.confirmed = _readSignal(ref, response.data);
        if (!isCurrent) throw collectionStaleSession;
        slot.pending.removeAt(0);
        slot.state = PreferenceState(
          signal: slot.pending.isEmpty
              ? slot.confirmed
              : slot.pending.last.signal,
          pending: slot.pending.isNotEmpty,
        );
        _publish(ref.identityKey);
        // Notification can synchronously dispose/revoke this controller. Only
        // an admitted owner may enqueue device work after the server confirms.
        if (isCurrent && !_applied.isClosed) {
          _applied.add(
            PreferenceChange(ref: ref, signal: slot.confirmed!, fence: fence),
          );
        }
        if (!intent.done.isCompleted) intent.done.complete();
      } catch (error) {
        if (slot.pending.isNotEmpty && identical(slot.pending.first, intent)) {
          slot.pending.removeAt(0);
        }
        if (isCurrent) {
          slot.state = PreferenceState(
            signal: slot.pending.isEmpty
                ? slot.confirmed
                : slot.pending.last.signal,
            pending: slot.pending.isNotEmpty,
            failure: collectionFailure(error),
          );
          _publish(ref.identityKey);
        }
        if (!intent.done.isCompleted) intent.done.completeError(error);
      }
    }
    slot.running = false;
  }

  String _serverId(TrackRef ref) => switch (ref) {
    LibraryTrackRef(:final libraryId) => libraryId,
    YoutubeTrackRef(:final videoId) => 'yt:$videoId',
    NativeTrackRef(:final recording) => recording.identityKey,
    UnavailableTrackRef() when _historicalTidal(ref) => ref.identityKey,
    UnavailableTrackRef() => throw const AppFailure(
      code: 'unsupported_preference',
      message: 'Предпочтение для этой записи недоступно.',
    ),
  };
  String _path(TrackRef ref) =>
      '/api/library/${ref is LibraryTrackRef ? 'tracks' : 'remote-tracks'}/${Uri.encodeComponent(_serverId(ref))}/preference';
  Future<ApiResponse> _request(
    TrackRef ref,
    ApiMethod method, {
    Map<String, Object?>? body,
  }) async {
    await authority.assertCurrent(fence);
    if (!isCurrent) throw collectionStaleSession;
    networkPolicy.requireNetwork();
    final response = await transport.send(
      ApiRequest(
        origin: fence.owner.serverOrigin,
        method: method,
        path: _path(ref),
        body: body,
      ),
      fence: fence,
    );
    await authority.assertCurrent(fence);
    if (!isCurrent) throw collectionStaleSession;
    response.requireSuccess();
    return response;
  }

  PreferenceSignal _readSignal(TrackRef ref, Object? data) {
    final dto = collectionObject(data);
    if (dto['trackId'] != _serverId(ref)) {
      throw collectionFailure(StateError('preference identity'));
    }
    return switch ((dto['state'], dto['signal'])) {
      ('liked', 'thumbs_up') => PreferenceSignal.like,
      ('disliked', 'thumbs_down') => PreferenceSignal.dislike,
      ('neutral', 'clear') => PreferenceSignal.clear,
      _ => throw collectionFailure(StateError('preference response')),
    };
  }

  void _publish(String key) {
    if (!isCurrent) return;
    _watchers[key]?.value = _slots[key]!.state;
    notifyListeners();
  }

  void _clear() {
    for (final slot in _slots.values) {
      for (final intent in slot.pending) {
        if (!intent.done.isCompleted) {
          intent.done.completeError(collectionStaleSession);
        }
      }
      slot.pending.clear();
    }
    _slots.clear();
    _skippedSelections.clear();
    _playbackFailure = null;
    for (final watcher in _watchers.values) {
      watcher.value = const PreferenceState();
    }
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    unawaited(_applied.close());
    _session.cancel();
    _clear();
    for (final watcher in _watchers.values) {
      watcher.dispose();
    }
    _watchers.clear();
    super.dispose();
  }
}

final class _PreferenceSlot {
  PreferenceSignal? confirmed;
  PreferenceState state = const PreferenceState();
  final pending = <_PreferenceIntent>[];
  bool running = false;
  int revision = 0;
  Future<void>? loading;
}

final class _PreferenceIntent {
  _PreferenceIntent(this.signal);
  final PreferenceSignal signal;
  final done = Completer<void>();
}
