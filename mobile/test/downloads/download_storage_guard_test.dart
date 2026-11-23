import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/downloads/automatic_download_control.dart';
import 'package:soundspan/downloads/device_storage_guard.dart';
import 'package:soundspan/downloads/download_models.dart';

import 'download_fixture.dart';

void main() {
  const reserve = 256 * 1024 * 1024;
  test(
    'reserve includes two concurrent bounded writes and accepts boundary',
    () async {
      var available = reserve + 200;
      final guard = DeviceStorageGuard(readFreeBytes: () async => available);
      await guard.requireSpace(100);
      available--;
      await expectLater(
        guard.requireSpace(100),
        throwsA(
          isA<FileSystemException>().having(
            (e) => e.osError?.errorCode,
            'ENOSPC',
            28,
          ),
        ),
      );
    },
  );
  for (final value in [null, -1, '9999999999', true, 3.14]) {
    test('malformed native capacity $value fails closed', () async {
      final guard = DeviceStorageGuard(readFreeBytes: () async => value);
      await expectLater(
        guard.requireSpace(1),
        throwsA(isA<FileSystemException>()),
      );
    });
  }
  test('probe errors fail closed without exposing platform details', () async {
    final guard = DeviceStorageGuard(
      readFreeBytes: () async =>
          throw PlatformException(code: 'private-platform-error'),
    );
    await expectLater(
      guard.requireSpace(1),
      throwsA(isA<FileSystemException>()),
    );
  });
  test('low capacity prevents audio write, pauses automation and retains existing file', () async {
    final h = await DownloadHarness.create();
    addTearDown(h.close);
    final existing = await h.repo.enqueue(
      DownloadHarness.track,
      'original',
      h.fence,
    );
    expect(
      await h.runner.run(existing.id, h.fence, existing.generation),
      DownloadRunResult.ready,
    );
    final file = (await h.repo.openReady(
      existing.track.ref,
      'original',
      h.fence,
    ))!;
    final original = await file.readAsBytes();
    var checks = 0;
    final guard = DeviceStorageGuard(
      readFreeBytes: () async {
        checks++;
        return reserve;
      },
    );
    final runner = h.newRunner(h.repo, beforeWrite: guard.requireSpace);
    addTearDown(runner.close);
    final job = await h.repo.enqueue(
      const Track(
        ref: LibraryTrackRef('new-file'),
        title: 'New',
        artist: 'Test',
      ),
      'original',
      h.fence,
      manual: false,
    );
    expect(
      await runner.run(job.id, h.fence, job.generation),
      DownloadRunResult.retry,
    );
    expect(checks, 1);
    final failed = (await h.repo.status(job.id, h.fence))!;
    expect(failed.errorCode, 'download_storage_full');
    expect(failed.bytes, 0);
    final control = await h.store.transaction(
      h.fence,
      (tx) => tx.read(
        AutomaticDownloadControl.namespace,
        AutomaticDownloadControl.key,
      ),
    );
    expect(AutomaticDownloadControl.paused(control), isTrue);
    expect(await file.readAsBytes(), original);
    expect(
      await h.repo.openReady(existing.track.ref, 'original', h.fence),
      isNotNull,
    );
  });
  test(
    'low capacity also blocks recovery copy without deleting verified orphan',
    () async {
      final h = await DownloadHarness.create();
      addTearDown(h.close);
      final job = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
      );
      h.store.failState = 'ready';
      await h.runner.run(job.id, h.fence, job.generation);
      h.store.failState = null;
      final old = (await h.repo.status(job.id, h.fence))!;
      final checkpoint = old.checkpoint!;
      expect(checkpoint.sha256, isNotNull);
      final file = await h.paths.file(
        h.fence.owner,
        job.id,
        checkpoint.generation,
        checkpoint.claim,
        ready: true,
      );
      final bytes = await file.readAsBytes();
      final requests = h.requests.length;
      final guard = DeviceStorageGuard(readFreeBytes: () async => reserve);
      final runner = h.newRunner(h.repo, beforeWrite: guard.requireSpace);
      addTearDown(runner.close);
      final retry = await h.repo.retry(job.id, h.fence);
      expect(
        await runner.run(retry.id, h.fence, retry.generation),
        DownloadRunResult.retry,
      );
      expect(h.requests.length, requests);
      expect(await file.readAsBytes(), bytes);
      expect(
        (await h.repo.status(retry.id, h.fence))!.errorCode,
        'download_storage_full',
      );
    },
  );
  test('owner retirement during capacity probe prevents file writes', () async {
    final h = await DownloadHarness.create();
    addTearDown(h.close);
    final job = await h.repo.enqueue(
      DownloadHarness.track,
      'original',
      h.fence,
    );
    final fence = h.fence;
    final runner = h.newRunner(
      h.repo,
      beforeWrite: (_) => h.authority.invalidate(),
    );
    addTearDown(runner.close);
    expect(
      await runner.run(job.id, fence, job.generation),
      DownloadRunResult.cancelled,
    );
    final files = await h.root
        .list(recursive: true)
        .where((entity) => entity is File)
        .cast<File>()
        .toList();
    for (final file in files) {
      expect(await file.length(), 0);
    }
  });
}
