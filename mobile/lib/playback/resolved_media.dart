import 'dart:async';

import '../core/model/app_failure.dart';
import '../core/model/owner_key.dart';
import '../core/model/track_ref.dart';
import '../core/network/request_cancellation.dart';

enum ResolvePurpose { playback, preload, download }

/// Ephemeral transport state. Never put this object in queue persistence or
/// player metadata; the player receives only a revocable MediaHandle.
final class ResolvedMedia {
  const ResolvedMedia({
    required this.ref,
    required this.purpose,
    required this.fence,
    required this.uri,
    this.renewableUri,
  });
  final TrackRef ref;
  final ResolvePurpose purpose;
  final SessionFence fence;
  final Uri uri;
  final Uri? renewableUri;
  @override
  String toString() => 'ResolvedMedia(<private>)';
}

const invalidMedia = AppFailure(
  code: 'invalid_media',
  message: 'Некорректный аудиопоток',
);
const mediaCancelled = AppFailure(
  code: 'media_cancelled',
  message: 'Передача аудио отменена',
);
const maxMediaInteger = 9007199254740991;

/// One RFC byte range, bounded to an exactly representable integer.
final class ByteRange {
  ByteRange({required int start, int? end})
    : start = start,
      end = end,
      suffix = null {
    if (start < 0 ||
        start > maxMediaInteger ||
        (end != null && (end < start || end > maxMediaInteger))) {
      throw invalidMedia;
    }
  }
  ByteRange.suffix(int length) : suffix = length, start = null, end = null {
    if (length < 1 || length > maxMediaInteger) throw invalidMedia;
  }
  factory ByteRange.parse(String value) {
    if (value.length > 80) throw invalidMedia;
    final match = RegExp(r'^bytes=(\d*)-(\d*)$').firstMatch(value);
    if (match == null) throw invalidMedia;
    final first = int.tryParse(match[1]!);
    final last = int.tryParse(match[2]!);
    if (match[1]!.isEmpty && last != null) return ByteRange.suffix(last);
    if (first == null || (match[2]!.isNotEmpty && last == null)) {
      throw invalidMedia;
    }
    return ByteRange(start: first, end: last);
  }
  final int? start;
  final int? end;
  final int? suffix;
  String get header =>
      suffix != null ? 'bytes=-$suffix' : 'bytes=$start-${end ?? ''}';
}

/// Synchronous cancellation reaches pending headers and active sockets even
/// when the consumer has paused its stream subscription.
final class MediaCancellation implements RequestCancellation {
  bool _cancelled = false;
  final Set<void Function()> _listeners = {};
  bool get isCancelled => _cancelled;
  @override
  void check() {
    if (_cancelled) throw mediaCancelled;
  }

  @override
  void Function() listen(void Function() listener) {
    if (_cancelled) {
      listener();
      return () {};
    }
    _listeners.add(listener);
    return () => _listeners.remove(listener);
  }

  void cancel() {
    if (_cancelled) return;
    _cancelled = true;
    for (final listener in List.of(_listeners)) {
      listener();
    }
    _listeners.clear();
  }
}

/// Single-subscription body with explicit disposal for a consumer that decides
/// not to read it. Headers are a safe media-only allowlist.
final class ProtectedMediaResponse {
  ProtectedMediaResponse({
    required this.statusCode,
    required Map<String, String> headers,
    required this.body,
    required this.close,
  }) : headers = Map.unmodifiable(headers);
  final int statusCode;
  final Map<String, String> headers;
  final Stream<List<int>> body;
  final Future<void> Function() close;
}
