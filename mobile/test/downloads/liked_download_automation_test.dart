import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/downloads/liked_download_automation.dart';
import 'package:soundspan/downloads/download_models.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/session/credential_vault.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/storage/owner_store.dart';
import 'package:soundspan/downloads/download_repository.dart';
import 'package:soundspan/features/likes/likes_repository.dart';
import 'package:soundspan/features/likes/likes_models.dart';

import '../support/collection_fixtures.dart';
import 'download_fixture.dart';

void main() {
  late DownloadHarness h;
  setUp(() async => h = await DownloadHarness.create());
  tearDown(() async => h.close());
  LikedDownloadAutomation automation({
    int count = 501,
    bool ready = true,
    NetworkPolicy policy = const NetworkPolicy.online(),
    Future<String> Function(String, dynamic, int)? schedule,
  }) {
    final transport = CollectionTransport((request, _) {
      expect(request.query['limit'], '500');
      if (request.query['cursorTrackId'] != null) {
        expect(request.query['cursorLikedAt'], 'opaque');
      }
      final start = request.query['cursorTrackId'] == null ? 0 : 500;
      return likedResponse(
        List.generate(
          count - start > 500 ? 500 : count - start,
          (i) => likedDto(start + i),
        ),
        total: count,
        cursor: start == 0 && count > 500
            ? {'likedAt': 'opaque', 'trackId': '500'}
            : null,
      );
    });
    final result = LikedDownloadAutomation(
      downloads: h.repo,
      likes: LikesRepository(
        transport: transport,
        authority: h.authority,
        fence: h.fence,
      ),
      fence: h.fence,
      networkPolicy: policy,
      storageReady: () => ready,
      schedule: schedule ?? (_, _, _) async => 'work',
      cancelJob: (_, _, _) async {},
    );
    addTearDown(result.close);
    return result;
  }

  test(
    '501 real likes use opaque pages 500 + 1 and no application cap',
    () async {
      final scheduled = <String>[];
      final a = automation(
        schedule: (id, fence, generation) async {
          expect(fence, h.fence);
          expect(generation, 1);
          scheduled.add(id);
          return id;
        },
      );
      await a.reconcile(h.fence);
      expect(scheduled.toSet(), hasLength(501));
      expect(await h.repo.list(h.fence), hasLength(501));
    },
  );
  test('pause persists across automation restart and storage not ready admits none', () async {
    await automation(count: 1).setPaused(true, h.fence);
    final reopened = automation(count: 1);
    await reopened.reconcile(h.fence);
    expect(await reopened.readPaused(), isTrue);
    expect(await h.repo.list(h.fence), isEmpty);
    await reopened.setPaused(false, h.fence);
    await automation(count: 1, ready: false).reconcile(h.fence);
    expect(await h.repo.list(h.fence), isEmpty);
  });
  test('unlike cancels pending auto but manual promotion retains it', () async {
    final a = automation(count: 2);
    await a.reconcile(h.fence);
    final jobs = await h.repo.list(h.fence);
    final promoted = jobs.first;
    await h.repo.enqueue(promoted.track, promoted.quality, h.fence);
    await a.onPreferenceChanged(promoted.track.ref, PreferenceSignal.clear);
    await a.onPreferenceChanged(jobs.last.track.ref, PreferenceSignal.clear);
    expect((await h.repo.status(promoted.id, h.fence))!.manual, isTrue);
    expect(
      (await h.repo.status(jobs.last.id, h.fence))!.errorCode,
      'download_cancelled',
    );
  });
  test('one provider scheduling failure does not starve later likes', () async {
    var calls = 0;
    final a = automation(
      count: 3,
      schedule: (_, _, _) async {
        if (++calls == 1) throw StateError('provider unavailable');
        return 'ok';
      },
    );
    await a.reconcile(h.fence);
    expect(calls, 3);
  });
  test('offline admission does not create rows or schedule', () async {
    var calls = 0;
    await automation(
      count: 1,
      policy: const NetworkPolicy.offline(),
      schedule: (_, _, _) async {
        calls++;
        return 'x';
      },
    ).reconcile(h.fence);
    expect(calls, 0);
    expect(await h.repo.list(h.fence), isEmpty);
  });
  test(
    'ENOSPC pauses durable admission rather than evicting ready music',
    () async {
      var calls = 0;
      final a = automation(
        count: 3,
        schedule: (_, _, _) async {
          calls++;
          throw const FileSystemException('full', '', OSError('ENOSPC', 28));
        },
      );
      await a.reconcile(h.fence);
      expect(calls, 1);
      expect(await a.readPaused(), isTrue);
      expect(a.notice, contains('место'));
      expect(await h.repo.list(h.fence), hasLength(1));
    },
  );
  test('unlike ready retains file entry', () async {
    final a = automation(count: 1);
    await a.reconcile(h.fence);
    final j = (await h.repo.list(h.fence)).single;
    final claim = (await h.repo.claim(j.id, h.fence, j.generation))!;
    await h.repo.updateClaim(claim, state: DownloadState.ready, release: true);
    await a.onPreferenceChanged(j.track.ref, PreferenceSignal.clear);
    expect((await h.repo.list(h.fence)).single.state, DownloadState.ready);
  });
  test('resuming automatic downloads restarts their paused jobs with a new generation', () async {
    final generations = <int>[];
    final a = automation(
      count: 1,
      schedule: (_, _, generation) async {
        generations.add(generation);
        return 'work';
      },
    );
    await a.reconcile(h.fence);
    await a.setPaused(true, h.fence);
    await a.setPaused(false, h.fence);
    await a.reconcile(h.fence);
    expect((await h.repo.list(h.fence)).single.state, DownloadState.queued);
    expect(generations, [1, 3]);
    await a.close();
  });
  test('pause while page is pending rejects its later admission', () async {
    final gate = Completer<void>();
    final a = LikedDownloadAutomation(
      downloads: h.repo,
      likes: LikesRepository(
        transport: CollectionTransport((_, _) async {
          await gate.future;
          return likedResponse([likedDto(1)]);
        }),
        authority: h.authority,
        fence: h.fence,
      ),
      fence: h.fence,
      storageReady: () => true,
      networkPolicy: const NetworkPolicy.online(),
      schedule: (_, _, _) async => 'x',
      cancelJob: (_, _, _) async {},
    );
    final running = a.reconcile(h.fence);
    await Future<void>.delayed(Duration.zero);
    await a.setPaused(true, h.fence);
    gate.complete();
    await running;
    expect(await h.repo.list(h.fence), isEmpty);
  });
  test('confirmed known track likes admit one exact track without scanning liked pages', () async {
    var pages = 0;
    var scheduled = 0;
    final a = LikedDownloadAutomation(
      downloads: h.repo,
      likes: LikesRepository(
        transport: CollectionTransport((_, _) {
          pages++;
          return likedResponse([]);
        }),
        authority: h.authority,
        fence: h.fence,
      ),
      fence: h.fence,
      storageReady: () => true,
      networkPolicy: const NetworkPolicy.online(),
      schedule: (_, _, _) async {
        scheduled++;
        return 'x';
      },
      cancelJob: (_, _, _) async {},
    );
    addTearDown(a.close);
    final Track exact = collectionTrack(22);
    await a.onPreferenceChanged(
      exact.ref,
      PreferenceSignal.like,
      knownTrack: exact,
    );
    expect(pages, 0);
    expect(scheduled, 1);
    expect((await h.repo.list(h.fence)).single.track.ref, exact.ref);
  });
  test(
    'unknown confirmed likes during a scan coalesce one fresh followup page',
    () async {
      final first = Completer<void>();
      final requested = Completer<void>();
      var pages = 0;
      final a = LikedDownloadAutomation(
        downloads: h.repo,
        likes: LikesRepository(
          transport: CollectionTransport((_, _) async {
            pages++;
            if (pages == 1) {
              requested.complete();
              await first.future;
              return likedResponse([]);
            }
            return likedResponse([likedDto(44)]);
          }),
          authority: h.authority,
          fence: h.fence,
        ),
        fence: h.fence,
        storageReady: () => true,
        networkPolicy: const NetworkPolicy.online(),
        schedule: (_, _, _) async => 'work',
        cancelJob: (_, _, _) async {},
      );
      addTearDown(a.close);
      final scan = a.reconcile(h.fence);
      await requested.future;
      final like1 = a.onPreferenceChanged(
        collectionTrack(44).ref,
        PreferenceSignal.like,
      );
      final like2 = a.onPreferenceChanged(
        collectionTrack(44).ref,
        PreferenceSignal.like,
      );
      first.complete();
      await Future.wait([scan, like1, like2]);
      expect(pages, 2);
      expect(await h.repo.list(h.fence), hasLength(1));
    },
  );
  test(
    'same owner relogin rejects late old page and original epoch scheduling',
    () async {
      final gate = Completer<void>();
      final requested = Completer<void>();
      var scheduled = 0;
      final oldFence = h.fence;
      final a = LikedDownloadAutomation(
        downloads: h.repo,
        likes: LikesRepository(
          transport: CollectionTransport((_, _) async {
            requested.complete();
            await gate.future;
            return likedResponse([likedDto(1)]);
          }),
          authority: h.authority,
          fence: oldFence,
        ),
        fence: oldFence,
        storageReady: () => true,
        networkPolicy: const NetworkPolicy.online(),
        schedule: (_, _, _) async {
          scheduled++;
          return 'work';
        },
        cancelJob: (_, _, _) async {},
      );
      final scan = a.reconcile(oldFence);
      await requested.future;
      await h.authority.invalidate();
      await h.authority.establish(
        oldFence.owner,
        const TokenPair(accessToken: 'new', refreshToken: 'new-refresh'),
      );
      gate.complete();
      await scan;
      await a.close();
      await a.close();
      expect(h.fence.epoch, isNot(oldFence.epoch));
      expect(scheduled, 0);
      expect(await h.repo.list(h.fence), isEmpty);
    },
  );
  test(
    'close drains a known like revoked while its control read is pending',
    () async {
      final store = _DeferredStore(h.store);
      final repo = DownloadRepository(
        store: store,
        authority: h.authority,
        paths: h.paths,
        verifier: h.repo.verifier,
        beforeRemove: (_) async {},
      );
      var scheduled = 0;
      final a = LikedDownloadAutomation(
        downloads: repo,
        likes: LikesRepository(
          transport: CollectionTransport((_, _) => likedResponse([])),
          authority: h.authority,
          fence: h.fence,
        ),
        fence: h.fence,
        storageReady: () => true,
        networkPolicy: const NetworkPolicy.online(),
        schedule: (_, _, _) async {
          scheduled++;
          return 'x';
        },
        cancelJob: (_, _, _) async {},
      );
      final track = collectionTrack(7);
      final like = a.onPreferenceChanged(
        track.ref,
        PreferenceSignal.like,
        knownTrack: track,
      );
      final closing = a.close();
      await h.authority.invalidate();
      store.gate.complete();
      await Future.wait([like, closing]);
      expect(scheduled, 0);
    },
  );
}

class _DeferredStore implements OwnerStore {
  _DeferredStore(this.delegate);
  final OwnerStore delegate;
  final gate = Completer<void>();
  @override
  Future<T> transaction<T>(
    SessionFence fence,
    Future<T> Function(OwnerTransaction) body,
  ) async {
    await gate.future;
    return delegate.transaction(fence, body);
  }
}
