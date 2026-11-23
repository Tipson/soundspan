import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:just_audio/just_audio.dart' as audio;

import 'playback_engine.dart';
import 'android_playback_gain.dart';
import 'native_loudness_controller.dart';
import 'platform_gain_adapter.dart';
import 'queue_snapshot.dart';

/// Real single-source engine. Queue transitions remain service-owned and fresh.
final class JustAudioEngine
    implements
        PlaybackEngine,
        LoudnessPlaybackEngine,
        PlaybackStartConfirmation {
  factory JustAudioEngine({
    audio.AudioPlayer? player,
    @visibleForTesting AndroidPlaybackGain? gainBridge,
  }) {
    final effect =
        gainBridge ??
        (player == null && Platform.isAndroid ? AndroidPlaybackGain() : null);
    final actualPlayer =
        player ??
        audio.AudioPlayer(
          handleInterruptions: false,
          handleAudioSessionActivation: true,
        );
    return JustAudioEngine._(actualPlayer, effect);
  }
  JustAudioEngine._(this._player, this._effect)
    : loudness = NativeLoudnessController(
        _effect == null
            ? PlatformGainAdapter(setVolume: _player.setVolume)
            : PlatformGainAdapter(
                setVolume: _player.setVolume,
                setBoostDb: _effect.setBoostDb,
              ),
      ) {
    _subscriptions.add(
      _player.playbackEventStream.listen(
        (_) => _emit(),
        onError: (Object _) => _emit(failed: true),
      ),
    );
    _subscriptions.add(_player.positionStream.listen((_) => _emit()));
    _subscriptions.add(_player.playerStateStream.listen((_) => _emit()));
    _subscriptions.add(_player.errorStream.listen((_) => _emit(failed: true)));
  }
  final audio.AudioPlayer _player;
  final AndroidPlaybackGain? _effect;

  /// Read-only integration diagnostics, after native setter futures complete.
  /// This is acknowledged plugin state, not a physical audio measurement.
  @visibleForTesting
  ({int? sessionId, double volume, double? boostDb, bool enabled})
  get gainDiagnostics => (
    sessionId: _player.androidAudioSessionId,
    volume: _player.volume,
    boostDb: (_effect?.diagnostics?.targetGainMb ?? 0) / 100,
    enabled: _effect?.diagnostics?.enabled ?? false,
  );
  @visibleForTesting
  Future<NativeGainState?> readNativeGain() async => _effect?.read();
  @override
  final NativeLoudnessController loudness;
  @override
  void updateLoudnessContext(QueueSnapshot state) =>
      loudness.updateContext(state);
  // Never call plugin stop/load reentrantly from its synchronous Rx event.
  final _events = StreamController<EngineEvent>.broadcast();
  final List<StreamSubscription<dynamic>> _subscriptions = [];
  int _generation = -1;
  Uri? _source;
  bool _loading = false, _disposed = false;
  static const _nativeChannel = MethodChannel(
    'com.ryanheise.just_audio.methods',
  );
  @override
  bool get requiresNativeStartConfirmation =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

  @override
  Future<bool> confirmPlaying() async {
    final generation = _generation, source = _source;
    final session = _player.androidAudioSessionId;
    if (_disposed ||
        _loading ||
        generation < 0 ||
        source == null ||
        session == null) {
      return false;
    }
    final result = await _nativeChannel
        .invokeMapMethod<String, Object?>('soundspanReadPlayback', {
          'sessionId': session,
          'source': source.toString(),
        })
        .timeout(const Duration(seconds: 1));
    return !_disposed &&
        !_loading &&
        _generation == generation &&
        _source == source &&
        _player.androidAudioSessionId == session &&
        result?['sessionId'] == session &&
        result?['source'] == source.toString() &&
        result?['isPlaying'] == true;
  }

  @override
  Stream<EngineEvent> get events => _events.stream;
  void _emit({bool failed = false}) {
    if (_disposed || _generation < 0 || _loading) return;
    _events.add(
      EngineEvent(
        generation: _generation,
        position: _player.position,
        duration: _player.duration,
        bufferedPosition: _player.bufferedPosition,
        processing: switch (_player.processingState) {
          audio.ProcessingState.idle => PlaybackProcessing.idle,
          audio.ProcessingState.loading => PlaybackProcessing.loading,
          audio.ProcessingState.buffering => PlaybackProcessing.buffering,
          audio.ProcessingState.ready => PlaybackProcessing.ready,
          audio.ProcessingState.completed => PlaybackProcessing.completed,
        },
        playing: _player.playing,
        failed: failed,
      ),
    );
  }

  @override
  Future<void> load(Uri uri, int generation) async {
    // Reject network URLs other than the exact capability gateway. No headers.
    if (!(uri.scheme == 'file' ||
        (uri.scheme == 'http' &&
            uri.host == '127.0.0.1' &&
            uri.userInfo.isEmpty &&
            !uri.hasQuery &&
            !uri.hasFragment))) {
      throw ArgumentError('Only local prepared media allowed');
    }
    _generation = generation;
    _source = uri;
    _loading = true;
    try {
      await loudness.suspend();
      if (_disposed || _generation != generation) return;
      await _player.setAudioSources(
        [audio.AudioSource.uri(uri)],
        initialIndex: 0,
        initialPosition: Duration.zero,
      );
      if (_disposed || _generation != generation) return;
      final sessionId = _effect == null ? null : _player.androidAudioSessionId;
      final available = _effect != null && sessionId != null
          ? await _effect.bind(sessionId)
          : false;
      if (_disposed || _generation != generation) return;
      await loudness.sourceReady(generation, nativeActive: available);
    } finally {
      if (_generation == generation) {
        _loading = false;
        _emit();
      }
    }
  }

  @override
  Future<void> play() async {
    final generation = _generation;
    await loudness.flush();
    if (_disposed ||
        generation != _generation ||
        generation < 0 ||
        (loudness.hasOwner && !loudness.canPlay)) {
      return;
    }
    await _player.play();
  }

  @override
  Future<void> pause() => _player.pause();
  @override
  Future<void> stop() {
    _generation = -1;
    _source = null;
    _loading = false;
    final stopped = _player.stop();
    return Future.wait<void>([
      stopped,
      loudness.suspend(),
      if (_effect != null) _effect.release(),
    ]);
  }

  @override
  Future<void> seek(Duration position) => _player.seek(position);
  @override
  Future<void> setVolume(double volume) =>
      loudness.hasOwner ? loudness.flush() : _player.setVolume(volume);
  @override
  Future<void> dispose() async {
    _disposed = true;
    await loudness.close();
    await _effect?.release();
    for (final sub in _subscriptions) {
      await sub.cancel();
    }
    await _player.dispose();
    await _events.close();
  }
}
