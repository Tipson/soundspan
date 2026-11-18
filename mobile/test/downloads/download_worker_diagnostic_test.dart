import 'dart:async';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/downloads/download_work_diagnostic.dart';
import 'package:soundspan/downloads/download_worker_bridge.dart';
import 'package:soundspan/downloads/download_worker_entrypoint.dart';

void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  const worker = MethodChannel('soundspan/download_worker');
  const broker = MethodChannel('soundspan/session_client');
  const codec = StandardMethodCodec();
  final fence = SessionFence(
    owner: OwnerKey(
      serverOrigin: Uri.parse('https://fixture.invalid'),
      userId: 'fixture-owner',
    ),
    epoch: 1,
  );
  for (final code in [
    'stale_session',
    'https://private.invalid?token=secret',
  ]) {
    test(
      'real entrypoint retains attach failure semantics and emits only a safe code: ${code == 'stale_session' ? 'known' : 'unknown'}',
      () async {
        binding.defaultBinaryMessenger.setMockMethodCallHandler(
          worker,
          (_) async => null,
        );
        binding.defaultBinaryMessenger.setMockMethodCallHandler(broker, (
          call,
        ) async {
          if (call.method == 'release') return null;
          return {
            'v': 1,
            'ok': false,
            'error': {'code': code, 'retryable': false, 'statusCode': null},
          };
        });
        addTearDown(() {
          binding.defaultBinaryMessenger.setMockMethodCallHandler(worker, null);
          binding.defaultBinaryMessenger.setMockMethodCallHandler(broker, null);
          worker.setMethodCallHandler(null);
        });
        await runDownloadWorker();
        final reply = Completer<ByteData?>();
        binding.channelBuffers.push(
          'soundspan/download_worker',
          codec.encodeMethodCall(
            MethodCall('run', DownloadWorkRequest('a' * 64, fence, 1).encode()),
          ),
          reply.complete,
        );
        final result = Map<Object?, Object?>.from(
          codec.decodeEnvelope((await reply.future)!) as Map,
        );
        expect(result['outcome'], 'cancelled');
        expect(result['retryAfterMillis'], 0);
        expect(result['diagnostic'], {
          'phase': 'attach',
          'code': code == 'stale_session'
              ? 'stale_session'
              : 'app_failure_other',
          'state': 'unknown',
        });
        expect(result.toString(), isNot(contains('private.invalid')));
        expect(result.toString(), isNot(contains('fixture-owner')));
      },
    );
  }
  test(
    'a failed drain remains failed and reports only the drain type bucket',
    () async {
      binding.defaultBinaryMessenger.setMockMethodCallHandler(
        worker,
        (_) async => null,
      );
      binding.defaultBinaryMessenger.setMockMethodCallHandler(broker, (
        call,
      ) async {
        if (call.method == 'release') {
          throw PlatformException(
            code: 'private',
            message: 'https://private.invalid?token=secret',
          );
        }
        return {
          'v': 1,
          'ok': false,
          'error': {
            'code': 'stale_session',
            'retryable': false,
            'statusCode': null,
          },
        };
      });
      addTearDown(() {
        binding.defaultBinaryMessenger.setMockMethodCallHandler(worker, null);
        binding.defaultBinaryMessenger.setMockMethodCallHandler(broker, null);
        worker.setMethodCallHandler(null);
      });
      await runDownloadWorker();
      final reply = Completer<ByteData?>();
      binding.channelBuffers.push(
        'soundspan/download_worker',
        codec.encodeMethodCall(
          MethodCall('run', DownloadWorkRequest('a' * 64, fence, 1).encode()),
        ),
        reply.complete,
      );
      final result = codec.decodeEnvelope((await reply.future)!) as Map;
      expect(result['outcome'], 'failed');
      expect(result['retryAfterMillis'], 0);
      expect(result['diagnostic'], {
        'phase': 'drain',
        'code': 'platform',
        'state': 'unknown',
      });
      expect(result.toString(), isNot(contains('private.invalid')));
    },
  );
  test('optional status failure is diagnostic-only and never contains exception text', () async {
    final result = await DownloadWorkDiagnostic.inspect(
      phase: DownloadWorkerPhase.refresh,
      read: () async =>
          throw const FormatException('https://private.invalid?token=secret'),
    );
    expect(result, {'phase': 'refresh', 'code': 'format', 'state': 'unknown'});
    expect(result.toString(), isNot(contains('private.invalid')));
  });
  test('closed code/state projection keeps useful type buckets and discards arbitrary strings', () {
    for (final error in [
      const FormatException('private'),
      StateError('private'),
      PlatformException(code: 'private', message: 'private'),
      TimeoutException('private'),
      const FileSystemException('private'),
    ]) {
      expect(
        DownloadWorkDiagnostic.errorCode(error),
        isIn(['format', 'state', 'platform', 'timeout', 'io']),
      );
    }
    expect(
      DownloadWorkDiagnostic.errorCode(
        const AppFailure(
          code: 'http_error',
          message: 'private',
          statusCode: 502,
        ),
      ),
      'http_502',
    );
    expect(
      DownloadWorkDiagnostic.errorCode(
        const AppFailure(code: 'opaque_user_identifier', message: 'private'),
      ),
      'app_failure_other',
    );
    expect(
      DownloadWorkDiagnostic.safeState('waiting/queued'),
      'waiting/queued',
    );
    for (final raw in [
      'https://private.invalid',
      'D:/private/file',
      'waiting/opaque_user',
      'future',
    ]) {
      expect(DownloadWorkDiagnostic.safeState(raw), 'unknown');
    }
    expect(DownloadWorkDiagnostic.safeState(''), 'idle');
  });
}
