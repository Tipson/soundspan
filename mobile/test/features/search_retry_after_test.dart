import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/features/search/catalog_models.dart';
import 'package:soundspan/features/search/search_controller.dart';
import 'package:soundspan/features/search/search_repository.dart';

import '../support/collection_fixtures.dart';
import 'search_partial_retry_test.dart' show partialLocalTrack;
import 'search_saved_entities_test.dart' show savedResponse;

SearchRepository scoped(
  CollectionTransport transport,
  CollectionAuthority owner,
) {
  final repository = SearchRepository(
    transport: transport,
    authority: owner,
    fence: collectionFence,
    networkPolicy: const NetworkPolicy.online(),
  );
  addTearDown(repository.dispose);
  return repository;
}

void main() {
  for (final status in [429, 503]) {
    test(
      'exact $status holdoff covers retry, submit and paging, then expires',
      () async {
        final owner = CollectionAuthority();
        addTearDown(owner.updates.close);
        var discoveryCalls = 0;
        final transport = CollectionTransport((request, _) {
          if (request.path == '/api/search/discover') {
            discoveryCalls++;
            return ApiResponse(
              status,
              {},
              retryAfter: const Duration(milliseconds: 180),
            );
          }
          return ApiResponse(200, {
            'tracks': [
              if (request.path == '/api/search')
                for (var i = 0; i < 50; i++) partialLocalTrack('local-$i'),
            ],
          });
        });
        final repository = scoped(transport, owner);
        final controller = SearchController(repository: repository);
        addTearDown(controller.dispose);
        await controller.submit('Кино', kind: SearchKind.tracks);
        final before = controller.state.page;
        expect(
          before.failures['discovery']?.retryAfter,
          const Duration(milliseconds: 180),
        );
        await Future.wait([controller.retry(), controller.retry()]);
        await repository.search('Кино', SearchKind.tracks, previous: before);
        await repository.search('Кино', SearchKind.tracks);
        expect(
          discoveryCalls,
          1,
          reason:
              'Retry, same-query submit and load-more cannot bypass holdoff',
        );
        expect(controller.state.page.tracks.length, 50);
        await Future<void>.delayed(const Duration(milliseconds: 220));
        await controller.retry();
        expect(
          discoveryCalls,
          2,
          reason: 'Blocked attempts do not extend the receipt deadline',
        );
        await controller.retry();
        expect(
          discoveryCalls,
          2,
          reason: 'New actual failure starts its own bounded holdoff',
        );
      },
    );
  }

  test(
    'private and public holdoffs merge without blocking healthy siblings',
    () async {
      final owner = CollectionAuthority();
      addTearDown(owner.updates.close);
      final counts = <String, int>{};
      final transport = CollectionTransport((request, _) {
        final key = request.path == '/api/library/saved'
            ? 'saved:${request.query['type']}'
            : request.path;
        counts.update(key, (value) => value + 1, ifAbsent: () => 1);
        if (key == 'saved:artist' || key == '/api/search/discover') {
          return const ApiResponse(429, {}, retryAfter: Duration(seconds: 10));
        }
        if (request.path == '/api/library/saved') {
          return savedResponse(request, []);
        }
        return const ApiResponse(200, {'tracks': []});
      });
      final repository = scoped(transport, owner);
      final before = await repository.search('same', SearchKind.all);
      expect(before.failures['saved:artist']?.statusCode, 429);
      await repository.retry('same', SearchKind.all, before);
      await repository.retrySaved('same', SearchKind.all, before);
      await repository.search('same', SearchKind.all);
      expect(counts['saved:artist'], 1);
      expect(counts['/api/search/discover'], 1);
      expect(
        counts['/api/search'],
        2,
        reason: 'Healthy local projection remains independent',
      );
      expect(counts['saved:album'], 2);
    },
  );

  test(
    'late A cannot overwrite the active B receipt on the same owner',
    () async {
      final owner = CollectionAuthority();
      addTearDown(owner.updates.close);
      final entered = Completer<void>(), held = Completer<ApiResponse>();
      addTearDown(() {
        if (!held.isCompleted) {
          held.complete(const ApiResponse(200, {'results': []}));
        }
      });
      final calls = <String>[];
      final transport = CollectionTransport((request, _) {
        if (request.path != '/api/search/discover') {
          return const ApiResponse(200, {'tracks': []});
        }
        final q = request.query['q']!;
        calls.add(q);
        if (q == 'A') {
          if (!entered.isCompleted) entered.complete();
          return held.future;
        }
        return const ApiResponse(429, {}, retryAfter: Duration(seconds: 10));
      });
      final repository = scoped(transport, owner);
      final pendingA = repository.search('A', SearchKind.tracks);
      await entered.future;
      final b = await repository.search('B', SearchKind.tracks);
      held.complete(
        const ApiResponse(503, {}, retryAfter: Duration(seconds: 10)),
      );
      await pendingA;
      await repository.retry('B', SearchKind.tracks, b);
      await repository.search('B', SearchKind.tracks);
      expect(calls, ['A', 'B']);
    },
  );

  test('an already-dispatched sibling success cannot erase a shared library holdoff', () async {
    final owner = CollectionAuthority();
    addTearDown(owner.updates.close);
    final entered = Completer<void>(), held = Completer<ApiResponse>();
    addTearDown(() {
      if (!held.isCompleted) {
        held.complete(const ApiResponse(200, {'tracks': []}));
      }
    });
    var calls = 0;
    final transport = CollectionTransport((request, _) {
      if (request.path == '/api/library/saved') {
        return savedResponse(request, []);
      }
      if (request.path != '/api/search') {
        return const ApiResponse(200, {'results': []});
      }
      calls++;
      if (calls == 1) {
        entered.complete();
        return held.future;
      }
      return const ApiResponse(429, {}, retryAfter: Duration(seconds: 10));
    });
    final repository = scoped(transport, owner);
    final first = repository.search('same', SearchKind.all);
    await entered.future;
    final rejected = await repository.search('same', SearchKind.all);
    held.complete(const ApiResponse(200, {'tracks': []}));
    await first;
    await repository.retry('same', SearchKind.all, rejected);
    expect(calls, 2);
  });

  test(
    'query/category/new repository resets timing and revoked owner never sends',
    () async {
      final owner = CollectionAuthority();
      addTearDown(owner.updates.close);
      var calls = 0;
      final transport = CollectionTransport((request, _) {
        if (request.path == '/api/library/saved') {
          return savedResponse(request, []);
        }
        if (request.path == '/api/search/discover') {
          calls++;
          return const ApiResponse(429, {}, retryAfter: Duration(seconds: 10));
        }
        return const ApiResponse(200, {'tracks': []});
      });
      final repository = scoped(transport, owner);
      final original = await repository.search('A', SearchKind.tracks);
      await repository.search('B', SearchKind.tracks);
      await repository.search('B', SearchKind.albums);
      expect(calls, 3);
      await scoped(transport, owner).retry('A', SearchKind.tracks, original);
      expect(
        calls,
        4,
        reason:
            'An unrelated repository cannot inherit an old monotonic receipt',
      );
      owner.switchOwner();
      await expectLater(
        repository.retry('A', SearchKind.tracks, original),
        throwsA(isA<Exception>()),
      );
      expect(calls, 4);
    },
  );
}
