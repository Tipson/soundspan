import 'dart:async';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/storage/owner_store.dart';
import 'package:soundspan/downloads/download_checkpoint.dart';
import 'package:soundspan/downloads/download_models.dart';
import 'package:soundspan/downloads/download_repository.dart';
import 'package:soundspan/downloads/download_verifier.dart';
import 'package:soundspan/downloads/private_media_paths.dart';

import 'download_fixture.dart';

const window = 256 * 1024;

final class CountIo implements PrivateMediaIo {
  final opened = Completer<void>();
  final sizes = <int>[];
  int flushes = 0;
  bool failFlush = false;
  @override
  Future<RandomAccessFile> openWrite(File file, {required bool append}) async {
    final real = await const NativePrivateMediaIo().openWrite(
      file,
      append: append,
    );
    if (!opened.isCompleted) opened.complete();
    return CountFile(real, this);
  }

  @override
  Future<void> rename(File source, File target) =>
      const NativePrivateMediaIo().rename(source, target);
}

final class CountFile implements RandomAccessFile {
  CountFile(this.real, this.count);
  final RandomAccessFile real;
  final CountIo count;
  @override
  Future<RandomAccessFile> writeFrom(
    List<int> bytes, [
    int start = 0,
    int? end,
  ]) async {
    count.sizes.add((end ?? bytes.length) - start);
    await real.writeFrom(bytes, start, end);
    return this;
  }

  @override
  Future<RandomAccessFile> flush() async {
    count.flushes++;
    if (count.failFlush) {
      throw const FileSystemException('injected flush failure');
    }
    await real.flush();
    return this;
  }

  @override
  Future<int> position() => real.position();
  @override
  Future<void> close() => real.close();
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

final class CountStore implements OwnerStore {
  CountStore(this.real);
  final OwnerStore real;
  int transactions = 0;
  final advancingBytes = <int>[];
  @override
  Future<T> transaction<T>(
    SessionFence fence,
    Future<T> Function(OwnerTransaction) operation,
  ) {
    transactions++;
    return real.transaction(
      fence,
      (tx) => operation(CountTx(tx, advancingBytes)),
    );
  }
}

final class CountTx implements OwnerTransaction {
  CountTx(this.real, this.advancingBytes);
  final OwnerTransaction real;
  final List<int> advancingBytes;
  @override
  Future<Map<String, Object?>?> read(String namespace, String key) =>
      real.read(namespace, key);
  @override
  Future<void> write(String namespace, String key, Map<String, Object?> value) {
    if (namespace == DownloadRepository.namespace &&
        value['checkpoint'] is Map) {
      final bytes = (value['checkpoint'] as Map)['bytes'] as int;
      if (advancingBytes.isEmpty || bytes > advancingBytes.last) {
        advancingBytes.add(bytes);
      }
    }
    return real.write(namespace, key, value);
  }

  @override
  Future<void> remove(String namespace, String key) =>
      real.remove(namespace, key);
  @override
  Future<List<OwnerRecord>> list(
    String namespace, {
    String? afterKey,
    int limit = 100,
  }) => real.list(namespace, afterKey: afterKey, limit: limit);
}

List<int> payload(int bytes) => wavBytes((bytes - 44) ~/ 2);

Future<void> serve(
  HttpRequest request,
  List<int> bytes, {
  bool chunked = false,
}) async {
  request.response.headers.set('content-type', 'audio/wav');
  request.response.headers.set('etag', '"v1"');
  if (!chunked) request.response.contentLength = bytes.length;
  for (var start = 0; start < bytes.length; start += 8192) {
    final end = start + 8192 < bytes.length ? start + 8192 : bytes.length;
    request.response.add(bytes.sublist(start, end));
    await request.response.flush();
    await Future<void>.delayed(Duration.zero);
  }
  await request.response.close();
}

void main() {
  test(
    'one MiB in 8KiB fragments has four bounded writes and durable windows',
    () async {
      final io = CountIo();
      final h = await DownloadHarness.create(io: io);
      addTearDown(h.close);
      final store = CountStore(h.store);
      final repo = DownloadRepository(
        store: store,
        authority: h.authority,
        paths: h.paths,
        verifier: DownloadVerifier(probe: h.probe),
        beforeRemove: (_) async {},
        clock: () => h.currentTime,
      );
      final bytes = payload(1024 * 1024);
      h.handler = (request) => serve(request, bytes);
      final runner = h.newRunner(repo);
      addTearDown(runner.close);
      final job = await repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
      );
      store.transactions = 0;
      expect(
        await runner.run(job.id, h.fence, job.generation),
        DownloadRunResult.ready,
      );
      final transferTransactions = store.transactions;
      final latest = (await repo.status(job.id, h.fence))!;
      expect(io.sizes, [window, window, window, window]);
      expect(io.flushes, 5);
      expect(store.advancingBytes, [
        0,
        window,
        2 * window,
        3 * window,
        4 * window,
      ]);
      expect(transferTransactions, lessThan(128));
      expect(latest.sha256, sha256.convert(bytes).toString());
      final file = (await repo.openReady(job.track.ref, 'original', h.fence))!;
      expect(await file.readAsBytes(), bytes);
    },
  );

  for (final chunked in [false, true]) {
    test(
      'EOF emits the final 1000 bytes immediately, chunked=$chunked',
      () async {
        final io = CountIo();
        final h = await DownloadHarness.create(io: io);
        addTearDown(h.close);
        final bytes = payload(window + 1000);
        h.handler = (request) => serve(request, bytes, chunked: chunked);
        final job = await h.repo.enqueue(
          DownloadHarness.track,
          'original',
          h.fence,
        );
        expect(
          await h.runner.run(job.id, h.fence, job.generation),
          DownloadRunResult.ready,
        );
        expect(io.sizes, [window, 1000]);
        expect(io.flushes, 3);
        expect(
          (await h.repo.status(job.id, h.fence))!.sha256,
          sha256.convert(bytes).toString(),
        );
      },
    );
  }

  for (final revokeOwner in [false, true]) {
    test(
      'cancel incomplete window writes nothing, revokeOwner=$revokeOwner',
      () async {
        final io = CountIo();
        final h = await DownloadHarness.create(io: io);
        addTearDown(h.close);
        final sent = Completer<void>();
        h.handler = (request) async {
          request.response.headers.set('content-type', 'audio/wav');
          request.response.headers.set('etag', '"v1"');
          request.response.contentLength = 1024 * 1024;
          request.response.add(payload(1024 * 1024).sublist(0, 64 * 1024));
          await request.response.flush();
          sent.complete();
          await request.response.done;
        };
        final fence = h.fence;
        final job = await h.repo.enqueue(
          DownloadHarness.track,
          'original',
          fence,
        );
        final pending = h.runner.run(job.id, fence, job.generation);
        await sent.future;
        await io.opened.future;
        await Future<void>.delayed(const Duration(milliseconds: 30));
        final writesBeforeCancel = List<int>.of(io.sizes);
        if (revokeOwner) {
          await h.authority.invalidate();
        } else {
          await h.repo.pause(job.id, fence);
        }
        expect(
          await pending.timeout(const Duration(seconds: 3)),
          DownloadRunResult.cancelled,
        );
        expect(writesBeforeCancel, isEmpty);
        expect(io.sizes, isEmpty);
        final files = await h.root
            .list(recursive: true)
            .where((e) => e is File)
            .cast<File>()
            .toList();
        for (final file in files) {
          expect(await file.length(), 0);
        }
      },
    );
  }

  test('cold reclaim copies committed prefix and discards uncommitted mid-window tail', () async {
    final h = await DownloadHarness.create();
    addTearDown(h.close);
    final bytes = payload(1024 * 1024);
    final job = await h.repo.enqueue(
      DownloadHarness.track,
      'original',
      h.fence,
    );
    final claim = (await h.repo.claim(job.id, h.fence, job.generation))!;
    final oldPart = await h.paths.file(
      h.fence.owner,
      job.id,
      job.generation,
      claim.writer!,
    );
    await oldPart.writeAsBytes([
      ...bytes.take(window),
      ...List<int>.filled(64 * 1024, 0x5a),
    ], flush: true);
    await h.repo.updateClaim(
      claim,
      checkpoint: DownloadCheckpoint(
        generation: job.generation,
        claim: claim.writer!,
        bytes: window,
        totalBytes: bytes.length,
        strongEtag: '"v1"',
      ),
    );
    h.currentTime = h.currentTime.add(const Duration(seconds: 31));
    h.handler = (request) => h.send(request, bytes: bytes);
    final runner = h.newRunner(h.newRepository());
    addTearDown(runner.close);
    expect(
      await runner.run(job.id, h.fence, job.generation),
      DownloadRunResult.ready,
    );
    expect(h.requests, ['bytes=$window-']);
    expect(h.validators, ['"v1"']);
    final file = (await h.repo.openReady(job.track.ref, 'original', h.fence))!;
    expect(await file.readAsBytes(), bytes);
    expect(
      (await h.repo.status(job.id, h.fence))!.sha256,
      sha256.convert(bytes).toString(),
    );
    expect(await oldPart.length(), window + 64 * 1024);
  });

  test(
    'resumed 416 restarts once without concatenating the old prefix',
    () async {
      final h = await DownloadHarness.create();
      addTearDown(h.close);
      final bytes = payload(1024 * 1024);
      final job = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
      );
      final claim = (await h.repo.claim(job.id, h.fence, job.generation))!;
      final part = await h.paths.file(
        h.fence.owner,
        job.id,
        job.generation,
        claim.writer!,
      );
      await part.writeAsBytes(bytes.sublist(0, 1000), flush: true);
      await h.repo.updateClaim(
        claim,
        checkpoint: DownloadCheckpoint(
          generation: job.generation,
          claim: claim.writer!,
          bytes: 1000,
          totalBytes: bytes.length,
          strongEtag: '"v1"',
        ),
      );
      await h.repo.pause(job.id, h.fence);
      h.handler = (request) async {
        if (h.requests.length == 1) {
          request.response.statusCode = 416;
          request.response.headers.set('content-range', 'bytes */1000');
          await request.response.close();
        } else {
          await serve(request, bytes);
        }
      };
      final resumed = await h.repo.resume(job.id, h.fence);
      expect(
        await h.runner.run(resumed.id, h.fence, resumed.generation),
        DownloadRunResult.ready,
      );
      expect(h.requests, ['bytes=1000-', null]);
      final file = (await h.repo.openReady(
        job.track.ref,
        'original',
        h.fence,
      ))!;
      expect(await file.readAsBytes(), bytes);
      expect(
        (await h.repo.status(job.id, h.fence))!.sha256,
        sha256.convert(bytes).toString(),
      );
    },
  );

  test('failed window flush cannot advance checkpoint and retry recovers exact file', () async {
    final io = CountIo()..failFlush = true;
    final h = await DownloadHarness.create(io: io);
    addTearDown(h.close);
    final bytes = payload(1024 * 1024);
    h.handler = (request) => serve(request, bytes);
    final job = await h.repo.enqueue(
      DownloadHarness.track,
      'original',
      h.fence,
    );
    expect(
      await h.runner.run(job.id, h.fence, job.generation),
      DownloadRunResult.retry,
    );
    expect((await h.repo.status(job.id, h.fence))!.checkpoint!.bytes, 0);
    io.failFlush = false;
    final retry = await h.repo.retry(job.id, h.fence);
    expect(
      await h.runner.run(retry.id, h.fence, retry.generation),
      DownloadRunResult.ready,
    );
    final file = (await h.repo.openReady(job.track.ref, 'original', h.fence))!;
    expect(await file.readAsBytes(), bytes);
    expect(h.requests, [null, null]);
  });
}
