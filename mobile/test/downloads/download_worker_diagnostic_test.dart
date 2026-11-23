import 'dart:async';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/downloads/download_work_diagnostic.dart';
import 'package:soundspan/downloads/download_worker_bridge.dart';
import 'package:soundspan/downloads/download_worker_entrypoint.dart';
import 'package:soundspan/downloads/download_coordinator.dart';
import 'package:soundspan/downloads/download_models.dart';

import 'download_fixture.dart';

void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  HttpOverrides.global = null;
  for (final error in [
    StateError('https://private.invalid?token=secret'),
    const FormatException('https://private.invalid?token=secret'),
  ]) {
    for (final observerThrows in [false, true]) {
      test(
        'actual transfer reports closed ${DownloadWorkDiagnostic.errorCode(error)} cause without changing failed result, observerThrows=$observerThrows',
        () async {
          final h = await DownloadHarness.create();
          addTearDown(h.close);
          final observed = <String>[];
          void observe(Object value) {
            observed.add(DownloadWorkDiagnostic.errorCode(value));
            if (observerThrows) throw StateError('observer private error');
          }

          final runner = DownloadCoordinator(
            repository: h.repo,
            resolverForQuality: h.runner.resolverForQuality,
            fetcher: h.runner.fetcher,
            networkPolicy: h.runner.networkPolicy,
            beforeWrite: (_) async => throw error,
            onError: observe,
          );
          addTearDown(runner.close);
          final job = await h.repo.enqueue(
            DownloadHarness.track,
            'original',
            h.fence,
          );
          expect(
            await runner.run(job.id, h.fence, job.generation),
            DownloadRunResult.failed,
          );
          final latest = (await h.repo.status(job.id, h.fence))!;
          expect(latest.state, DownloadState.failed);
          expect(latest.errorCode, 'download_failed');
          expect(latest.writer, isNull);
          expect(h.requests, hasLength(1));
          expect(observed, [DownloadWorkDiagnostic.errorCode(error)]);
          expect(
            DownloadWorkDiagnostic.fileErrorCode(
              latest.errorCode,
              observed.single,
            ),
            DownloadWorkDiagnostic.errorCode(error),
          );
        },
      );
    }
  }
  test('file diagnostic refines only persisted generic failure and keeps closed codes', () {
    expect(
      DownloadWorkDiagnostic.fileErrorCode('download_failed', 'state'),
      'state',
    );
    expect(
      DownloadWorkDiagnostic.fileErrorCode('download_failed', 'format'),
      'format',
    );
    expect(
      DownloadWorkDiagnostic.fileErrorCode('download_failed', null),
      'download_failed',
    );
    expect(
      DownloadWorkDiagnostic.fileErrorCode('http_error', 'state'),
      'http_error',
    );
    expect(
      DownloadWorkDiagnostic.fileErrorCode(
        'download_network_restricted',
        'format',
      ),
      'download_network_restricted',
    );
    expect(DownloadWorkDiagnostic.fileErrorCode(null, 'state'), 'none');
    expect(
      DownloadWorkDiagnostic.fileErrorCode(
        'download_failed',
        'https://private.invalid?token=secret',
      ),
      'app_failure_other',
    );
  });
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
