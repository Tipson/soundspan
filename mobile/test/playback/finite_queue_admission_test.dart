import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/dart_api_transport.dart';
import 'package:soundspan/core/session/credential_vault.dart';
import 'package:soundspan/playback/finite_queue_admission_api.dart';
import 'package:soundspan/playback/finite_queue_admission_coordinator.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/resolved_media.dart';

import '../support/collection_fixtures.dart';
import '../support/auth_fakes.dart' show ScriptedJsonClient;
import '../support/media_fixtures.dart' show mediaAuthority;

const refA = FiniteQueueAdmissionReference(source: 'library', id: 'local-1');
const refB = FiniteQueueAdmissionReference(
  source: 'youtube',
  id: 'abcdefghijk',
);

ApiResponse admissionResponse(
  List<FiniteQueueAdmissionReference> refs, {
  List<String>? states,
}) => ApiResponse(200, {
  'version': 1,
  'appliesTo': 'recommended_future',
  'decisions': [
    for (final (index, ref) in refs.indexed)
      {
        'source': ref.source,
        'id': ref.id,
        'state': states?[index] ?? 'allowed',
      },
  ],
});

void main() {
  group('finite identity API', () {
    test(
      'sends ordered occurrences and generation without inferred metadata',
      () async {
        const generated = FiniteQueueAdmissionReference(
          source: 'yandex',
          id: '42',
          generationId: 'owner-served-generation',
        );
        final refs = [generated, refB, generated];
        final transport = CollectionTransport(
          (_, _) => admissionResponse(
            refs,
            states: ['allowed', 'denied', 'unavailable'],
          ),
        );
        final result = await FiniteQueueAdmissionApi(transport: transport)
            .admit(
              refs,
              fence: collectionFence,
              cancellation: MediaCancellation(),
            );
        expect(result.mode, FiniteQueueAdmissionMode.authoritative);
        expect(result.states, [
          FiniteQueueAdmissionState.allowed,
          FiniteQueueAdmissionState.denied,
          FiniteQueueAdmissionState.unavailable,
        ]);
        final request = transport.requests.single;
        expect(request.method, ApiMethod.post);
        expect(request.path, '/api/personalized/queue-admission');
        expect(request.body, {
          'references': [
            {
              'source': 'yandex',
              'id': '42',
              'generationId': 'owner-served-generation',
            },
            {'source': 'youtube', 'id': 'abcdefghijk'},
            {
              'source': 'yandex',
              'id': '42',
              'generationId': 'owner-served-generation',
            },
          ],
        });
        expect(transport.fences, [collectionFence]);
      },
    );

    test('only 404 selects legacy exact policy', () async {
      for (final status in [400, 401, 403, 404, 429, 500, 503]) {
        final transport = CollectionTransport(
          (_, _) => throw AppFailure(
            code: 'http_error',
            message: 'failure',
            statusCode: status,
          ),
        );
        final result = await FiniteQueueAdmissionApi(transport: transport)
            .admit(
              [refA],
              fence: collectionFence,
              cancellation: MediaCancellation(),
            );
        expect(
          result.mode,
          status == 404
              ? FiniteQueueAdmissionMode.legacyExact
              : FiniteQueueAdmissionMode.unavailable,
        );
      }
    });

    test(
      'wrong version, scope, order, count or state close the whole batch',
      () async {
        final valid =
            admissionResponse([refA, refB]).data as Map<String, Object?>;
        final broken = [
          {...valid, 'version': 2},
          {...valid, 'appliesTo': 'all'},
          {
            ...valid,
            'decisions': (valid['decisions'] as List).reversed.toList(),
          },
          {
            ...valid,
            'decisions': [(valid['decisions'] as List).first],
          },
          {
            ...valid,
            'decisions': [
              {'source': 'library', 'id': 'local-1', 'state': 'unknown'},
              {'source': 'youtube', 'id': 'abcdefghijk', 'state': 'allowed'},
            ],
          },
        ];
        for (final body in broken) {
          final result =
              await FiniteQueueAdmissionApi(
                transport: CollectionTransport(
                  (_, _) => ApiResponse(200, body),
                ),
              ).admit(
                [refA, refB],
                fence: collectionFence,
                cancellation: MediaCancellation(),
              );
          expect(result.mode, FiniteQueueAdmissionMode.unavailable);
          expect(
            result.states,
            everyElement(FiniteQueueAdmissionState.unavailable),
          );
        }
      },
    );

    test('invalid references and batch bounds never reach transport', () async {
      final transport = CollectionTransport(
        (_, _) => admissionResponse([refA]),
      );
      final api = FiniteQueueAdmissionApi(transport: transport);
      for (final refs in [
        <FiniteQueueAdmissionReference>[],
        List.filled(101, refA),
        [
          const FiniteQueueAdmissionReference(
            source: 'tidal',
            id: '9007199254740992',
          ),
        ],
        [
          const FiniteQueueAdmissionReference(
            source: 'youtube',
            id: 'title-name',
          ),
        ],
        [const FiniteQueueAdmissionReference(source: 'library', id: 'a/b')],
      ]) {
        final result = await api.admit(
          refs,
          fence: collectionFence,
          cancellation: MediaCancellation(),
        );
        expect(result.mode, FiniteQueueAdmissionMode.unavailable);
      }
      expect(transport.requests, isEmpty);
      expect(
        FiniteQueueAdmissionReference.fromTrack(
          const UnavailableTrackRef('artist:someone', reason: 'unknown'),
        ),
        isNull,
      );
    });
  });

  group('owner queue mutation coordinator', () {
    late CollectionAuthority authority;
    late QueueSnapshot state;
    late CollectionTransport transport;
    late FiniteQueueAdmissionCoordinator coordinator;
    setUp(() {
      authority = CollectionAuthority();
      state = QueueSnapshot(
        fence: collectionFence,
        lineage: 3,
        generation: 7,
        currentEntryId: 'current',
      );
      transport = CollectionTransport((request, _) {
        final refs = (request.body!['references'] as List).cast<Map>();
        return ApiResponse(200, {
          'version': 1,
          'appliesTo': 'recommended_future',
          'decisions': [
            for (final ref in refs) {...ref, 'state': 'allowed'},
          ],
        });
      });
      coordinator = FiniteQueueAdmissionCoordinator(
        api: FiniteQueueAdmissionApi(transport: transport),
        authority: authority,
        snapshot: () => state,
      );
    });
    tearDown(() async {
      await coordinator.close();
      await authority.updates.close();
    });

    test('each like clear or negative begin is independent; pending settles in finally', () async {
      final first = coordinator.beginMutation();
      final epoch = coordinator.mutationEpoch;
      final second = coordinator.beginMutation();
      expect(coordinator.mutationEpoch, epoch + 1);
      expect(coordinator.pendingMutations, 2);
      final waiting = coordinator.admit(captured: state, references: [refA]);
      coordinator.finishMutation(first);
      await Future<void>.delayed(Duration.zero);
      expect(transport.requests, isEmpty);
      coordinator.finishMutation(second);
      final result = await waiting;
      expect(result.stateAt(0), FiniteQueueAdmissionState.allowed);
      await expectLater(
        coordinator.trackMutation(() async => throw StateError('lost ACK')),
        throwsStateError,
      );
      expect(coordinator.pendingMutations, 0);
      expect(result.stateAt(0), FiniteQueueAdmissionState.unavailable);
    });

    test('only identical capture and ordered refs coalesce', () async {
      final gate = Completer<ApiResponse>();
      transport = CollectionTransport((_, _) => gate.future);
      await coordinator.close();
      coordinator = FiniteQueueAdmissionCoordinator(
        api: FiniteQueueAdmissionApi(transport: transport),
        authority: authority,
        snapshot: () => state,
      );
      final first = coordinator.admit(
        captured: state,
        references: [refA, refB],
      );
      final same = coordinator.admit(captured: state, references: [refA, refB]);
      final different = coordinator.admit(
        captured: state,
        references: [refB, refA],
      );
      await Future<void>.delayed(Duration.zero);
      expect(transport.requests.length, 2);
      gate.complete(admissionResponse([refA, refB]));
      expect(identical(await first, await same), isTrue);
      expect((await different).mode, FiniteQueueAdmissionMode.unavailable);
    });

    test(
      'new mutation cancels waiting response and invalidates late allowed',
      () async {
        final response = Completer<ApiResponse>();
        transport = CollectionTransport((_, _) => response.future);
        await coordinator.close();
        coordinator = FiniteQueueAdmissionCoordinator(
          api: FiniteQueueAdmissionApi(transport: transport),
          authority: authority,
          snapshot: () => state,
        );
        final old = coordinator.admit(captured: state, references: [refA]);
        await Future<void>.delayed(Duration.zero);
        final mutation = coordinator.beginMutation();
        final result = await old;
        expect(result.stateAt(0), FiniteQueueAdmissionState.unavailable);
        response.complete(admissionResponse([refA]));
        coordinator.finishMutation(mutation);
        await Future<void>.delayed(Duration.zero);
        expect(result.stateAt(0), FiniteQueueAdmissionState.unavailable);
      },
    );

    test('owner queue run or synchronous manual intent revoke an already allowed result', () async {
      final admitted = await coordinator.admit(
        captured: state,
        references: [refA],
      );
      expect(admitted.stateAt(0), FiniteQueueAdmissionState.allowed);
      coordinator.invalidateQueue();
      expect(admitted.stateAt(0), FiniteQueueAdmissionState.unavailable);
      final next = await coordinator.admit(captured: state, references: [refA]);
      state = QueueSnapshot(
        fence: collectionFence,
        lineage: 4,
        generation: 7,
        currentEntryId: 'current',
      );
      expect(next.stateAt(0), FiniteQueueAdmissionState.unavailable);
      final owned = await coordinator.admit(
        captured: state,
        references: [refA],
      );
      authority.switchOwner();
      expect(owned.stateAt(0), FiniteQueueAdmissionState.unavailable);
    });

    test(
      'one deadline includes pending writes and cancels without dispatch',
      () async {
        await coordinator.close();
        coordinator = FiniteQueueAdmissionCoordinator(
          api: FiniteQueueAdmissionApi(transport: transport),
          authority: authority,
          snapshot: () => state,
          timeout: const Duration(milliseconds: 20),
        );
        final mutation = coordinator.beginMutation();
        final result = await coordinator.admit(
          captured: state,
          references: [refA],
        );
        expect(result.mode, FiniteQueueAdmissionMode.unavailable);
        coordinator.finishMutation(mutation);
        await Future<void>.delayed(const Duration(milliseconds: 10));
        expect(transport.requests, isEmpty);
      },
    );

    test(
      'more than100 candidates continue in finite batches under one deadline',
      () async {
        final refs = List.generate(
          202,
          (i) =>
              FiniteQueueAdmissionReference(source: 'library', id: 'local-$i'),
        );
        var batches = 0;
        transport = CollectionTransport((request, _) {
          final batch = (request.body!['references'] as List).cast<Map>();
          expect(batch.length, lessThanOrEqualTo(100));
          batches++;
          return ApiResponse(200, {
            'version': 1,
            'appliesTo': 'recommended_future',
            'decisions': [
              for (final ref in batch)
                {
                  ...ref,
                  'state': ref['id'] == 'local-101' ? 'allowed' : 'denied',
                },
            ],
          });
        });
        await coordinator.close();
        coordinator = FiniteQueueAdmissionCoordinator(
          api: FiniteQueueAdmissionApi(transport: transport),
          authority: authority,
          snapshot: () => state,
        );
        final result = await coordinator.admit(
          captured: state,
          references: refs,
        );
        expect(batches, 2);
        expect(result.stateAt(100), FiniteQueueAdmissionState.denied);
        expect(result.stateAt(101), FiniteQueueAdmissionState.allowed);
        expect(result.stateAt(201), FiniteQueueAdmissionState.unavailable);
      },
    );

    test('timeout during401 refresh never replays a late grant', () async {
      final refresh = Completer<TokenPair>();
      final refreshing = Completer<void>();
      final auth = await mediaAuthority(
        collectionOrigin,
        refresh: (_, _) {
          refreshing.complete();
          return refresh.future;
        },
      );
      final http = ScriptedJsonClient(
        (_, _) async => const ApiResponse(401, null),
      );
      await coordinator.close();
      state = QueueSnapshot(
        fence: auth.requireFence(),
        lineage: 3,
        generation: 7,
        currentEntryId: 'current',
      );
      coordinator = FiniteQueueAdmissionCoordinator(
        api: FiniteQueueAdmissionApi(
          transport: DartApiTransport(client: http, authority: auth),
        ),
        authority: auth,
        snapshot: () => state,
        timeout: const Duration(milliseconds: 40),
      );
      final resultFuture = coordinator.admit(
        captured: state,
        references: [refA],
      );
      await refreshing.future;
      final result = await resultFuture;
      expect(result.mode, FiniteQueueAdmissionMode.unavailable);
      refresh.complete(
        const TokenPair(accessToken: 'late', refreshToken: 'late-refresh'),
      );
      await Future<void>.delayed(const Duration(milliseconds: 10));
      expect(http.calls, 1);
    });
  });
}
