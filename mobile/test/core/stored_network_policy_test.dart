import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/network/stored_network_policy.dart';
import 'package:soundspan/core/storage/owner_store.dart';

import '../support/collection_fixtures.dart';
import '../support/wave_reporting_fixtures.dart';

void main() {
  late CollectionAuthority authority;
  late _GatedStore store;
  final stops = <SessionFence>[];

  setUp(() {
    authority = CollectionAuthority()..restoreLocally();
    store = _GatedStore(authority);
    stops.clear();
  });
  tearDown(() => authority.updates.close());

  Future<StoredNetworkPolicy> restore({
    Future<void> Function(SessionFence)? stop,
  }) => StoredNetworkPolicy.restore(
    store: store,
    authority: authority,
    fence: collectionFence,
    onOffline: stop ?? (fence) async => stops.add(fence),
  );

  test(
    'missing preference allows locally restored online session, no HTTP',
    () async {
      final policy = await restore();
      addTearDown(policy.dispose);
      expect(policy.networkAllowed, isTrue);
      expect(policy.offline, isFalse);
      expect(policy.requireNetwork, returnsNormally);
      expect(stops, isEmpty);
    },
  );

  test(
    'offline blocks synchronously, cancels work, persists and cold restores',
    () async {
      final policy = await restore();
      addTearDown(policy.dispose);
      store.gate = Completer<void>();
      final pending = policy.setOffline(true);
      expect(policy.networkAllowed, isFalse);
      expect(policy.requireNetwork, throwsA(isA<AppFailure>()));
      await Future<void>.delayed(Duration.zero);
      expect(stops, [collectionFence]);
      store.gate!.complete();
      await pending;
      final saved = await store.transaction(
        collectionFence,
        (tx) => tx.read('settings', 'network'),
      );
      expect(saved, {'version': 1, 'offline': true});
      final cold = await restore();
      addTearDown(cold.dispose);
      expect(cold.networkAllowed, isFalse);
      expect(cold.offline, isTrue);
    },
  );

  for (final corrupt in [
    {'version': 2, 'offline': false},
    {'version': 1, 'offline': 'false'},
    {'version': 1, 'offline': false, 'unknown': true},
  ]) {
    test(
      'invalid durable preference stays blocked and can be explicitly repaired: $corrupt',
      () async {
        await store.transaction(
          collectionFence,
          (tx) => tx.write('settings', 'network', corrupt),
        );
        final policy = await restore();
        addTearDown(policy.dispose);
        expect(policy.networkAllowed, isFalse);
        expect(policy.failure?.code, 'invalid_network_preference');
        await policy.setOffline(false);
        expect(policy.failure, isNull);
        expect(policy.networkAllowed, isTrue);
      },
    );
  }

  test(
    'online waits for durable write; write failure remains fail closed',
    () async {
      final policy = await restore();
      addTearDown(policy.dispose);
      await policy.setOffline(true);
      store.fail = true;
      await expectLater(policy.setOffline(false), throwsA(isA<AppFailure>()));
      expect(policy.networkAllowed, isFalse);
      expect(policy.failure, isNotNull);
      store.fail = false;
      await policy.setOffline(false);
      expect(policy.networkAllowed, isTrue);
    },
  );

  test(
    'latest rapid choice wins only after cancellation and writes drain',
    () async {
      final stopped = Completer<void>();
      final policy = await restore(stop: (_) => stopped.future);
      addTearDown(policy.dispose);
      final off = policy.setOffline(true);
      final on = policy.setOffline(false);
      expect(policy.networkAllowed, isFalse);
      await Future<void>.delayed(Duration.zero);
      expect(policy.networkAllowed, isFalse);
      stopped.complete();
      await Future.wait([off, on]);
      expect(policy.networkAllowed, isTrue);
      expect(
        await store.transaction(
          collectionFence,
          (tx) => tx.read('settings', 'network'),
        ),
        {'version': 1, 'offline': false},
      );
    },
  );

  test(
    'revoked old-owner write cannot reopen network or update new owner',
    () async {
      final policy = await restore();
      addTearDown(policy.dispose);
      await policy.setOffline(true);
      store.gate = Completer<void>();
      final pending = policy.setOffline(false);
      final rejected = expectLater(pending, throwsA(isA<AppFailure>()));
      await Future<void>.delayed(Duration.zero);
      authority.switchOwner();
      store.gate!.complete();
      await rejected;
      expect(policy.networkAllowed, isFalse);
      await expectLater(policy.setOffline(false), throwsA(isA<AppFailure>()));
    },
  );

  for (final latestOffline in [true, false]) {
    test(
      'reentrant listener preserves durable latest offline=$latestOffline',
      () async {
        final policy = await restore();
        addTearDown(policy.dispose);
        await policy.setOffline(latestOffline);
        Future<void>? nested;
        var triggered = false;
        policy.addListener(() {
          if (!triggered && policy.busy && policy.offline != latestOffline) {
            triggered = true;
            nested = policy.setOffline(latestOffline);
          }
        });
        await policy.setOffline(!latestOffline);
        await nested;
        expect(policy.offline, latestOffline);
        final row = await store.transaction(
          collectionFence,
          (tx) => tx.read('settings', 'network'),
        );
        expect(row, {'version': 1, 'offline': latestOffline});
        final cold = await restore();
        addTearDown(cold.dispose);
        expect(cold.networkAllowed, !latestOffline);
      },
    );
  }

  test(
    'close drains an in-flight owner cancellation before replacement admission',
    () async {
      final entered = Completer<void>();
      final release = Completer<void>();
      var cancelled = false;
      final policy = await restore(
        stop: (_) async {
          entered.complete();
          await release.future;
          cancelled = true;
        },
      );
      addTearDown(policy.dispose);
      final command = policy.setOffline(true);
      final rejected = expectLater(command, throwsA(isA<AppFailure>()));
      await entered.future;
      var closed = false;
      final closing = policy.close().then((_) => closed = true);
      await Future<void>.delayed(Duration.zero);
      expect(closed, isFalse);
      expect(policy.networkAllowed, isFalse);
      release.complete();
      await closing;
      await rejected;
      expect(cancelled, isTrue);
      await expectLater(policy.setOffline(false), throwsA(isA<AppFailure>()));
    },
  );
}

final class _GatedStore implements OwnerStore {
  _GatedStore(this.authority);
  final CollectionAuthority authority;
  final delegate = ReportingStore();
  Completer<void>? gate;
  bool fail = false;
  @override
  Future<T> transaction<T>(
    SessionFence fence,
    Future<T> Function(OwnerTransaction) operation,
  ) async {
    await gate?.future;
    await authority.assertCurrent(fence);
    if (fail) throw StateError('injected storage error');
    return delegate.transaction(fence, operation);
  }
}
