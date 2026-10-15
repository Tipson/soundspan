import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:file_selector/file_selector.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/app/native_documents.dart';
import 'package:soundspan/core/model/app_failure.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('cancelled document selection does not fabricate a file', () async {
    final documents = NativeDocuments(open: (_) async => null);
    expect(await documents.pickPlaylist(isCurrent: () => true), isNull);
    expect(await documents.pickAvatar(isCurrent: () => true), isNull);
  });

  test(
    'selected UTF8 M3U keeps exact content and a safe default name',
    () async {
      const content = '#EXTM3U\n#EXTINF:180,Кино - Кукушка\n/music/track.mp3\n';
      final documents = NativeDocuments(
        open: (groups) async {
          expect(groups.single.extensions, containsAll(['m3u', 'm3u8']));
          return XFile.fromData(
            Uint8List.fromList(utf8.encode('\ufeff$content')),
            path: 'Мой плейлист.m3u8',
          );
        },
      );
      final picked = (await documents.pickPlaylist(isCurrent: () => true))!;
      expect(picked.content, content);
      expect(picked.name, 'Мой плейлист');
    },
  );

  test(
    'size checks bound the actual stream even when selected metadata lies',
    () async {
      final documents = NativeDocuments(open: (_) async => _LyingFile());
      await expectLater(
        documents.pickPlaylist(isCurrent: () => true),
        throwsA(
          isA<AppFailure>().having(
            (e) => e.code,
            'code',
            'playlist_file_too_large',
          ),
        ),
      );
    },
  );

  test(
    'malformed UTF8 is refused without replacing unreadable bytes',
    () async {
      final documents = NativeDocuments(
        open: (_) async => XFile.fromData(
          Uint8List.fromList([255, 254, 0, 1]),
          path: 'invalid.m3u',
        ),
      );
      await expectLater(
        documents.pickPlaylist(isCurrent: () => true),
        throwsA(
          isA<AppFailure>().having(
            (e) => e.code,
            'code',
            'invalid_playlist_file',
          ),
        ),
      );
    },
  );

  test('a late file picker cannot deliver a previous account photo', () async {
    final pending = Completer<XFile?>();
    var current = true;
    final documents = NativeDocuments(open: (_) => pending.future);
    final selection = documents.pickAvatar(isCurrent: () => current);
    final observed = expectLater(
      selection,
      throwsA(isA<AppFailure>().having((e) => e.code, 'code', 'stale_session')),
    );
    current = false;
    pending.complete(XFile.fromData(await _png(16, 16), path: 'photo.png'));
    await observed;
  });

  for (final size in [(1024, 256, 512, 128), (32, 64, 32, 64)]) {
    test('photo is resized without stretching or upscaling $size', () async {
      final photo = await _png(size.$1, size.$2);
      final documents = NativeDocuments(
        open: (_) async => XFile.fromData(photo, path: 'photo.png'),
      );
      final avatar = (await documents.pickAvatar(isCurrent: () => true))!;
      expect(avatar.width, size.$3);
      expect(avatar.height, size.$4);
      expect(avatar.mimeType, 'image/png');
      expect(avatar.filename, 'avatar.png');
      expect(avatar.bytes.length, lessThanOrEqualTo(5 * 1024 * 1024));
    });
  }

  test('an unsupported image is not disguised as an accepted PNG', () async {
    final documents = NativeDocuments(
      open: (_) async => XFile.fromData(
        Uint8List.fromList('GIF89a'.codeUnits),
        path: 'picture.gif',
      ),
    );
    await expectLater(
      documents.pickAvatar(isCurrent: () => true),
      throwsA(
        isA<AppFailure>().having((e) => e.code, 'code', 'invalid_avatar'),
      ),
    );
  });
}

class _LyingFile extends XFile {
  _LyingFile() : super('not-a-real-path');
  @override
  String get name => 'large.m3u';
  @override
  Future<int> length() async => 1;
  @override
  Stream<Uint8List> openRead([int? start, int? end]) async* {
    yield Uint8List(512 * 1024);
    yield Uint8List(1);
  }
}

Future<Uint8List> _png(int width, int height) async {
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder);
  canvas.drawColor(const ui.Color(0xff8b6cb1), ui.BlendMode.src);
  final picture = recorder.endRecording();
  final image = await picture.toImage(width, height);
  try {
    return (await image.toByteData(format: ui.ImageByteFormat.png))!.buffer
        .asUint8List();
  } finally {
    image.dispose();
    picture.dispose();
  }
}
