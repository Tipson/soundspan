import 'dart:async';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:path_provider/path_provider.dart';

import '../core/model/app_failure.dart';
import '../core/model/owner_key.dart';
import '../core/network/dart_api_transport.dart';
import '../core/network/network_policy.dart';
import '../core/session/broker_client.dart';
import '../core/session/native_session_authority_proxy.dart';
import '../core/session/session_broker_protocol.dart';
import '../core/storage/owner_store.dart';
import '../core/storage/sqlite_owner_store.dart';
import '../core/storage/sqlite_session_store.dart';
import '../playback/playback_resolver.dart';
import '../playback/resolved_media.dart';
import 'android_media_probe.dart';
import 'download_coordinator.dart';
import 'download_models.dart';
import 'device_network_monitor.dart';
import 'device_storage_guard.dart';
import 'device_process_scope.dart';
import 'download_network_access.dart';
import 'download_network_policy.dart';
import 'download_repository.dart';
import 'offline_mix_repository.dart';
import 'offline_mix_quota.dart';
import 'download_verifier.dart';
import 'download_worker_bridge.dart';
import 'download_work_diagnostic.dart';
import 'private_media_paths.dart';
import 'offline_mix_daily_factory.dart';
import 'offline_mix_refresh_admission.dart';
import 'protected_media_fetcher.dart';

export 'download_network_policy.dart' show loadDownloadNetworkPolicy;

typedef WorkerNetworkPolicyLoader = Future<NetworkPolicy> Function(
  OwnerStore store,
  SessionFence fence,
);

/// Production calls with defaults. An integration-only entrypoint may supply a
/// local test CA; neither WorkData nor a platform message can configure trust.
Future<void> runDownloadWorker({
  WorkerNetworkPolicyLoader loadNetworkPolicy = loadDownloadNetworkPolicy,
  SecurityContext? testSecurityContext,
}) async {
  WidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('soundspan/download_worker');
  DownloadCoordinator? coordinator;
  bool stopped = false;
  bool started = false;
  var phase = DownloadWorkerPhase.attach;
  Future<Map<String, Object?>>? running;
  Map<String, Object?> outcome(
    String state, [
    int delay = 0,
    Map<String, Object?>? diagnostic,
  ]) => {
    'outcome': state,
    'retryAfterMillis': delay,
    'diagnostic': diagnostic ?? DownloadWorkDiagnostic.capture(phase: phase),
  };

  Future<Map<String, Object?>> execute(Object? arguments) async {
    final refreshRequest = arguments is Map && arguments.containsKey('kind')
        ? OfflineMixRefreshRequest.decode(arguments)
        : null;
    final request = refreshRequest == null
        ? DownloadWorkRequest.decode(arguments)
        : null;
    final originalFence =
        refreshRequest?.originalFence ?? request!.originalFence;
    BrokerClient? client;
    SqliteSessionStore? sessions;
    StreamSubscription? revocations;
    Timer? progress;
    Future<void>? pendingProgress;
    DeviceNetworkMonitor? deviceNetwork;
    VoidCallback? routeChanged;
    try {
      if (stopped) return outcome('cancelled');
      phase = DownloadWorkerPhase.attach;
      client = BrokerClient(MethodChannelBrokerTransport());
      final authority = await NativeSessionAuthorityProxy.attach(
        client,
        ClientRole.download,
        expectedFence: originalFence,
      );
      if (stopped) return outcome('cancelled');
      await authority.assertCurrent(originalFence);
      phase = DownloadWorkerPhase.storage;
      sessions = await SqliteSessionStore.open();
      final owners = SqliteOwnerStore(sessions);
      phase = DownloadWorkerPhase.network;
      final policy = await loadNetworkPolicy(owners, originalFence);
      phase = DownloadWorkerPhase.storage;
      final support = await getApplicationSupportDirectory();
      final canonicalSupport = await support.resolveSymbolicLinks();
      final paths = await PrivateMediaPaths.create(
        Directory('$canonicalSupport/device-media'),
      );
      final repository = DownloadRepository(
        store: owners,
        authority: authority,
        paths: paths,
        verifier: const DownloadVerifier(probe: AndroidMediaProbe()),
        processScope: await DeviceProcessScope.read(),
        beforeRemove: (_) async {
          throw StateError('Worker cannot remove media');
        },
      );
      final api = DartApiTransport(
        client: DartJsonHttpClient(networkPolicy: policy),
        authority: authority,
      );
      phase = DownloadWorkerPhase.network;
      deviceNetwork = DeviceNetworkMonitor();
      await deviceNetwork.start();
      final access = DownloadNetworkAccess(
        repository: repository,
        fence: originalFence,
        policy: policy,
        readNetwork: () async => deviceNetwork!.value,
      );
      final mixes = OfflineMixRepository(
        downloads: repository,
        fence: originalFence,
      );
      final daily = createOfflineMixDailyRefresh(
        downloads: repository,
        mixes: mixes,
        transport: api,
        authority: authority,
        networkPolicy: policy,
        monitor: deviceNetwork,
        access: access,
        guard: () async {
          if (stopped) throw mediaCancelled;
          await authority.assertCurrent(originalFence);
          if (stopped) throw mediaCancelled;
        },
      );
      final quota = OfflineMixQuota(
        repository: repository,
        fence: originalFence,
        evict: (captured) =>
            repository.evictIfUnprotected(captured, originalFence),
        recover: () => repository.recoverRemovals(originalFence),
      );
      coordinator = DownloadCoordinator(
        repository: repository,
        resolverForQuality: (quality) => PlaybackResolver(
          transport: api,
          authority: authority,
          quality: quality,
        ),
        fetcher: ProtectedMediaFetcher(
          authority: authority,
          securityContext: testSecurityContext,
        ),
        networkPolicy: policy,
        revalidateNetwork: (job) async {
          phase = DownloadWorkerPhase.network;
          await access.requireNetwork(job: job);
          await daily.requireFile(job);
          phase = DownloadWorkerPhase.file;
        },
        beforeWrite: (bytes) async {
          phase = DownloadWorkerPhase.storage;
          await const DeviceStorageGuard().requireSpace(bytes);
          phase = DownloadWorkerPhase.file;
        },
        reserveWrite: quota.reserveWrite,
        onWriterDrained: quota.writerDrained,
      );
      routeChanged = () =>
          coordinator!.cancelNetworkTransfers(retryWhenAllowed: true);
      deviceNetwork.addListener(routeChanged);
      revocations = authority.changes.listen((_) {
        if (!authority.isCurrent(originalFence)) {
          stopped = true;
          unawaited(
            channel
                .invokeMethod<void>('hideProgress')
                .catchError((Object _) {}),
          );
          unawaited(coordinator!.close());
        }
      });
      if (stopped) {
        await coordinator!.close();
        return outcome('cancelled');
      }
      if (refreshRequest != null) {
        phase = DownloadWorkerPhase.refresh;
        await daily.run(refreshRequest.revision);
        final diagnostic = await DownloadWorkDiagnostic.inspect(
          phase: DownloadWorkerPhase.refresh,
          read: () async {
            final status = DownloadWorkDiagnostic.safeState(
              await daily.readStatus(),
            );
            final pending = (await mixes.read()).pending;
            if (pending != null) {
              for (final item in pending.items.take(1000)) {
                final job = await repository.status(
                  item.downloadId,
                  originalFence,
                );
                if (job != null &&
                    job.generation == item.downloadGeneration &&
                    job.originalFence.epoch == item.downloadEpoch &&
                    job.state != DownloadState.ready) {
                  return (
                    code: job.errorCode,
                    state: '$status/${job.state.name}',
                  );
                }
              }
            }
            return (code: null, state: status);
          },
        );
        return outcome('ready', 0, diagnostic);
      }
      phase = DownloadWorkerPhase.file;
      final fileRequest = request!;
      if (fileRequest.refreshRevision != null) {
        final job = await repository.status(
          fileRequest.downloadId,
          originalFence,
        );
        if (job == null || job.generation != fileRequest.generation) {
          return outcome('cancelled');
        }
        if (!job.manual) {
          final ticket = await owners.transaction(
            originalFence,
            (tx) => OfflineMixRefreshAdmission.jobTicketIn(tx, job),
          );
          if (ticket?.revision != fileRequest.refreshRevision) {
            return outcome('cancelled');
          }
        }
      }
      // No metadata in notifications. Progress appears only for this admitted
      // original generation, and every asynchronous read is fenced again.
      progress = Timer.periodic(const Duration(seconds: 1), (_) {
        if (pendingProgress != null || stopped) return;
        pendingProgress =
            () async {
                  final job = await repository.status(
                    fileRequest.downloadId,
                    originalFence,
                  );
                  if (!stopped &&
                      authority.isCurrent(originalFence) &&
                      job != null &&
                      job.originalFence == originalFence &&
                      job.generation == fileRequest.generation &&
                      job.writer != null) {
                    await channel.invokeMethod<void>('progress', {
                      'bytes': job.bytes,
                      'total': job.totalBytes,
                    });
                  }
                }()
                .catchError((Object _) {})
                .whenComplete(() => pendingProgress = null);
      });
      final result = await coordinator!.run(
        fileRequest.downloadId,
        originalFence,
        fileRequest.generation,
      );
      Map<String, Object?>? manifestIssue;
      if (result == DownloadRunResult.ready) {
        // Manifest failure retains the last complete mix and the verified file.
        // It must not turn a completed transfer into a new download attempt.
        try {
          phase = DownloadWorkerPhase.manifest;
          final pending = (await mixes.read()).pending;
          if (pending != null) {
            final ticket = await owners.transaction(
              originalFence,
              (tx) => OfflineMixRefreshAdmission.bindingIn(
                tx,
                pending.generation,
                originalFence,
              ),
            );
            if (ticket != null) {
              await daily.commitIfReady();
            } else {
              await mixes.commit(pending.generation);
            }
          }
        } catch (error) {
          manifestIssue = DownloadWorkDiagnostic.capture(
            phase: DownloadWorkerPhase.manifest,
            error: error,
          );
          // The retained pending intent is retried by the owner's UI/recovery.
        }
      }
      var delay = 0;
      DeviceDownload? latest;
      if (result == DownloadRunResult.retry) {
        phase = DownloadWorkerPhase.file;
        latest = await repository.status(fileRequest.downloadId, originalFence);
        if (latest != null &&
            latest.originalFence == originalFence &&
            latest.generation == fileRequest.generation) {
          final remaining =
              latest.retryNotBefore - DateTime.now().millisecondsSinceEpoch;
          delay = remaining > 0 ? remaining : 0;
        }
      }
      final diagnostic = await DownloadWorkDiagnostic.inspect(
        phase: phase,
        read: () async {
          final job = result == DownloadRunResult.retry
              ? latest
              : await repository.status(fileRequest.downloadId, originalFence);
          return job != null &&
                  job.originalFence == originalFence &&
                  job.generation == fileRequest.generation
              ? (
                  code: manifestIssue?['code'] as String? ?? job.errorCode,
                  state: job.state.name,
                )
              : (code: manifestIssue?['code'] as String?, state: null);
        },
      );
      return outcome(result.name, delay, diagnostic);
    } on AppFailure catch (error) {
      return outcome(
        error.retryable ? 'retry' : 'cancelled',
        error.retryAfter?.inMilliseconds ?? 0,
        DownloadWorkDiagnostic.capture(phase: phase, error: error),
      );
    } catch (error) {
      return outcome(
        'failed',
        0,
        DownloadWorkDiagnostic.capture(phase: phase, error: error),
      );
    } finally {
      phase = DownloadWorkerPhase.drain;
      stopped = true;
      progress?.cancel();
      await coordinator?.close();
      if (routeChanged != null) deviceNetwork?.removeListener(routeChanged);
      await deviceNetwork?.close();
      await revocations?.cancel();
      await pendingProgress;
      // Drain T07 before releasing its DB handle and the sole broker lease.
      try {
        await sessions?.close();
      } finally {
        await client?.close();
      }
    }
  }

  channel.setMethodCallHandler((call) async {
    switch (call.method) {
      case 'run':
        if (started) throw StateError('Worker already started');
        started = true;
        return await (running = execute(call.arguments).catchError(
          (Object error) => outcome(
            'failed',
            0,
            DownloadWorkDiagnostic.capture(phase: phase, error: error),
          ),
        ));
      case 'cancel':
        stopped = true;
        await coordinator?.close();
        await running;
        return null;
      default:
        throw MissingPluginException();
    }
  });
  await channel.invokeMethod<void>('ready');
}
