import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/downloads/download_verifier.dart';
import 'package:soundspan/downloads/download_models.dart';

import 'download_fixture.dart';

void main() {
  for (final fault in ['full', 'permission', 'rename']) {
    test(
      'storage $fault failure stays inaccessible and retry recovers',
      () async {
        final io = FaultMediaIo()..fault = fault;
        final h = await DownloadHarness.create(io: io);
        try {
          final j = await h.repo.enqueue(
            DownloadHarness.track,
            'original',
            h.fence,
          );
          expect(
            await h.runner.run(j.id, h.fence, j.generation),
            DownloadRunResult.retry,
          );
          expect(
            await h.repo.openReady(
              DownloadHarness.track.ref,
              'original',
              h.fence,
            ),
            isNull,
          );
          expect(
            (await h.repo.status(j.id, h.fence))!.errorCode,
            fault == 'full'
                ? 'download_storage_full'
                : 'download_storage_error',
          );
          io.fault = null;
          expect(
            await h.runner.run(j.id, h.fence, j.generation),
            DownloadRunResult.ready,
          );
        } finally {
          await h.close();
        }
      },
    );
  }
  test(
    'cancellation after rename but before SQL never publishes ready',
    () async {
      final io = FaultMediaIo();
      final h = await DownloadHarness.create(io: io);
      try {
        final j = await h.repo.enqueue(
          DownloadHarness.track,
          'original',
          h.fence,
        );
        io.afterRename = () => h.repo.cancel(j.id, h.fence);
        expect(
          await h.runner.run(j.id, h.fence, j.generation),
          DownloadRunResult.cancelled,
        );
        expect(
          await h.repo.openReady(
            DownloadHarness.track.ref,
            'original',
            h.fence,
          ),
          isNull,
        );
        io.afterRename = null;
        final retry = await h.repo.retry(j.id, h.fence);
        expect(
          await h.runner.run(j.id, h.fence, retry.generation),
          DownloadRunResult.ready,
        );
      } finally {
        await h.close();
      }
    },
  );
  test(
    'verifier rejects expected length mismatch and undecodable container',
    () async {
      final root = await Directory.systemTemp.createTemp('t07-verify-');
      final file = File('${root.path}/audio.wav');
      final verifier = DownloadVerifier(probe: WavProbe());
      try {
        await file.writeAsBytes(wavBytes());
        await expectLater(
          verifier.verify(file, expectedBytes: 2),
          throwsA(anything),
        );
        await file.writeAsBytes(wavBytes().sublist(0, 80));
        await expectLater(verifier.verify(file), throwsA(anything));
      } finally {
        await root.delete(recursive: true);
      }
    },
  );
  test('managed paths reject stored traversal and linked file', () async {
    final h = await DownloadHarness.create();
    try {
      await expectLater(
        h.paths.file(h.fence.owner, '../outside', 1, 'a' * 48),
        throwsA(isA<FileSystemException>()),
      );
      final j = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
      );
      final claim = (await h.repo.claim(j.id, h.fence, j.generation))!;
      final file = await h.paths.file(
        h.fence.owner,
        j.id,
        j.generation,
        claim.writer!,
      );
      // A directory at the final filename is an escape/type attack too; works
      // without Windows symlink privileges and must never be opened/deleted.
      await Directory(file.path).create();
      await expectLater(
        h.paths.file(h.fence.owner, j.id, j.generation, claim.writer!),
        throwsA(isA<FileSystemException>()),
      );
    } finally {
      await h.close();
    }
  });
}
