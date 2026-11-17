import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/storage/owner_store.dart';
import 'package:soundspan/downloads/automatic_download_control.dart';
import 'package:soundspan/downloads/download_network_rules.dart';
import 'package:soundspan/downloads/stored_download_network_rules.dart';

import 'download_fixture.dart';

void main() {
  late DownloadHarness h;
  setUp(() async => h = await DownloadHarness.create());
  tearDown(() async => h.close());
  Future<Map<String, Object?>?> read(String ns, String key) =>
      h.store.transaction(h.fence, (tx) => tx.read(ns, key));

  test(
    'first restore persists unmetered rules and the legacy stop barrier',
    () async {
      final rules = await loadDownloadNetworkRules(h.store, h.fence);
      expect(rules.mode, DownloadNetworkMode.unmetered);
      expect(
        await read(DownloadNetworkRules.namespace, DownloadNetworkRules.key),
        rules.encode(),
      );
      expect(
        await read(
          AutomaticDownloadControl.namespace,
          AutomaticDownloadControl.key,
        ),
        {'version': 2, 'paused': false},
      );
    },
  );

  for (final paused in [false, true]) {
    test('legacy paused=$paused survives policy activation', () async {
      await h.store.transaction(
        h.fence,
        (tx) => tx.write(
          AutomaticDownloadControl.namespace,
          AutomaticDownloadControl.key,
          {'version': 1, 'paused': paused},
        ),
      );
      await loadDownloadNetworkRules(h.store, h.fence);
      expect(
        await read(
          AutomaticDownloadControl.namespace,
          AutomaticDownloadControl.key,
        ),
        {'version': 2, 'paused': paused},
      );
    });
  }

  test(
    'future rules stay byte-equivalent and still close legacy automation',
    () async {
      final future = {
        'version': 2,
        'mode': 'any',
        'allowRoaming': true,
        'futureField': 7,
      };
      await h.store.transaction(
        h.fence,
        (tx) => tx.write(
          DownloadNetworkRules.namespace,
          DownloadNetworkRules.key,
          future,
        ),
      );
      await expectLater(
        loadDownloadNetworkRules(h.store, h.fence),
        throwsA(isA<AppFailure>()),
      );
      expect(
        await read(DownloadNetworkRules.namespace, DownloadNetworkRules.key),
        future,
      );
      expect(
        await read(
          AutomaticDownloadControl.namespace,
          AutomaticDownloadControl.key,
        ),
        {'version': 2, 'paused': false},
      );
    },
  );

  test(
    'future automatic control is preserved and cannot be enabled by restore',
    () async {
      final future = {'version': 3, 'paused': false, 'newRule': 'unknown'};
      await h.store.transaction(
        h.fence,
        (tx) => tx.write(
          AutomaticDownloadControl.namespace,
          AutomaticDownloadControl.key,
          future,
        ),
      );
      await loadDownloadNetworkRules(h.store, h.fence);
      expect(
        await read(
          AutomaticDownloadControl.namespace,
          AutomaticDownloadControl.key,
        ),
        future,
      );
      expect(AutomaticDownloadControl.paused(future), isTrue);
    },
  );

  test(
    'explicit choice survives a fresh reader without changing offline mode',
    () async {
      await h.store.transaction(
        h.fence,
        (tx) =>
            tx.write('settings', 'network', {'version': 1, 'offline': false}),
      );
      const rules = DownloadNetworkRules(
        mode: DownloadNetworkMode.wifi,
        allowRoaming: true,
      );
      await saveDownloadNetworkRules(h.store, h.fence, rules);
      expect(
        (await loadDownloadNetworkRules(h.store, h.fence)).encode(),
        rules.encode(),
      );
      expect(await read('settings', 'network'), {
        'version': 1,
        'offline': false,
      });
    },
  );

  test(
    'failed durable setting cannot leave half of the migration committed',
    () async {
      final store = _FailNetworkWrite(h.store);
      await expectLater(
        saveDownloadNetworkRules(
          store,
          h.fence,
          const DownloadNetworkRules(mode: DownloadNetworkMode.any),
        ),
        throwsA(isA<StateError>()),
      );
      expect(
        await read(DownloadNetworkRules.namespace, DownloadNetworkRules.key),
        isNull,
      );
      expect(
        await read(
          AutomaticDownloadControl.namespace,
          AutomaticDownloadControl.key,
        ),
        isNull,
      );
    },
  );

  test('revoked owner cannot commit a queued rules update', () async {
    final gate = Completer<void>();
    h.store.tail = gate.future;
    final original = h.fence;
    final pending = saveDownloadNetworkRules(
      h.store,
      original,
      const DownloadNetworkRules(mode: DownloadNetworkMode.any),
    );
    final rejected = expectLater(pending, throwsA(isA<AppFailure>()));
    await h.authority.invalidate();
    gate.complete();
    await rejected;
    expect(h.store.rows, isEmpty);
  });
}

class _FailNetworkWrite implements OwnerStore {
  _FailNetworkWrite(this.inner);
  final OwnerStore inner;
  @override
  Future<T> transaction<T>(
    SessionFence fence,
    Future<T> Function(OwnerTransaction) body,
  ) => inner.transaction(fence, (tx) => body(_FailNetworkTx(tx)));
}

class _FailNetworkTx implements OwnerTransaction {
  _FailNetworkTx(this.inner);
  final OwnerTransaction inner;
  @override
  Future<Map<String, Object?>?> read(String ns, String key) =>
      inner.read(ns, key);
  @override
  Future<void> write(String ns, String key, Map<String, Object?> value) {
    if (ns == DownloadNetworkRules.namespace &&
        key == DownloadNetworkRules.key) {
      throw StateError('Injected setting commit failure');
    }
    return inner.write(ns, key, value);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
