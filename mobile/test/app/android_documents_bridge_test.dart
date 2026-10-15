import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/app/native_documents.dart';
import 'package:soundspan/core/model/app_failure.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('soundspan/documents');
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  setUp(() => debugDefaultTargetPlatformOverride = TargetPlatform.android);
  tearDown(() {
    debugDefaultTargetPlatformOverride = null;
    messenger.setMockMethodCallHandler(channel, null);
  });

  test(
    'Android preserves original M3U basename and exact UTF8 bytes',
    () async {
      messenger.setMockMethodCallHandler(channel, (call) async {
        expect(call.method, 'pick');
        expect(call.arguments, {'kind': 'playlist'});
        return {
          'name': 'Кино.m3u8',
          'bytes': Uint8List.fromList(
            utf8.encode('#EXTM3U\n/music/test.mp3\n'),
          ),
        };
      });
      final result = await NativeDocuments().pickPlaylist(
        isCurrent: () => true,
      );
      expect(result!.name, 'Кино');
      expect(result.content, '#EXTM3U\n/music/test.mp3\n');
    },
  );

  test('native Back returns no selection for either kind', () async {
    final kinds = <String>[];
    messenger.setMockMethodCallHandler(channel, (call) async {
      kinds.add((call.arguments as Map)['kind'] as String);
      return null;
    });
    final documents = NativeDocuments();
    expect(await documents.pickAvatar(isCurrent: () => true), isNull);
    expect(await documents.pickPlaylist(isCurrent: () => true), isNull);
    expect(kinds, ['image', 'playlist']);
  });

  test('provider exception never exposes URI or provider message', () async {
    messenger.setMockMethodCallHandler(channel, (_) async {
      throw PlatformException(
        code: 'provider',
        message: 'content://private/secret',
        details: '/secret/path',
      );
    });
    await expectLater(
      NativeDocuments().pickPlaylist(isCurrent: () => true),
      throwsA(
        isA<AppFailure>()
            .having((e) => e.code, 'code', 'document_picker_failed')
            .having((e) => e.message.contains('secret'), 'sanitized', false),
      ),
    );
  });

  test('malformed native reply fails closed', () async {
    messenger.setMockMethodCallHandler(
      channel,
      (_) async => {'name': 'x.m3u', 'bytes': 'bad'},
    );
    await expectLater(
      NativeDocuments().pickPlaylist(isCurrent: () => true),
      throwsA(isA<AppFailure>()),
    );
  });

  test('Dart independently rejects an oversized bridge reply', () async {
    messenger.setMockMethodCallHandler(
      channel,
      (_) async => {'name': 'x.m3u', 'bytes': Uint8List(512 * 1024 + 1)},
    );
    await expectLater(
      NativeDocuments().pickPlaylist(isCurrent: () => true),
      throwsA(
        isA<AppFailure>().having(
          (e) => e.code,
          'code',
          'playlist_file_too_large',
        ),
      ),
    );
  });

  test('owner change during native chooser rejects late selection', () async {
    final pending = Completer<Object?>();
    var current = true;
    messenger.setMockMethodCallHandler(channel, (_) => pending.future);
    final selection = NativeDocuments().pickPlaylist(isCurrent: () => current);
    current = false;
    pending.complete({
      'name': 'x.m3u',
      'bytes': Uint8List.fromList(utf8.encode('#EXTM3U')),
    });
    await expectLater(
      selection,
      throwsA(isA<AppFailure>().having((e) => e.code, 'code', 'stale_session')),
    );
  });
}
