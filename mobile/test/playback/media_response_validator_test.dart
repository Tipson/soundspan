import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/network/media_response_validator.dart';
import 'package:soundspan/playback/resolved_media.dart';

void main() {
  for (final value in [
    'bytes=1-2,4-5',
    'bytes=-0',
    'bytes=4-3',
    'bytes=9007199254740992-',
    'bytes=a-',
    'bytes=',
  ]) {
    test(
      'invalid range rejected: $value',
      () => expect(() => ByteRange.parse(value), throwsA(isA<AppFailure>())),
    );
  }
  test('closed open and suffix range validate exact response boundaries', () {
    for (final range in [
      ByteRange(start: 2, end: 5),
      ByteRange(start: 2),
      ByteRange.suffix(6),
    ]) {
      final end = range.end ?? 7;
      final value = MediaResponseValidator.validate(
        statusCode: 206,
        headers: {
          'content-type': 'audio/mpeg',
          'content-range': 'bytes 2-$end/8',
          'content-length': '${end - 1}',
        },
        range: range,
      );
      expect(value.expectedLength, end - 1);
      expect(value.totalLength, 8);
    }
  });
  test('malformed206 and changed validator fail before delivery', () {
    for (final headers in [
      {'content-type': 'audio/mpeg', 'content-range': 'bytes 3-7/8'},
      {
        'content-type': 'audio/mpeg',
        'content-range': 'bytes 2-7/8',
        'content-length': '5',
      },
      {
        'content-type': 'audio/mpeg',
        'content-range': 'bytes 2-7/8',
        'etag': '"changed"',
      },
    ]) {
      expect(
        () => MediaResponseValidator.validate(
          statusCode: 206,
          headers: headers,
          range: ByteRange(start: 2),
          ifRange: '"original"',
        ),
        throwsA(isA<AppFailure>()),
      );
    }
  });
  test('unknown full length stays unknown and 416 requires valid total', () {
    expect(
      MediaResponseValidator.validate(
        statusCode: 200,
        headers: {'content-type': 'audio/mpeg'},
      ).expectedLength,
      isNull,
    );
    expect(
      MediaResponseValidator.validate(
        statusCode: 416,
        headers: {'content-range': 'bytes */256'},
        range: ByteRange(start: 256),
      ).totalLength,
      256,
    );
    expect(
      () => MediaResponseValidator.validate(
        statusCode: 416,
        headers: {},
        range: ByteRange(start: 256),
      ),
      throwsA(isA<AppFailure>()),
    );
  });
  for (final mime in [
    'text/html',
    'application/json',
    'application/vnd.apple.mpegurl',
    'application/dash+xml',
  ]) {
    test(
      'reject non-progressive MIME $mime',
      () => expect(
        () => MediaResponseValidator.validate(
          statusCode: 200,
          headers: {'content-type': mime},
        ),
        throwsA(isA<AppFailure>()),
      ),
    );
  }
}
