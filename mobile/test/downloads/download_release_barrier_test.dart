import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/downloads/download_checkpoint.dart';
import 'package:soundspan/downloads/download_models.dart';

import 'download_fixture.dart';

void main() {
  for (final claimedBeforeRelease in [false, true]) {
    test(
      'remove ${claimedBeforeRelease ? 'accepts covered' : 'refuses uncovered'} ready claim created during release',
      () async {
        final h = await DownloadHarness.create();
        addTearDown(h.close);
        final job = await h.repo.enqueue(
          DownloadHarness.track,
          'original',
          h.fence,
        );
        DeviceDownload? claim;
        if (claimedBeforeRelease) {
          claim = await h.repo.claim(job.id, h.fence, job.generation);
        }
        final started = Completer<void>(), gate = Completer<void>();
        h.beforeRemove = (_) async {
          started.complete();
          await gate.future;
        };
        final deletion = h.repo.remove(
          job.id,
          h.fence,
          expectedGeneration: job.generation,
        );
        final result = claimedBeforeRelease
            ? deletion
            : expectLater(
                deletion,
                throwsA(
                  isA<AppFailure>().having(
                    (e) => e.code,
                    'code',
                    'download_in_use',
                  ),
                ),
              );
        await started.future;
        claim ??= (await h.repo.claim(job.id, h.fence, job.generation))!;
        final file = await h.paths.file(
          h.fence.owner,
          job.id,
          claim.generation,
          claim.writer!,
          ready: true,
        );
        await file.writeAsBytes(wavBytes());
        final verified = await h.repo.verifier.verify(file);
        await h.repo.updateClaim(
          claim,
          state: DownloadState.ready,
          release: true,
          checkpoint: DownloadCheckpoint(
            generation: claim.generation,
            claim: claim.writer!,
            bytes: verified.bytes,
            sha256: verified.sha256,
          ),
        );
        // The decoder may obtain this ready file while the old release awaits.
        expect(
          await h.repo.openReady(
            DownloadHarness.track.ref,
            'original',
            h.fence,
          ),
          isNotNull,
        );
        gate.complete();
        await result;
        expect(await file.exists(), !claimedBeforeRelease);
        expect(
          (await h.repo.status(job.id, h.fence))!.state,
          claimedBeforeRelease ? DownloadState.removing : DownloadState.ready,
        );
      },
    );
  }
}
