import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/downloads/device_media_barrier.dart';
import 'package:soundspan/downloads/device_process_scope.dart';
import 'package:soundspan/downloads/download_checkpoint.dart';

import '../support/collection_fixtures.dart';
import '../support/wave_reporting_fixtures.dart';

void main() {
  test(
    'independent: a full mixed reader set reclaims only known dead holders',
    () async {
      final store = ReportingStore();
      final file = DownloadCheckpoint(
        generation: 1,
        claim: 'a' * 48,
        bytes: 256,
      );
      final id = 'b' * 64;
      final oldProcess = DeviceProcessScope.fromNative(
        '11111111-1111-4111-8111-111111111111',
      );
      final currentProcess = DeviceProcessScope.fromNative(
        '22222222-2222-4222-8222-222222222222',
      );
      final oldNonces = <String>[];
      for (var index = 0; index < 63; index++) {
        oldNonces.add(
          (await store.transaction(
            collectionFence,
            (tx) => DeviceMediaBarrier.acquire(
              tx,
              id,
              file,
              collectionFence.epoch,
              processScope: oldProcess,
            ),
          ))!,
        );
      }
      final unknownNonce = (await store.transaction(
        collectionFence,
        (tx) => DeviceMediaBarrier.acquire(tx, id, file, collectionFence.epoch),
      ))!;
      final currentNonce = await store.transaction(
        collectionFence,
        (tx) => DeviceMediaBarrier.acquire(
          tx,
          id,
          file,
          collectionFence.epoch,
          processScope: currentProcess,
        ),
      );
      expect(
        currentNonce,
        isNotNull,
        reason: 'Known dead holders must not exhaust the 64-reader capacity',
      );
      for (final oldNonce in oldNonces) {
        await store.transaction(
          collectionFence,
          (tx) => DeviceMediaBarrier.release(tx, id, file, oldNonce),
        );
      }
      final row = (await store.transaction(
        collectionFence,
        (tx) => tx.read(
          DeviceMediaBarrier.namespace,
          DeviceMediaBarrier.key(id, file),
        ),
      ))!;
      expect((row['readers'] as Map).keys.toSet(), {
        unknownNonce,
        currentNonce,
      });
      await store.transaction(collectionFence, (tx) async {
        final readers = Map<String, Object?>.from(row['readers'] as Map);
        readers[unknownNonce] = {
          'version': 2,
          'epoch': collectionFence.epoch,
          'processInstance': oldProcess.processInstance,
        };
        await tx.write(
          DeviceMediaBarrier.namespace,
          DeviceMediaBarrier.key(id, file),
          {...row, 'readers': readers},
        );
      });
      await store.transaction(
        collectionFence,
        (tx) => DeviceMediaBarrier.release(tx, id, file, currentNonce!),
      );
      expect(
        await store.transaction(
          collectionFence,
          (tx) => DeviceMediaBarrier.reserve(tx, id, [
            file,
          ], processScope: currentProcess),
        ),
        isNull,
        reason: 'A future reader schema remains protected despite its apparently old process field',
      );
      final protectedRow = (await store.transaction(
        collectionFence,
        (tx) => tx.read(
          DeviceMediaBarrier.namespace,
          DeviceMediaBarrier.key(id, file),
        ),
      ))!;
      expect((protectedRow['readers'] as Map).keys, [unknownNonce]);
      expect(protectedRow['state'], 'available');
    },
  );
}
