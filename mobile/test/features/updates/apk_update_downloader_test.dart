import 'dart:async';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/features/updates/apk_update_downloader.dart';
import 'package:soundspan/features/updates/mobile_release_manifest.dart';

import '../../support/fake_tls_server.dart';
import '../../support/update_fixtures.dart';

void main() {
  late Directory directory;
  late FakeTlsServer server;
  final bytes = List<int>.generate(4096, (i) => i % 251);
  setUp(
    () async =>
        directory = await Directory('D:/CodexData/temp/d31').createTemp('apk-'),
  );
  tearDown(() async {
    await server.close();
    await directory.delete(recursive: true);
  });
  MobileReleaseManifest manifest({String? hash, int? size}) =>
      MobileReleaseManifest.decode(
        releaseDto(
          hash: hash ?? sha256.convert(bytes).toString(),
          bytes: size ?? bytes.length,
        ),
        origin: server.origin,
      );
  ApkUpdateDownloader downloader({
    Future<void> Function()? admit,
    int free = 1024 * 1024 * 1024,
    Duration idle = const Duration(seconds: 2),
    Duration total = const Duration(seconds: 5),
  }) => ApkUpdateDownloader(
    directory: directory,
    admit: admit ?? () async {},
    readFreeBytes: () async => free,
    createClient: () => HttpClient(context: server.clientContext),
    idleTimeout: idle,
    totalTimeout: total,
  );
  test(
    'explicit preparation recovers only owned files left by process death',
    () async {
      server = await FakeTlsServer.start((r) async {
        await r.response.close();
      });
      final first = File('${directory.path}/${'a' * 32}.apk');
      final partial = File('${directory.path}/${'b' * 32}.part');
      await first.writeAsBytes([1]);
      await partial.writeAsBytes([2]);
      await downloader().prepare();
      expect(directory.listSync(), isEmpty);
      final unrelated = File('${directory.path}/unrelated.txt');
      await unrelated.writeAsString('keep');
      await first.writeAsBytes([1]);
      await expectLater(downloader().prepare(), throwsA(anything));
      expect(await unrelated.readAsString(), 'keep');
      expect(await first.exists(), isTrue);
    },
  );
  test(
    'real TLS download streams exact bytes/hash without credentials',
    () async {
      server = await FakeTlsServer.start((r) async {
        expect(r.headers.value('authorization'), isNull);
        expect(r.headers.value('cookie'), isNull);
        r.response.contentLength = bytes.length;
        r.response.add(bytes);
        await r.response.close();
      });
      final result = await downloader().download(
        manifest(),
        isCurrent: () => true,
        cancellation: UpdateCancellation(),
      );
      expect(
        await File('${directory.path}/${result.id}.apk').readAsBytes(),
        bytes,
      );
      expect(directory.listSync().length, 1);
    },
  );
  for (final kind in ['redirect', 'hash', 'short', 'extra', 'low disk']) {
    test('$kind leaves no partial or verified APK', () async {
      var requests = 0;
      server = await FakeTlsServer.start((r) async {
        requests++;
        if (kind == 'redirect') {
          r.response.statusCode = 302;
          r.response.headers.set('location', '/other');
        } else {
          r.response.add(
            kind == 'short'
                ? bytes.sublist(0, 3)
                : kind == 'extra'
                ? [...bytes, 1]
                : bytes,
          );
        }
        await r.response.close();
      });
      await expectLater(
        downloader(
          free: kind == 'low disk' ? 100 : 1024 * 1024 * 1024,
        ).download(
          manifest(hash: kind == 'hash' ? List.filled(64, 'b').join() : null),
          isCurrent: () => true,
          cancellation: UpdateCancellation(),
        ),
        throwsA(anything),
      );
      expect(directory.listSync(), isEmpty);
      expect(requests, kind == 'low disk' ? 0 : 1);
    });
  }
  test(
    'cancel blocked response completes promptly and cleans its file',
    () async {
      final started = Completer<void>(), release = Completer<void>();
      server = await FakeTlsServer.start((r) async {
        started.complete();
        await release.future;
        try {
          await r.response.close();
        } catch (_) {}
      });
      final cancellation = UpdateCancellation();
      final pending = downloader().download(
        manifest(),
        isCurrent: () => true,
        cancellation: cancellation,
      );
      final assertion = expectLater(pending, throwsA(anything));
      await started.future;
      cancellation.cancel();
      await assertion.timeout(const Duration(seconds: 1));
      release.complete();
      expect(directory.listSync(), isEmpty);
    },
  );
  test('late owner on final admission cannot publish file', () async {
    server = await FakeTlsServer.start((r) async {
      r.response.add(bytes);
      await r.response.close();
    });
    var current = true, admissions = 0;
    await expectLater(
      downloader(
        admit: () async {
          if (++admissions >= 2) current = false;
        },
      ).download(
        manifest(),
        isCurrent: () => current,
        cancellation: UpdateCancellation(),
      ),
      throwsA(anything),
    );
    expect(directory.listSync(), isEmpty);
  });
  test('blocked body obeys bounded idle deadline', () async {
    final release = Completer<void>();
    server = await FakeTlsServer.start((r) async {
      r.response.add([1]);
      await r.response.flush();
      await release.future;
      try {
        await r.response.close();
      } catch (_) {}
    });
    try {
      await expectLater(
        downloader(idle: const Duration(milliseconds: 80)).download(
          manifest(),
          isCurrent: () => true,
          cancellation: UpdateCancellation(),
        ),
        throwsA(anything),
      ).timeout(const Duration(seconds: 1));
      expect(directory.listSync(), isEmpty);
    } finally {
      release.complete();
    }
  });
}
