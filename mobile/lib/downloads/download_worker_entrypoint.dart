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
import 'android_media_probe.dart';
import 'download_coordinator.dart';
import 'download_models.dart';
import 'device_network_monitor.dart';
import 'download_network_access.dart';
import 'download_network_policy.dart';
import 'download_repository.dart';
import 'download_verifier.dart';
import 'download_worker_bridge.dart';
import 'private_media_paths.dart';
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
  Future<Map<String, Object?>>? running;
  Map<String, Object?> outcome(String state, [int delay = 0]) => {
    'outcome': state,
    'retryAfterMillis': delay,
  };

  Future<Map<String, Object?>> execute(Object? arguments) async {
    final request = DownloadWorkRequest.decode(arguments);
    BrokerClient? client;
    SqliteSessionStore? sessions;
    StreamSubscription? revocations;
    Timer? progress;
    Future<void>? pendingProgress;
    DeviceNetworkMonitor? deviceNetwork;
    VoidCallback? routeChanged;
    try {
      if (stopped) return outcome('cancelled');
      client = BrokerClient(MethodChannelBrokerTransport());
      final authority = await NativeSessionAuthorityProxy.attach(
        client,
        ClientRole.download,
        expectedFence: request.originalFence,
      );
      if (stopped) return outcome('cancelled');
      await authority.assertCurrent(request.originalFence);
      sessions = await SqliteSessionStore.open();
      final owners = SqliteOwnerStore(sessions);
      final policy = await loadNetworkPolicy(owners, request.originalFence);
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
        beforeRemove: (_) async {
          throw StateError('Worker cannot remove media');
        },
      );
      final api = DartApiTransport(
        client: DartJsonHttpClient(),
        authority: authority,
      );
      deviceNetwork = DeviceNetworkMonitor();
      await deviceNetwork.start();
      final access = DownloadNetworkAccess(
        repository: repository,
        fence: request.originalFence,
        policy: policy,
        readNetwork: () async => deviceNetwork!.value,
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
        revalidateNetwork: (job) => access.requireNetwork(job: job),
      );
      routeChanged = () =>
          coordinator!.cancelNetworkTransfers(retryWhenAllowed: true);
      deviceNetwork.addListener(routeChanged);
      revocations = authority.changes.listen((_) {
        if (!authority.isCurrent(request.originalFence)) {
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
      // No metadata in notifications. Progress appears only for this admitted
      // original generation, and every asynchronous read is fenced again.
      progress = Timer.periodic(const Duration(seconds: 1), (_) {
        if (pendingProgress != null || stopped) return;
        pendingProgress =
            () async {
                  final job = await repository.status(
                    request.downloadId,
                    request.originalFence,
                  );
                  if (!stopped &&
                      authority.isCurrent(request.originalFence) &&
                      job != null &&
                      job.originalFence == request.originalFence &&
                      job.generation == request.generation &&
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
        request.downloadId,
        request.originalFence,
        request.generation,
      );
      var delay = 0;
      if (result == DownloadRunResult.retry) {
        final latest = await repository.status(
          request.downloadId,
          request.originalFence,
        );
        if (latest != null &&
            latest.originalFence == request.originalFence &&
            latest.generation == request.generation) {
          final remaining =
              latest.retryNotBefore - DateTime.now().millisecondsSinceEpoch;
          delay = remaining > 0 ? remaining : 0;
        }
      }
      return outcome(result.name, delay);
    } on AppFailure catch (error) {
      return outcome(error.retryable ? 'retry' : 'cancelled');
    } catch (_) {
      return outcome('failed');
    } finally {
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
        return await (running = execute(call.arguments));
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
