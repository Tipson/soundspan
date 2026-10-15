import 'dart:io';

import 'package:crypto/crypto.dart';

import '../core/network/media_response_validator.dart';
import '../playback/resolved_media.dart';

abstract interface class MediaProbe {
  Future<MediaProbeResult> probe(File file);
}

final class MediaProbeResult {
  const MediaProbeResult({required this.decodable, required this.duration});
  final bool decodable;
  final Duration duration;
}

final class VerifiedMedia {
  const VerifiedMedia({
    required this.bytes,
    required this.sha256,
    required this.duration,
  });
  final int bytes;
  final String sha256;
  final Duration duration;
}

/// A native decoder probe is mandatory, including for unknown-length streams.
/// Hashing is incremental and asynchronous; no whole-song memory buffer.
final class DownloadVerifier {
  const DownloadVerifier({required this.probe});
  final MediaProbe probe;
  Future<VerifiedMedia> verify(File file, {int? expectedBytes}) async {
    final length = await file.length();
    if (length == 0 || (expectedBytes != null && expectedBytes != length)) {
      throw invalidMedia;
    }
    final prefix = await file
        .openRead(0, length < 64 ? length : 64)
        .expand((b) => b)
        .toList();
    MediaResponseValidator.validatePrefix(prefix);
    final result = await probe.probe(file);
    if (!result.decodable || result.duration <= Duration.zero) {
      throw invalidMedia;
    }
    final digest = (await sha256.bind(file.openRead()).first).toString();
    if (await file.length() != length) throw invalidMedia;
    return VerifiedMedia(
      bytes: length,
      sha256: digest,
      duration: result.duration,
    );
  }

  Future<bool> matches(
    File file, {
    required int bytes,
    required String digest,
  }) async {
    try {
      return bytes > 0 &&
          await file.length() == bytes &&
          (await sha256.bind(file.openRead()).first).toString() == digest &&
          await file.length() == bytes;
    } on FileSystemException {
      return false;
    }
  }
}
