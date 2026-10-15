/// A classified application failure. Never put credentials or response bodies in
/// [message]; it may be displayed to the user.
class AppFailure implements Exception {
  const AppFailure({
    required this.code,
    required this.message,
    this.retryable = false,
    this.statusCode,
    this.retryAfter,
  });

  final String code;
  final String message;
  final bool retryable;
  final int? statusCode;

  /// Server-directed holdoff. Callers may retry only after this delay.
  final Duration? retryAfter;

  @override
  String toString() => 'AppFailure($code)';
}

/// Invalid API shape or conflicting identity; no implicit provider fallback.
final class MappingFailure extends AppFailure {
  const MappingFailure({required this.endpoint, required this.path})
    : super(code: 'invalid_track_shape', message: 'Некорректные данные трека');

  final String endpoint;
  final String path;

  @override
  String toString() => 'MappingFailure($endpoint, $path)';
}
