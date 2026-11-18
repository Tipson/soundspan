import '../core/model/owner_key.dart';
import 'download_models.dart';
import 'download_network_access.dart';
import 'download_repository.dart';
import 'download_worker_bridge.dart';
import 'offline_mix_refresh_admission.dart';
import 'offline_mix_refresh_policy.dart';

typedef _SchedulePolicy = ({
  DownloadNetworkConstraint constraint,
  int? revision,
});

/// Both native producers use current durable intent rather than captured batch
/// metadata. A second read after the native acknowledgement repairs an update
/// overtaken by manual promotion in another isolate; generation stays intact.
Future<String> scheduleCurrentDownload({
  required DownloadRepository repository,
  required DownloadNetworkAccess access,
  required DownloadWorkerBridge worker,
  required String id,
  required SessionFence fence,
  required int generation,
  Future<void> Function()? guard,
}) async {
  if (access.fence != fence) throw DownloadNetworkAccess.staleConsent;
  final policy = OfflineMixRefreshPolicy(store: repository.store, fence: fence);
  Future<_SchedulePolicy?> current() async {
    await guard?.call();
    final job = await repository.status(id, fence);
    if (job == null ||
        job.generation != generation ||
        job.originalFence != fence) {
      throw DownloadNetworkAccess.staleConsent;
    }
    if (!const {
      DownloadState.queued,
      DownloadState.downloading,
      DownloadState.verifying,
    }.contains(job.state)) {
      return null;
    }
    final ticket =
        !job.manual && job.origins.contains(DownloadOrigin.offlineMixDaily.name)
        ? await repository.store.transaction(
            fence,
            (tx) => OfflineMixRefreshAdmission.jobTicketIn(tx, job),
          )
        : null;
    final daily = ticket != null && await policy.isCurrent(ticket);
    if (OfflineMixRefreshAdmission.onlyDaily(job) && !daily) {
      throw DownloadNetworkAccess.restricted;
    }
    return (
      constraint: daily
          ? DownloadNetworkConstraint.unmetered
          : await access.constraintFor(job),
      revision: daily ? ticket.revision : null,
    );
  }

  var desired = await current();
  if (desired == null) throw DownloadNetworkAccess.staleConsent;
  for (var attempt = 0; attempt < 3; attempt++) {
    await guard?.call();
    final workId = await worker.schedule(
      id,
      fence,
      generation,
      networkConstraint: desired!.constraint,
      refreshRevision: desired.revision,
    );
    final latest = await current();
    // Completion or a user pause needs no new native work. The worker still
    // validates state and owner before claiming bytes.
    if (latest == null || latest == desired) return workId;
    desired = latest;
  }
  throw DownloadNetworkAccess.staleConsent;
}
