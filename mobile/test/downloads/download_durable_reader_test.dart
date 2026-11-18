import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/downloads/download_models.dart';

import 'download_fixture.dart';

void main() {
  test(
    'a durable reader from another repository prevents manual unlink',
    () async {
      final h = await DownloadHarness.create();
      addTearDown(h.close);
      final job = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
      );
      expect(
        await h.runner.run(job.id, h.fence, job.generation),
        DownloadRunResult.ready,
      );
      final ready = (await h.repo.status(job.id, h.fence))!;
      final cp = ready.checkpoint!;
      final file = (await h.repo.openReady(
        job.track.ref,
        job.quality,
        h.fence,
      ))!;
      final key = sha256
          .convert(utf8.encode(jsonEncode([job.id, cp.generation, cp.claim])))
          .toString();
      await h.store.transaction(
        h.fence,
        (tx) => tx.write('deviceMediaReaders.v1', key, {
          'version': 1,
          'downloadId': job.id,
          'file': cp.toJson(),
          'state': 'available',
          'readers': {'1' * 48: h.fence.epoch},
          'removal': null,
        }),
      );
      await expectLater(
        h.newRepository().remove(job.id, h.fence),
        throwsA(
          isA<AppFailure>().having((e) => e.code, 'code', 'download_in_use'),
        ),
      );
      expect(await file.exists(), isTrue);
      expect(
        (await h.repo.status(job.id, h.fence))!.state,
        DownloadState.ready,
      );
    },
  );
}
