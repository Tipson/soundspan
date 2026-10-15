import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/downloads/download_worker_bridge.dart';
import 'package:soundspan/downloads/android_media_probe.dart';
import 'package:soundspan/downloads/download_worker_entrypoint.dart';

import 'download_fixture.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final fence = SessionFence(
    owner: OwnerKey(
      serverOrigin: Uri.parse('https://fixture.invalid'),
      userId: 'opaque/user',
    ),
    epoch: 1,
  );
  final id = 'a' * 64;
  test(
    'durable explicit offline policy is fenced and malformed fails closed',
    () async {
      final h = await DownloadHarness.create();
      try {
        expect(
          (await loadDownloadNetworkPolicy(h.store, h.fence)).networkAllowed,
          true,
        );
        await h.store.transaction(
          h.fence,
          (tx) =>
              tx.write('settings', 'network', {'version': 1, 'offline': true}),
        );
        expect(
          (await loadDownloadNetworkPolicy(h.store, h.fence)).networkAllowed,
          false,
        );
        for (final malformed in [
          {'version': 2, 'offline': false},
          {'version': 1, 'offline': 'false'},
          {'offline': false},
        ]) {
          await h.store.transaction(
            h.fence,
            (tx) => tx.write('settings', 'network', malformed),
          );
          await expectLater(
            loadDownloadNetworkPolicy(h.store, h.fence),
            throwsA(anything),
          );
        }
      } finally {
        await h.close();
      }
    },
  );
  test('worker wire preserves original epoch and generation exactly', () {
    final job = DownloadWorkRequest(id, fence, 7);
    final copy = DownloadWorkRequest.decode(job.encode());
    expect(copy.originalFence, fence);
    expect(copy.generation, 7);
    expect(copy.downloadId, id);
    expect(job.encode().keys.toSet(), {'downloadId', 'fence', 'generation'});
  });
  test('worker wire rejects secrets, URLs, invalid epoch and generation', () {
    final valid = DownloadWorkRequest(id, fence, 1).encode();
    for (final bad in [
      {...valid, 'token': 'secret'},
      {...valid, 'downloadId': 'https://foreign.invalid/file'},
      {...valid, 'generation': 0},
      {...valid, 'generation': 1.0},
      {
        ...valid,
        'fence': {
          'owner': {'origin': 'https://fixture.invalid', 'userId': 'a'},
          'epoch': 0,
        },
      },
      {
        ...valid,
        'fence': {
          'owner': {'origin': 'https://fixture.invalid/path', 'userId': 'a'},
          'epoch': 1,
        },
      },
    ]) {
      expect(() => DownloadWorkRequest.decode(bad), throwsA(anything));
    }
  });
  test('schedule sends closed payload; callback only returns WorkId', () async {
    const channel = MethodChannel('soundspan/downloads');
    MethodCall? sent;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          sent = call;
          return 'work-id';
        });
    expect(
      await const DownloadWorkerBridge().schedule(id, fence, 9),
      'work-id',
    );
    expect(sent!.method, 'schedule');
    expect(DownloadWorkRequest.decode(sent!.arguments).generation, 9);
  });
  test(
    'probe rejects malformed, false and zero duration native responses',
    () async {
      const channel = MethodChannel('soundspan/media_probe');
      for (final response in [
        null,
        {'decodable': true, 'durationUs': 0},
        {'decodable': false, 'durationUs': 1000},
        {'decodable': true, 'durationUs': 1.5},
      ]) {
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(channel, (_) async => response);
        await expectLater(
          const AndroidMediaProbe().probe(File('/private/audio.part')),
          throwsA(anything),
        );
      }
    },
  );
  test('probe returns positive measured native duration', () async {
    const channel = MethodChannel('soundspan/media_probe');
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          channel,
          (_) async => {'decodable': true, 'durationUs': 3000000},
        );
    final result = await const AndroidMediaProbe().probe(
      File('/private/audio.part'),
    );
    expect(result.decodable, true);
    expect(result.duration, const Duration(seconds: 3));
  });
}
