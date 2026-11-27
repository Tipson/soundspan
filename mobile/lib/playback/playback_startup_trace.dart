import '../core/model/app_failure.dart';

/// Debug timings for one preparation attempt. Only fixed labels and durations
/// leave this object. The monotonic clock is shared with the loopback gateway.
final class PlaybackStartupTrace {
  PlaybackStartupTrace(this.generation, Duration preparationElapsed)
    : _startedAt = now - preparationElapsed;

  static final _clock = Stopwatch()..start();

  /// A monotonic timestamp for startup phase boundaries in this isolate.
  static Duration get now => _clock.elapsed;

  final int generation;
  final Duration _startedAt;
  Duration? _sourceAt;
  Duration? _decoderAt;
  String _source = 'unknown';
  Duration? Function()? _readFirstGatewayAudioByteAt;

  void sourceChosen({
    required bool local,
    required bool published,
    required Duration? Function() readFirstGatewayAudioByteAt,
  }) {
    _source = local
        ? 'local'
        : published
        ? 'published'
        : 'network';
    _readFirstGatewayAudioByteAt = readFirstGatewayAudioByteAt;
    _sourceAt = now;
  }

  void decoderReady() => _decoderAt = now;

  String summary({AppFailure? failure}) {
    final playingAt = failure == null ? now : null;
    String phase(Duration? timestamp) => timestamp == null
        ? '-'
        : (timestamp - _startedAt).inMilliseconds.toString();
    final code = switch (failure?.code) {
      null => '-',
      'background_playback_unavailable' ||
      'download_storage_error' ||
      'http_error' ||
      'invalid_media' ||
      'media_busy' ||
      'media_cancelled' ||
      'media_idle_timeout' ||
      'media_network_error' ||
      'media_restricted' ||
      'network_cancelled' ||
      'network_timeout' ||
      'offline_mix_file_unavailable' ||
      'offline_mode' ||
      'playback_failed' ||
      'playback_prepare_timeout' ||
      'playback_start_timeout' ||
      'recommendation_admission_unavailable' ||
      'recording_unavailable' ||
      'tls_failed' ||
      'unauthorized' => failure!.code,
      _ => 'other',
    };
    final status = failure?.statusCode;
    final httpStatus = status != null && status >= 400 && status <= 599
        ? status.toString()
        : '-';
    return '[SoundspanStartup] outcome=${failure == null ? 'playing' : 'failed'} '
        'source=$_source source_ms=${phase(_sourceAt)} '
        'first_bytes_ms=${phase(_readFirstGatewayAudioByteAt?.call())} '
        'decoder_ms=${phase(_decoderAt)} playing_ms=${phase(playingAt)} '
        'failure=$code http_status=$httpStatus';
  }
}
