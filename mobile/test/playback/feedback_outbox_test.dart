import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/core/session/credential_vault.dart';
import 'package:soundspan/features/recommendations/recommendation_repository.dart';
import 'package:soundspan/playback/feedback_outbox.dart';
import 'package:soundspan/playback/playback_event_models.dart';

import '../support/media_fixtures.dart';
import '../support/wave_reporting_fixtures.dart';

void main() {
  test('transaction handoff distinguishes durable unchanged totals from an old login epoch', () async {
    final authority = await mediaAuthority(Uri.parse('https://report.test'));
    final fence = authority.requireFence();
    final store = ReportingStore();
    final transport = ControlledTransport();
    final outbox = FeedbackOutbox(
      store: store,
      repository: RecommendationRepository(transport: transport),
      authority: authority,
    );
    const totals = PlayEngagement(
      listenedSeconds: 200,
      completionRatio: 1,
      outcome: PlayOutcome.completed,
    );
    await store.transaction(fence, (tx) async {
      expect(
        await outbox.enqueueInTransaction(tx, 'known', totals, fence),
        FeedbackAcceptance.changed,
      );
      expect(
        await outbox.enqueueInTransaction(tx, 'known', totals, fence),
        FeedbackAcceptance.unchanged,
      );
      await tx.write('handoff', 'done', {'known': true});
    });
    expect(transport.requests, isEmpty);
    final otherEpoch = SessionFence(owner: fence.owner, epoch: fence.epoch + 1);
    await store.transaction(otherEpoch, (tx) async {
      expect(
        await outbox.enqueueInTransaction(tx, 'known', totals, otherEpoch),
        FeedbackAcceptance.stale,
      );
    });
    final durable = await store.transaction(
      fence,
      (tx) => tx.read(FeedbackOutbox.namespace, 'known'),
    );
    expect(durable!['epoch'], fence.epoch);
    expect(durable['version'], 1);
  });
  test(
    'in-flight drain wakes earlier sorted new rows without unrelated flush',
    () async {
      final authority = await mediaAuthority(Uri.parse('https://report.test'));
      final fence = authority.requireFence();
      final transport = ControlledTransport();
      final gate = Completer<ApiResponse>();
      var requests = 0;
      transport.respond = (_) async => ++requests == 1
          ? gate.future
          : const ApiResponse(200, {'success': true});
      final outbox = FeedbackOutbox(
        store: ReportingStore(),
        repository: RecommendationRepository(transport: transport),
        authority: authority,
      );
      const body = PlayEngagement(
        listenedSeconds: 60,
        completionRatio: 0.3,
        outcome: PlayOutcome.meaningful,
      );
      await outbox.enqueue('z-play', body, fence);
      final flushing = outbox.flush(fence);
      await settle();
      await outbox.enqueue('a-play', body, fence);
      gate.complete(const ApiResponse(200, {'success': true}));
      await flushing;
      expect(transport.requests.map((request) => request.path), [
        '/api/plays/z-play/engagement',
        '/api/plays/a-play/engagement',
      ]);
    },
  );
  test('same-flight dirty drain shares the100send budget and retains unacknowledged newer version', () async {
    final authority = await mediaAuthority(Uri.parse('https://report.test'));
    final fence = authority.requireFence();
    final store = ReportingStore();
    final transport = ControlledTransport();
    final gate = Completer<ApiResponse>();
    var requests = 0;
    transport.respond = (_) async => ++requests == 1
        ? gate.future
        : const ApiResponse(200, {'success': true});
    final outbox = FeedbackOutbox(
      store: store,
      repository: RecommendationRepository(transport: transport),
      authority: authority,
    );
    for (var i = 0; i < 100; i++) {
      await outbox.enqueue(
        'play-${i.toString().padLeft(3, '0')}',
        const PlayEngagement(
          listenedSeconds: 60,
          completionRatio: 0.3,
          outcome: PlayOutcome.meaningful,
        ),
        fence,
      );
    }
    final flushing = outbox.flush(fence);
    await settle();
    await outbox.enqueue(
      'play-000',
      const PlayEngagement(
        listenedSeconds: 200,
        completionRatio: 1,
        outcome: PlayOutcome.completed,
      ),
      fence,
    );
    gate.complete(const ApiResponse(200, {'success': true}));
    await flushing;
    expect(requests, 100);
    final pending = await store.transaction(
      fence,
      (tx) => tx.read(FeedbackOutbox.namespace, 'play-000'),
    );
    expect(pending!['version'], greaterThan(pending['ackVersion'] as int));
    await outbox.flush(fence);
    expect(requests, 101);
    expect(transport.requests.last.body!['listenedSeconds'], 200);
  });
  test('dirty newer payload after failed flight does not create a tight retry loop', () async {
    final authority = await mediaAuthority(Uri.parse('https://report.test'));
    final fence = authority.requireFence();
    final transport = ControlledTransport();
    final gate = Completer<ApiResponse>();
    var requests = 0;
    transport.respond = (_) async =>
        ++requests == 1 ? gate.future : const ApiResponse(503, {});
    final outbox = FeedbackOutbox(
      store: ReportingStore(),
      repository: RecommendationRepository(transport: transport),
      authority: authority,
    );
    await outbox.enqueue(
      'known',
      const PlayEngagement(
        listenedSeconds: 60,
        completionRatio: 0.3,
        outcome: PlayOutcome.meaningful,
      ),
      fence,
    );
    final flushing = outbox.flush(fence);
    await settle();
    await outbox.enqueue(
      'known',
      const PlayEngagement(
        listenedSeconds: 200,
        completionRatio: 1,
        outcome: PlayOutcome.completed,
      ),
      fence,
    );
    gate.complete(const ApiResponse(503, {}));
    await flushing;
    expect(requests, 1);
    for (var i = 0; i < 10; i++) {
      await outbox.flush(fence);
    }
    expect(requests, 3);
  });
  test('durable server holdoff survives restart and explicit retry cannot bypass it', () async {
    final authority = await mediaAuthority(Uri.parse('https://report.test'));
    final fence = authority.requireFence();
    final store = ReportingStore();
    final transport = ControlledTransport();
    var now = DateTime.utc(2026, 10, 15);
    var calls = 0;
    transport.respond = (_) async {
      if (++calls == 1) {
        throw const AppFailure(
          code: 'http_error',
          message: 'Retry later',
          statusCode: 429,
          retryable: true,
          retryAfter: Duration(seconds: 120),
        );
      }
      return const ApiResponse(200, {'success': true});
    };
    final repository = RecommendationRepository(transport: transport);
    var outbox = FeedbackOutbox(
      store: store,
      repository: repository,
      authority: authority,
      now: () => now,
    );
    await outbox.enqueue(
      'known',
      const PlayEngagement(
        listenedSeconds: 10,
        completionRatio: 0.05,
        outcome: PlayOutcome.skipped,
      ),
      fence,
    );
    await outbox.flush(fence);
    expect(calls, 1);
    now = now.add(const Duration(seconds: 60));
    outbox = FeedbackOutbox(
      store: store,
      repository: repository,
      authority: authority,
      now: () => now,
    );
    await outbox.enqueue(
      'known',
      const PlayEngagement(
        listenedSeconds: 20,
        completionRatio: 0.1,
        outcome: PlayOutcome.skipped,
      ),
      fence,
    );
    await outbox.flush(fence);
    await outbox.retry(fence);
    expect(calls, 1);
    final row = await store.transaction(
      fence,
      (tx) => tx.read(FeedbackOutbox.namespace, 'known'),
    );
    expect(row!['attempts'], 1);
    now = now.add(const Duration(seconds: 60));
    await outbox.flush(fence);
    expect(calls, 2);
    expect(transport.requests.last.body!['listenedSeconds'], 20);
  });
  test(
    'acknowledged first page cannot starve later pending known plays',
    () async {
      final authority = await mediaAuthority(Uri.parse('https://report.test'));
      final fence = authority.requireFence();
      final transport = ControlledTransport();
      final outbox = FeedbackOutbox(
        store: ReportingStore(),
        repository: RecommendationRepository(transport: transport),
        authority: authority,
      );
      for (var i = 0; i < 101; i++) {
        await outbox.enqueue(
          'play-${i.toString().padLeft(3, '0')}',
          const PlayEngagement(
            listenedSeconds: 50,
            completionRatio: 0.25,
            outcome: PlayOutcome.meaningful,
          ),
          fence,
        );
      }
      await outbox.flush(fence);
      expect(transport.requests.length, 100);
      await outbox.flush(fence);
      expect(transport.requests.length, 101);
    },
  );
  test(
    'same owner relogin cannot promote old epoch rows into fresh fence',
    () async {
      final authority = await mediaAuthority(Uri.parse('https://report.test'));
      final old = authority.requireFence();
      final transport = ControlledTransport();
      final store = ReportingStore();
      final outbox = FeedbackOutbox(
        store: store,
        repository: RecommendationRepository(transport: transport),
        authority: authority,
      );
      await outbox.enqueue(
        'old-play',
        const PlayEngagement(
          listenedSeconds: 50,
          completionRatio: 0.25,
          outcome: PlayOutcome.meaningful,
        ),
        old,
      );
      await authority.establish(
        old.owner,
        const TokenPair(
          accessToken: 'relogin',
          refreshToken: 'relogin-refresh',
        ),
      );
      final current = authority.requireFence();
      await outbox.flush(current);
      await outbox.enqueue(
        'old-play',
        const PlayEngagement(
          listenedSeconds: 60,
          completionRatio: 0.3,
          outcome: PlayOutcome.meaningful,
        ),
        current,
      );
      await outbox.flush(current);
      expect(transport.requests, isEmpty);
    },
  );
  test('successful durable high watermark rejects an older late enqueue after restart', () async {
    final authority = await mediaAuthority(Uri.parse('https://report.test'));
    final fence = authority.requireFence();
    final store = ReportingStore();
    final transport = ControlledTransport();
    final repository = RecommendationRepository(transport: transport);
    var outbox = FeedbackOutbox(
      store: store,
      repository: repository,
      authority: authority,
    );
    await outbox.enqueue(
      'known',
      const PlayEngagement(
        listenedSeconds: 40,
        completionRatio: 0.2,
        outcome: PlayOutcome.meaningful,
      ),
      fence,
    );
    await outbox.flush(fence);
    outbox = FeedbackOutbox(
      store: store,
      repository: repository,
      authority: authority,
    );
    await outbox.enqueue(
      'known',
      const PlayEngagement(
        listenedSeconds: 10,
        completionRatio: 0.05,
        outcome: PlayOutcome.skipped,
      ),
      fence,
    );
    await outbox.flush(fence);
    expect(transport.requests.length, 1);
  });
  test('explicit offline policy preserves durable retry budget', () async {
    final authority = await mediaAuthority(Uri.parse('https://report.test'));
    final fence = authority.requireFence();
    final store = ReportingStore();
    final transport = ControlledTransport();
    final repository = RecommendationRepository(transport: transport);
    var outbox = FeedbackOutbox(
      store: store,
      repository: repository,
      authority: authority,
      networkPolicy: const NetworkPolicy.offline(),
    );
    await outbox.enqueue(
      'known',
      const PlayEngagement(
        listenedSeconds: 10,
        completionRatio: 0.05,
        outcome: PlayOutcome.meaningful,
      ),
      fence,
    );
    for (var i = 0; i < 10; i++) {
      await outbox.flush(fence);
    }
    expect(transport.requests, isEmpty);
    outbox = FeedbackOutbox(
      store: store,
      repository: repository,
      authority: authority,
    );
    await outbox.flush(fence);
    expect(transport.requests.length, 1);
  });
  test(
    'durable restart coalesces monotonically; retries bounded across restart',
    () async {
      final authority = await mediaAuthority(Uri.parse('https://report.test'));
      final fence = authority.requireFence();
      final store = ReportingStore();
      final transport = ControlledTransport()
        ..respond = (_) async => const ApiResponse(503, {});
      final repository = RecommendationRepository(transport: transport);
      var outbox = FeedbackOutbox(
        store: store,
        repository: repository,
        authority: authority,
      );
      await outbox.enqueue(
        'known',
        const PlayEngagement(
          listenedSeconds: 20,
          completionRatio: 0.1,
          outcome: PlayOutcome.meaningful,
        ),
        fence,
      );
      await outbox.enqueue(
        'known',
        const PlayEngagement(
          listenedSeconds: 10,
          completionRatio: 0.05,
          outcome: PlayOutcome.skipped,
        ),
        fence,
      );
      outbox = FeedbackOutbox(
        store: store,
        repository: repository,
        authority: authority,
      );
      for (var i = 0; i < 20; i++) {
        await outbox.flush(fence);
      }
      expect(transport.requests.length, 3);
      expect(transport.requests.first.body!['listenedSeconds'], 20);
      expect(transport.requests.first.body!['outcome'], 'meaningful');
      outbox = FeedbackOutbox(
        store: store,
        repository: repository,
        authority: authority,
      );
      await outbox.flush(fence);
      expect(transport.requests.length, 3);
    },
  );
  test(
    'ack of older in-flight payload cannot delete a newer durable total',
    () async {
      final authority = await mediaAuthority(Uri.parse('https://report.test'));
      final fence = authority.requireFence();
      final store = ReportingStore();
      final transport = ControlledTransport();
      final delayed = Completer<ApiResponse>();
      transport.respond = (_) => delayed.future;
      final outbox = FeedbackOutbox(
        store: store,
        repository: RecommendationRepository(transport: transport),
        authority: authority,
      );
      await outbox.enqueue(
        'known',
        const PlayEngagement(
          listenedSeconds: 10,
          completionRatio: 0.05,
          outcome: PlayOutcome.meaningful,
        ),
        fence,
      );
      final flushing = outbox.flush(fence);
      await settle();
      await outbox.enqueue(
        'known',
        const PlayEngagement(
          listenedSeconds: 20,
          completionRatio: 0.1,
          outcome: PlayOutcome.meaningful,
        ),
        fence,
      );
      delayed.complete(const ApiResponse(200, {'success': true}));
      await flushing;
      transport.respond = (_) async =>
          const ApiResponse(200, {'success': true});
      await outbox.flush(fence);
      expect(transport.requests.last.body!['listenedSeconds'], 20);
      final count = transport.requests.length;
      await outbox.flush(fence);
      expect(transport.requests.length, count);
    },
  );
  test('logout forbids known-play replay', () async {
    final authority = await mediaAuthority(Uri.parse('https://report.test'));
    final fence = authority.requireFence();
    final transport = ControlledTransport();
    final outbox = FeedbackOutbox(
      store: ReportingStore(),
      repository: RecommendationRepository(transport: transport),
      authority: authority,
    );
    await outbox.enqueue(
      'known',
      const PlayEngagement(
        listenedSeconds: 10,
        completionRatio: 0.05,
        outcome: PlayOutcome.meaningful,
      ),
      fence,
    );
    await authority.invalidate();
    await outbox.flush(fence);
    expect(transport.requests, isEmpty);
  });
}
