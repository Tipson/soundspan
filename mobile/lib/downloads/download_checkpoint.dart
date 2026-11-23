/// Only code-owned opaque path segments are persisted, never an absolute path,
/// token, signed URI or account credential.
final class DownloadCheckpoint {
  const DownloadCheckpoint({
    required this.generation,
    required this.claim,
    required this.bytes,
    this.totalBytes,
    this.strongEtag,
    this.sha256,
  });
  final int generation;
  final String claim;
  final int bytes;
  final int? totalBytes;
  final String? strongEtag;
  final String? sha256;
  bool get resumable =>
      bytes > 0 &&
      totalBytes != null &&
      bytes < totalBytes! &&
      strongEtag != null;
  Map<String, Object?> toJson() => {
    'generation': generation,
    'claim': claim,
    'bytes': bytes,
    'total': totalBytes,
    'etag': strongEtag,
    'sha256': sha256,
  };
  factory DownloadCheckpoint.fromJson(Map<String, Object?> json) {
    final c = DownloadCheckpoint(
      generation: json['generation'] as int,
      claim: json['claim'] as String,
      bytes: json['bytes'] as int,
      totalBytes: json['total'] as int?,
      strongEtag: json['etag'] as String?,
      sha256: json['sha256'] as String?,
    );
    if (c.generation < 1 ||
        c.bytes < 0 ||
        (c.totalBytes != null &&
            (c.totalBytes! < c.bytes || c.totalBytes! < 1)) ||
        !RegExp(r'^[a-f0-9]{48}$').hasMatch(c.claim) ||
        (c.strongEtag != null && !isStrongEtag(c.strongEtag)) ||
        (c.sha256 != null && !RegExp(r'^[a-f0-9]{64}$').hasMatch(c.sha256!))) {
      throw const FormatException('Download checkpoint');
    }
    return c;
  }
  static bool isStrongEtag(String? value) =>
      value != null &&
      value.length <= 160 &&
      RegExp(r'^"[\x21\x23-\x7e]*"$').hasMatch(value);
}
