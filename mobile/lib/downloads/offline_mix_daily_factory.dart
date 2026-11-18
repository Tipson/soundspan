import '../core/model/app_failure.dart';
import '../core/network/api_transport.dart';
import '../core/network/dart_api_transport.dart';
import '../core/network/network_policy.dart';
import '../core/session/session_authority.dart';
import '../features/home/home_repository.dart';
import 'device_network_monitor.dart';
import 'download_network_access.dart';
import 'download_repository.dart';
import 'download_worker_bridge.dart';
import 'offline_mix_daily_refresh.dart';
import 'offline_mix_refresh_conditions.dart';
import 'offline_mix_refresh_policy.dart';
import 'offline_mix_repository.dart';
import 'schedule_current_download.dart';

/// Both UI configuration and native workers share this exact wiring.
OfflineMixDailyRefresh createOfflineMixDailyRefresh({
  required DownloadRepository downloads,
  required OfflineMixRepository mixes,
  required DartApiTransport transport,
  required SessionAuthority authority,
  required NetworkPolicy networkPolicy,
  required DeviceNetworkMonitor monitor,
  required DownloadNetworkAccess access,
  Future<void> Function()? guard,
}) {
  const worker = DownloadWorkerBridge();
  final fence = mixes.fence;
  return OfflineMixDailyRefresh(
    mixes: mixes,
    policy: OfflineMixRefreshPolicy(store: downloads.store, fence: fence),
    conditions: () async {
      await guard?.call();
      await monitor.start();
      return readOfflineMixRefreshConditions(monitor);
    },
    requireNetwork: () async {
      await guard?.call();
      await access.requireNetwork();
      await guard?.call();
    },
    loadSource: (identity, admit) => HomeRepository(
      transport: DartApiTransport(
        client: OfflineMixRefreshJsonClient(transport.client, admit),
        authority: authority,
      ),
      authority: authority,
      fence: fence,
      networkPolicy: networkPolicy,
      admitRequest: admit,
    ).currentMix(identity),
    scheduleFile: (job, _) async => scheduleCurrentDownload(
      repository: downloads,
      access: access,
      worker: worker,
      id: job.id,
      fence: job.originalFence,
      generation: job.generation,
      guard: guard,
    ),
    schedulePeriodic: (revision) => worker.scheduleRefresh(fence, revision),
    retryPeriodic: (revision) => worker.retryRefresh(fence, revision),
    cancelPeriodic: (revision) => worker.cancelRefresh(fence, revision),
    cancelFile: (job) =>
        worker.cancelJob(job.id, job.originalFence, job.generation),
  );
}

/// Runs after token grant, and again for a 401 replay, just before JSON HTTP.
/// The shared authenticated transport and its one-replay budget remain intact.
final class OfflineMixRefreshJsonClient implements JsonHttpClient {
  OfflineMixRefreshJsonClient(this.client, this.admit);
  final JsonHttpClient client;
  final Future<void> Function() admit;
  @override
  Future<ApiResponse> send(ApiRequest request, {String? accessToken}) async {
    await admit();
    final response = await client.send(request, accessToken: accessToken);
    // This composition read is safe to reschedule through WorkManager. The
    // transport itself still sends once; ambiguous mutations keep their policy.
    if (request.method == ApiMethod.get &&
        (response.statusCode == 502 || response.statusCode == 504)) {
      throw AppFailure(
        code: 'http_error',
        message: 'Сервер временно не ответил. Готовый микс сохранён.',
        statusCode: response.statusCode,
        retryable: true,
        retryAfter: response.retryAfter,
      );
    }
    return response;
  }
}
