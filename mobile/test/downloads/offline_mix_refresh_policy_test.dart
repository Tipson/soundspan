import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/downloads/offline_mix_refresh_policy.dart';

import '../support/collection_fixtures.dart';
import '../support/wave_reporting_fixtures.dart';

extension _CurrentRefreshAttempt on OfflineMixRefreshPolicy {
  Future<OfflineMixRefreshTicket?> attempt({
    required bool charging,
    required bool unmetered,
  }) async => claim(
    charging: charging,
    unmetered: unmetered,
    expectedRevision: (await read()).revision,
  );
}

void main() {
  late ReportingStore store;
  late DateTime now;
  late OfflineMixRefreshPolicy policy;
  setUp(() {
    store = ReportingStore();
    now = DateTime.utc(2026, 11, 18, 4);
    policy = OfflineMixRefreshPolicy(
      store: store,
      fence: collectionFence,
      clock: () => now,
    );
  });
  Future<void> enable() => policy.configure(
    enabled: true,
    sourceIdentity: 'daily:opaque-Mix-1',
    quality: 'high',
  );

  test('refresh defaults off and requires explicit source', () async {
    expect((await policy.read()).enabled, isFalse);
    expect(await policy.attempt(charging: true, unmetered: true), isNull);
    await expectLater(policy.configure(enabled: true), throwsArgumentError);
  });

  test('an old scheduled revision cannot launch a re-enabled policy', () async {
    await enable();
    final oldRevision = (await policy.read()).revision;
    await policy.configure(enabled: false);
    await enable();
    expect(
      await policy.claim(
        charging: true,
        unmetered: true,
        expectedRevision: oldRevision,
      ),
      isNull,
    );
    expect(
      await policy.claim(
        charging: true,
        unmetered: true,
        expectedRevision: (await policy.read()).revision,
      ),
      isNotNull,
    );
  });

  test(
    'saved exact source survives recreation; both conditions are mandatory',
    () async {
      await enable();
      final restored = OfflineMixRefreshPolicy(
        store: store,
        fence: collectionFence,
        clock: () => now,
      );
      final state = await restored.read();
      expect(state.sourceIdentity, 'daily:opaque-Mix-1');
      expect(state.quality, 'high');
      expect(await restored.attempt(charging: false, unmetered: true), isNull);
      expect(await restored.attempt(charging: true, unmetered: false), isNull);
      expect(
        await restored.attempt(charging: true, unmetered: true),
        isNotNull,
      );
    },
  );

  test(
    'two instances share one attempt and disabling retires its late finish',
    () async {
      await enable();
      final other = OfflineMixRefreshPolicy(
        store: store,
        fence: collectionFence,
        clock: () => now,
      );
      final tickets = await Future.wait([
        policy.attempt(charging: true, unmetered: true),
        other.attempt(charging: true, unmetered: true),
      ]);
      expect(tickets.whereType<OfflineMixRefreshTicket>(), hasLength(1));
      final ticket = tickets.whereType<OfflineMixRefreshTicket>().single;
      expect(await other.isCurrent(ticket), isTrue);
      await other.configure(enabled: false);
      expect(await policy.isCurrent(ticket), isFalse);
      expect(await policy.finish(ticket, success: true), isFalse);
      expect((await other.read()).enabled, isFalse);
    },
  );

  test(
    'failure retries; only success holds refresh for twenty-four hours',
    () async {
      await enable();
      final first = (await policy.attempt(charging: true, unmetered: true))!;
      expect(await policy.finish(first, success: false), isTrue);
      final second = (await policy.attempt(charging: true, unmetered: true))!;
      expect(second.nonce, isNot(first.nonce));
      expect(await policy.finish(second, success: true), isTrue);
      now = now.add(const Duration(hours: 23, minutes: 59));
      expect(await policy.attempt(charging: true, unmetered: true), isNull);
      now = now.add(const Duration(minutes: 1));
      expect(await policy.attempt(charging: true, unmetered: true), isNotNull);
    },
  );

  test(
    'expired orchestration attempt cannot complete its replacement',
    () async {
      await enable();
      final old = (await policy.attempt(charging: true, unmetered: true))!;
      now = now.add(OfflineMixRefreshPolicy.attemptLease);
      final current = (await policy.attempt(charging: true, unmetered: true))!;
      expect(await policy.isCurrent(old), isFalse);
      expect(await policy.finish(old, success: true), isFalse);
      expect(await policy.isCurrent(current), isTrue);
    },
  );

  test(
    'new target invalidates old ticket and never inherits its success date',
    () async {
      await enable();
      final old = (await policy.attempt(charging: true, unmetered: true))!;
      await policy.configure(
        enabled: true,
        sourceIdentity: 'weekly:weekly',
        quality: 'original',
      );
      expect(await policy.finish(old, success: true), isFalse);
      final next = (await policy.attempt(charging: true, unmetered: true))!;
      expect(next.sourceIdentity, 'weekly:weekly');
      expect(next.quality, 'original');
    },
  );

  test(
    'future policy fails closed and cannot be overwritten by configuration',
    () async {
      await store.transaction(
        collectionFence,
        (tx) => tx.write(
          OfflineMixRefreshPolicy.namespace,
          OfflineMixRefreshPolicy.key,
          {'version': 2, 'enabled': true},
        ),
      );
      await expectLater(policy.read(), throwsFormatException);
      await expectLater(enable(), throwsFormatException);
      await expectLater(
        policy.attempt(charging: true, unmetered: true),
        throwsFormatException,
      );
      final row = await store.transaction(
        collectionFence,
        (tx) => tx.read(
          OfflineMixRefreshPolicy.namespace,
          OfflineMixRefreshPolicy.key,
        ),
      );
      expect(row, {'version': 2, 'enabled': true});
    },
  );

  test(
    'replacement same-owner epoch cannot borrow a previous attempt',
    () async {
      await enable();
      final old = (await policy.attempt(charging: true, unmetered: true))!;
      final replacement = OfflineMixRefreshPolicy(
        store: store,
        fence: SessionFence(
          owner: collectionOwner,
          epoch: collectionFence.epoch + 1,
        ),
        clock: () => now,
      );
      expect(await replacement.isCurrent(old), isFalse);
      final next = (await replacement.attempt(
        charging: true,
        unmetered: true,
      ))!;
      expect(next.fence, replacement.fence);
      expect(await replacement.finish(old, success: true), isFalse);
      expect(await replacement.isCurrent(next), isTrue);
    },
  );
}
