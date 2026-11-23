import 'dart:convert';
import 'dart:math';

import '../../playback/resolved_media.dart';

final class ValidatedMediaResponse {
  const ValidatedMediaResponse({
    this.expectedLength,
    this.totalLength,
    this.actualStart,
  });
  final int? expectedLength;
  final int? totalLength;

  /// The returned representation's first byte, after Content-Range validation.
  /// Null for a 416 response with no media body.
  final int? actualStart;
}

/// Pure response checks run before publishing any upstream headers or bytes.
final class MediaResponseValidator {
  static void validateIfRange(ByteRange? range, String? ifRange) {
    if (ifRange != null &&
        (range == null ||
            ifRange.isEmpty ||
            ifRange.length > 160 ||
            RegExp(r'[\x00-\x1f\x7f]').hasMatch(ifRange))) {
      throw invalidMedia;
    }
  }

  static int _number(String text) {
    final number = int.tryParse(text);
    if (!RegExp(r'^\d+$').hasMatch(text) ||
        number == null ||
        number > maxMediaInteger) {
      throw invalidMedia;
    }
    return number;
  }

  static ValidatedMediaResponse validate({
    required int statusCode,
    required Map<String, String> headers,
    ByteRange? range,
    String? ifRange,
    int? expectedTotal,
  }) {
    validateIfRange(range, ifRange);
    if (statusCode == 416) {
      final match = RegExp(r'^bytes \*/(\d+)$')
          .firstMatch(headers['content-range'] ?? '');
      if (range == null || match == null) throw invalidMedia;
      return ValidatedMediaResponse(totalLength: _number(match[1]!));
    }
    if (statusCode != 200 && statusCode != 206) throw invalidMedia;
    final type = headers['content-type']?.split(';').first.trim().toLowerCase();
    if (!(type?.startsWith('audio/') ?? false) &&
        !const {
          'application/octet-stream',
          'application/ogg',
          'video/mp4',
          'video/webm',
        }.contains(type)) {
      throw invalidMedia;
    }
    if (type!.contains('mpegurl') ||
        type.contains('dash') ||
        (headers['content-encoding'] != null &&
            headers['content-encoding'] != 'identity')) {
      throw invalidMedia;
    }
    final length = headers['content-length'] == null
        ? null
        : _number(headers['content-length']!);
    if (statusCode == 200) {
      if (headers.containsKey('content-range')) throw invalidMedia;
      return ValidatedMediaResponse(
        expectedLength: length,
        totalLength: length,
        actualStart: 0,
      );
    }
    final match = RegExp(r'^bytes (\d+)-(\d+)/(\d+)$')
        .firstMatch(headers['content-range'] ?? '');
    if (range == null || match == null) throw invalidMedia;
    final start = _number(match[1]!);
    final end = _number(match[2]!);
    final total = _number(match[3]!);
    if (total <= 0 ||
        end < start ||
        end >= total ||
        (expectedTotal != null && expectedTotal != total)) {
      throw invalidMedia;
    }
    final expectedStart = range.suffix != null
        ? max(0, total - range.suffix!)
        : range.start!;
    final expectedEnd = range.suffix != null
        ? total - 1
        : min(range.end ?? total - 1, total - 1);
    if (start != expectedStart ||
        end != expectedEnd ||
        (length != null && length != end - start + 1)) {
      throw invalidMedia;
    }
    if (ifRange != null) {
      if (ifRange.startsWith('W/')) throw invalidMedia;
      final actual = ifRange.startsWith('"')
          ? headers['etag']
          : headers['last-modified'];
      if (actual != ifRange) throw invalidMedia;
    }
    return ValidatedMediaResponse(
      expectedLength: end - start + 1,
      totalLength: total,
      actualStart: start,
    );
  }

  static void validatePrefix(List<int> prefix, {bool startsAtZero = true}) {
    final text = latin1
        .decode(prefix)
        .replaceFirst(RegExp(r'^\s+'), '')
        .toLowerCase();
    if ((startsAtZero &&
            (text.startsWith('<') ||
                text.startsWith('{') ||
                text.startsWith('['))) ||
        text.startsWith('<html') ||
        text.startsWith('<?xml') ||
        text.startsWith('<mpd') ||
        text.startsWith('<!doctype') ||
        text.startsWith('#extm3u') ||
        text.startsWith('\u00ef\u00bb\u00bf<')) {
      throw invalidMedia;
    }
    // At byte zero require a known progressive container/frame signature.
    // This also excludes documents hidden behind arbitrary whitespace/BOMs.
    // Tiny byte probes cannot carry a complete signature and are range-checked.
    if (startsAtZero && prefix.length >= 12) {
      final raw = latin1.decode(prefix);
      final framed = prefix[0] == 0xff && (prefix[1] & 0xe0) == 0xe0;
      final ebml =
          prefix[0] == 0x1a &&
          prefix[1] == 0x45 &&
          prefix[2] == 0xdf &&
          prefix[3] == 0xa3;
      final known =
          raw.startsWith('ID3') ||
          raw.startsWith('fLaC') ||
          raw.startsWith('OggS') ||
          (raw.startsWith('RIFF') && raw.substring(8, 12) == 'WAVE') ||
          (raw.startsWith('FORM') &&
              const {'AIFF', 'AIFC'}.contains(raw.substring(8, 12))) ||
          raw.substring(4, 8) == 'ftyp';
      if (!framed && !ebml && !known) throw invalidMedia;
    }
  }
}
