import 'dart:async';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/session/credential_vault.dart';
import 'package:soundspan/core/session/session_authority.dart';
import 'package:soundspan/downloads/download_checkpoint.dart';
import 'package:soundspan/downloads/download_models.dart';

import 'download_fixture.dart';

void main() {
  late DownloadHarness h;
  setUp(() async {
    h = await DownloadHarness.create();
  });
  tearDown(() async {
    await h.close();
  });
  Future<DeviceDownload> seed({
    String? etag = '"v1"',
    bool verified = false,
    bool renamed = false,
    bool release = true,
  }) async {
    final j = await h.repo.enqueue(DownloadHarness.track, 'original', h.fence);
    final claim = (await h.repo.claim(j.id, h.fence, j.generation))!;
    final bytes = verified ? wavBytes() : wavBytes().sublist(0, 1000);
    final file = await h.paths.file(
      h.fence.owner,
      j.id,
      j.generation,
      claim.writer!,
      ready: renamed,
    );
    await file.writeAsBytes(bytes, flush: true);
    await h.repo.updateClaim(
      claim,
      state: verified ? DownloadState.verifying : DownloadState.downloading,
      checkpoint: DownloadCheckpoint(
        generation: j.generation,
        claim: claim.writer!,
        bytes: bytes.length,
        totalBytes: wavBytes().length,
        strongEtag: etag,
        sha256: verified ? sha256.convert(bytes).toString() : null,
      ),
    );
    if (release) return h.repo.pause(j.id, h.fence);
    return claim;
  }

  test('resume uses strong If-Range and only remaining bytes', () async {
    final j = await seed();
    final next = await h.repo.resume(j.id, h.fence);
    expect(
      await h.runner.run(next.id, h.fence, next.generation),
      DownloadRunResult.ready,
    );
    expect(h.requests, ['bytes=1000-']);
    expect(h.validators, ['"v1"']);
    expect(
      await (await h.repo.openReady(
        DownloadHarness.track.ref,
        'original',
        h.fence,
      ))!.readAsBytes(),
      wavBytes(),
    );
  });
  for (final mode in [
    'changed',
    'ignored',
    'wrong-start',
    'changed-total',
    'weak',
    'missing',
  ]) {
    test('resume $mode never concatenates changed representations', () async {
      final j = await seed(
        etag: mode == 'missing' || mode == 'weak' ? null : '"v1"',
      );
      h.handler = (r) => h.send(
        r,
        etag: mode == 'changed'
            ? '"v2"'
            : mode == 'weak'
            ? 'W/"v1"'
            : mode == 'missing'
            ? null
            : '"v1"',
        ignoreRange: mode == 'ignored',
        wrongStart: mode == 'wrong-start' ? 2 : null,
        bytes: mode == 'changed-total' ? wavBytes(20000) : null,
      );
      final next = await h.repo.resume(j.id, h.fence);
      await h.runner.run(next.id, h.fence, next.generation);
      final f = await h.repo.openReady(
        DownloadHarness.track.ref,
        'original',
        h.fence,
      );
      expect(f, isNotNull);
      expect(
        await f!.readAsBytes(),
        mode == 'changed-total' ? wavBytes(20000) : wavBytes(),
      );
      expect(h.requests.last, mode == 'ignored' ? 'bytes=1000-' : null);
    });
  }
  for (final renamed in [false, true]) {
    test(
      'process loss recovers verified ${renamed ? 'renamed orphan' : 'part'} with zero HTTP',
      () async {
        final j = await seed(verified: true, renamed: renamed, release: false);
        h.currentTime = h.currentTime.add(const Duration(seconds: 31));
        final other = h.newRunner(h.newRepository());
        expect(
          await other.run(j.id, h.fence, j.generation),
          DownloadRunResult.ready,
        );
        expect(h.requests, isEmpty);
        expect(
          await h.repo.openReady(
            DownloadHarness.track.ref,
            'original',
            h.fence,
          ),
          isNotNull,
        );
        await expectLater(h.repo.heartbeat(j), throwsA(anything));
        await other.close();
      },
    );
  }
  test(
    'live claim excludes second engine and expired old writer cannot publish',
    () async {
      final old = await seed(release: false);
      final other = h.newRepository();
      expect(await other.claim(old.id, h.fence, old.generation), isNull);
      h.currentTime = h.currentTime.add(const Duration(seconds: 31));
      final newer = (await other.claim(old.id, h.fence, old.generation))!;
      expect(newer.writer, isNot(old.writer));
      await expectLater(
        h.repo.updateClaim(old, state: DownloadState.ready, release: true),
        throwsA(anything),
      );
      expect((await other.status(old.id, h.fence))!.writer, newer.writer);
    },
  );
  test(
    'worker retry after transient failed ready SQL reclaims original job',
    () async {
      final j = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
      );
      h.store.failState = 'ready';
      expect(
        await h.runner.run(j.id, h.fence, j.generation),
        DownloadRunResult.retry,
      );
      h.store.failState = null;
      expect(
        await h.runner.run(j.id, h.fence, j.generation),
        DownloadRunResult.ready,
      );
      expect(h.requests.length, 1);
    },
  );
  test(
    'same-owner ABA and other owner never admit original delivery',
    () async {
      final oldFence = h.fence;
      final j = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        oldFence,
      );
      await h.authority.invalidate();
      await h.authority.establish(
        OwnerKey(serverOrigin: h.server.origin, userId: 'B'),
        const TokenPair(accessToken: 'b', refreshToken: 'b-r'),
      );
      expect(await h.repo.list(h.fence), isEmpty);
      await h.authority.invalidate();
      await h.authority.establish(
        oldFence.owner,
        const TokenPair(accessToken: 'new-a', refreshToken: 'new-a-r'),
      );
      await h.runner.run(j.id, oldFence, j.generation);
      await h.runner.run(j.id, h.fence, j.generation);
      expect(h.requests, isEmpty);
      final fresh = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
      );
      expect(fresh.generation, greaterThan(j.generation));
      expect(
        await h.runner.run(fresh.id, h.fence, fresh.generation),
        DownloadRunResult.ready,
      );
    },
  );
  test('logout during media probe prevents ready row', () async {
    final f = h.fence;
    final j = await h.repo.enqueue(DownloadHarness.track, 'original', f);
    h.probe.before = () => h.authority.invalidate();
    expect(
      await h.runner.run(j.id, f, j.generation),
      DownloadRunResult.cancelled,
    );
    expect(h.store.rows.values.where((v) => v['state'] == 'ready'), isEmpty);
  });
  test('remove keeps same-generation deletion intent when download becomes ready during barrier', () async {
    final probeEntered = Completer<void>();
    final probeRelease = Completer<void>();
    final removeEntered = Completer<void>();
    final removeRelease = Completer<void>();
    h.probe.before = () async {
      probeEntered.complete();
      await probeRelease.future;
    };
    h.beforeRemove = (_) async {
      removeEntered.complete();
      await removeRelease.future;
    };
    final j = await h.repo.enqueue(DownloadHarness.track, 'original', h.fence);
    final running = h.runner.run(j.id, h.fence, j.generation);
    await probeEntered.future;
    final removing = h.repo.remove(j.id, h.fence);
    await removeEntered.future;
    probeRelease.complete();
    expect(await running, DownloadRunResult.ready);
    final ready = (await h.repo.status(j.id, h.fence))!;
    expect(ready.generation, j.generation);
    expect(ready.writer, isNull);
    final file = (await h.repo.openReady(
      DownloadHarness.track.ref,
      'original',
      h.fence,
    ))!;
    removeRelease.complete();
    await removing;
    expect(
      await h.repo.openReady(DownloadHarness.track.ref, 'original', h.fence),
      isNull,
    );
    expect((await h.repo.status(j.id, h.fence))!.state, DownloadState.removing);
    expect(await file.exists(), false);
    expect(
      await h.root.list(recursive: true).where((e) => e is File).toList(),
      isEmpty,
    );
    h.beforeRemove = null;
    await h.repo.remove(j.id, h.fence);
    expect(await h.repo.list(h.fence), isEmpty);
  });
  test('remove requires a fresh release barrier for a reclaimed writer in same generation', () async {
    final original = await seed(release: false);
    final removeEntered = Completer<void>();
    final removeRelease = Completer<void>();
    h.beforeRemove = (_) async {
      removeEntered.complete();
      await removeRelease.future;
    };
    final removing = h.repo.remove(original.id, h.fence);
    final rejected = expectLater(
      removing,
      throwsA(
        isA<AppFailure>().having(
          (failure) => failure.code,
          'code',
          'download_in_use',
        ),
      ),
    );
    await removeEntered.future;
    h.currentTime = h.currentTime.add(const Duration(seconds: 31));
    final other = h.newRepository();
    final reclaimed = (await other.claim(
      original.id,
      h.fence,
      original.generation,
    ))!;
    expect(reclaimed.writer, isNot(original.writer));
    expect(reclaimed.generation, original.generation);
    expect(reclaimed.files, hasLength(2));
    final newPart = await h.paths.file(
      h.fence.owner,
      reclaimed.id,
      reclaimed.generation,
      reclaimed.writer!,
    );
    await newPart.writeAsBytes(wavBytes().sublist(0, 1000), flush: true);
    // The new part exists before its first checkpoint commit. Only the current
    // manifest, not either snapshot's checkpoint, identifies this allocation.
    expect(reclaimed.checkpoint!.claim, original.writer);
    expect(
      await h.root.list(recursive: true).where((e) => e is File).toList(),
      hasLength(2),
    );
    removeRelease.complete();
    await rejected;
    expect(
      (await h.repo.status(original.id, h.fence))!.state,
      DownloadState.downloading,
    );
    expect(await newPart.exists(), isTrue);
    await other.heartbeat(reclaimed);
    h.beforeRemove = (current) async {
      expect(current.files, hasLength(2));
      expect(current.writer, reclaimed.writer);
    };
    await h.repo.remove(original.id, h.fence);
    expect(
      (await h.repo.status(original.id, h.fence))!.state,
      DownloadState.removing,
    );
    expect(
      await h.root.list(recursive: true).where((e) => e is File).toList(),
      isEmpty,
    );
    await expectLater(other.heartbeat(reclaimed), throwsA(anything));
    h.beforeRemove = null;
    await h.repo.remove(original.id, h.fence);
    expect(await h.repo.list(h.fence), isEmpty);
  });
  test('late remove callback cannot delete retried replacement', () async {
    final j = await h.repo.enqueue(DownloadHarness.track, 'original', h.fence);
    final gate = Completer<void>();
    final entered = Completer<void>();
    h.beforeRemove = (_) async {
      entered.complete();
      await gate.future;
    };
    final removing = h.repo.remove(j.id, h.fence);
    await entered.future;
    final newer = await h.repo.retry(j.id, h.fence);
    await h.runner.run(newer.id, h.fence, newer.generation);
    gate.complete();
    await removing;
    expect(
      await h.repo.openReady(DownloadHarness.track.ref, 'original', h.fence),
      isNotNull,
    );
  });
  test(
    'ready removal calls playback barrier before deleting and is repeatable',
    () async {
      final j = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
      );
      await h.runner.run(j.id, h.fence, j.generation);
      final file = (await h.repo.openReady(
        DownloadHarness.track.ref,
        'original',
        h.fence,
      ))!;
      h.beforeRemove = (_) async {
        expect(await file.exists(), true);
      };
      await h.repo.remove(j.id, h.fence);
      expect(await file.exists(), false);
      h.beforeRemove = null;
      await h.repo.remove(j.id, h.fence);
      expect(await h.repo.list(h.fence), isEmpty);
    },
  );
  test(
    'unknown length requires clean EOF and actual WAV structure probe',
    () async {
      h.handler = (r) => h.send(r, chunked: true);
      final j = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
      );
      expect(
        await h.runner.run(j.id, h.fence, j.generation),
        DownloadRunResult.ready,
      );
    },
  );
  test(
    'terminal delivery is idempotent and cancelled delivery reports cancelled',
    () async {
      final j = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
      );
      await h.runner.run(j.id, h.fence, j.generation);
      expect(
        await h.runner.run(j.id, h.fence, j.generation),
        DownloadRunResult.ready,
      );
      expect(h.requests.length, 1);
      await h.repo.remove(j.id, h.fence);
      expect(
        await h.runner.run(j.id, h.fence, j.generation),
        DownloadRunResult.cancelled,
      );
    },
  );
  test(
    'remove cleans every managed claim after resume and crash recovery',
    () async {
      final paused = await seed();
      final next = await h.repo.resume(paused.id, h.fence);
      await h.runner.run(next.id, h.fence, next.generation);
      expect(
        (await h.root.list(recursive: true).where((e) => e is File).toList())
            .length,
        greaterThan(1),
      );
      await h.repo.remove(next.id, h.fence);
      expect(
        await h.root.list(recursive: true).where((e) => e is File).toList(),
        isEmpty,
      );
    },
  );
  test(
    'paused blocked transfer releases socket quota for immediate retry',
    () async {
      final sent = Completer<void>();
      h.handler = (r) async {
        if (h.requests.length > 1) {
          await h.send(r);
          return;
        }
        r.response.headers.set('content-type', 'audio/wav');
        r.response.headers.set('etag', '"v1"');
        r.response.contentLength = wavBytes().length;
        r.response.add(wavBytes().sublist(0, 1000));
        await r.response.flush();
        sent.complete();
        await r.response.done;
      };
      final j = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
      );
      final first = h.runner.run(j.id, h.fence, j.generation);
      await sent.future;
      await h.repo.pause(j.id, h.fence);
      expect(
        await first.timeout(const Duration(seconds: 3)),
        DownloadRunResult.cancelled,
      );
      final next = await h.repo.resume(j.id, h.fence);
      expect(
        await h.runner.run(next.id, h.fence, next.generation),
        DownloadRunResult.ready,
      );
    },
  );
  test('two simultaneous pause commands are idempotent', () async {
    final j = await h.repo.enqueue(DownloadHarness.track, 'original', h.fence);
    await h.repo.pause(j.id, h.fence);
    final once = (await h.repo.status(j.id, h.fence))!;
    await h.repo.pause(j.id, h.fence);
    expect((await h.repo.status(j.id, h.fence))!.generation, once.generation);
  });
  test(
    'closing coordinator while claim admission is pending prevents HTTP',
    () async {
      final j = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
      );
      final pending = h.runner.run(j.id, h.fence, j.generation);
      await h.runner.close();
      expect(await pending, DownloadRunResult.cancelled);
      expect(h.requests, isEmpty);
    },
  );
  test(
    'close drains pending probe and revoked writer before returning',
    () async {
      final gate = Completer<void>();
      final entered = Completer<void>();
      h.probe.before = () async {
        entered.complete();
        await gate.future;
      };
      final j = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
      );
      final running = h.runner.run(j.id, h.fence, j.generation);
      await entered.future;
      var closed = false;
      final closing = h.runner.close().then((_) {
        closed = true;
      });
      await Future<void>.delayed(Duration.zero);
      expect(closed, false);
      gate.complete();
      await closing;
      expect(await running, DownloadRunResult.cancelled);
      final settled = (await h.repo.status(j.id, h.fence))!;
      expect(settled.writer, isNull);
      expect(settled.state, DownloadState.paused);
      expect(
        await h.repo.openReady(DownloadHarness.track.ref, 'original', h.fence),
        isNull,
      );
      final records = h.store.rows.toString();
      await Future<void>.delayed(Duration.zero);
      expect(h.store.rows.toString(), records);
    },
  );
  test('offlineValidated restored credentials still download when explicit network policy is online', () async {
    final f = h.fence;
    await h.authority.restore(f.owner.serverOrigin);
    expect(h.authority.state.status, SessionStatus.offlineValidated);
    final j = await h.repo.enqueue(DownloadHarness.track, 'original', f);
    expect(await h.runner.run(j.id, f, j.generation), DownloadRunResult.ready);
    expect(h.requests.length, 1);
  });
  test(
    'download quality matches shared protected transport allowlist',
    () async {
      final lossless = await h.repo.enqueue(
        DownloadHarness.track,
        'lossless',
        h.fence,
      );
      expect(
        await h.runner.run(lossless.id, h.fence, lossless.generation),
        DownloadRunResult.ready,
      );
      await expectLater(
        h.repo.enqueue(DownloadHarness.track, 'NORMAL', h.fence),
        throwsArgumentError,
      );
    },
  );
  test(
    'corrupt ready becomes retryable without exposing changed bytes',
    () async {
      final j = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
      );
      await h.runner.run(j.id, h.fence, j.generation);
      final file = (await h.repo.openReady(
        DownloadHarness.track.ref,
        'original',
        h.fence,
      ))!;
      await file.writeAsBytes([0, 1, 2]);
      expect(
        await h.repo.openReady(DownloadHarness.track.ref, 'original', h.fence),
        isNull,
      );
      expect((await h.repo.status(j.id, h.fence))!.state, DownloadState.failed);
      final retry = await h.repo.retry(j.id, h.fence);
      await h.runner.run(retry.id, h.fence, retry.generation);
      expect(
        await h.repo.openReady(DownloadHarness.track.ref, 'original', h.fence),
        isNotNull,
      );
    },
  );
}
