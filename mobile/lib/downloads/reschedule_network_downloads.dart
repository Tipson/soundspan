import '../core/model/owner_key.dart';
import 'download_models.dart';
import 'download_repository.dart';
import 'liked_download_automation.dart';

/// Policy changes invalidate old native work and per-generation consent. Ready
/// files, user pauses and unrelated failures remain untouched. Every mutation
/// compares the captured generation, including after native cancellation awaits.
Future<void> rescheduleNetworkDownloads({
  required DownloadRepository repository,
  required SessionFence fence,
  required CancelDeviceDownload cancel,
  required ScheduleDeviceDownload schedule,
}) async {
  final jobs = await repository.list(fence);
  for (final job in jobs) {
    await repository.authority.assertCurrent(fence);
    if (job.originalFence != fence ||
        !(const {
              DownloadState.queued,
              DownloadState.downloading,
              DownloadState.verifying,
            }.contains(job.state) ||
            (job.state == DownloadState.failed &&
                job.errorCode == 'download_network_restricted'))) {
      continue;
    }
    final paused = await repository.pauseIfCurrent(
      job.id,
      fence,
      expectedGeneration: job.generation,
    );
    if (paused == null ||
        paused.generation != job.generation + 1 ||
        paused.state != DownloadState.paused) {
      continue;
    }
    await cancel(job.id, job.originalFence, job.generation);
    final next = await repository.resume(
      job.id,
      fence,
      expectedGeneration: paused.generation,
    );
    if (next.generation == paused.generation + 1 &&
        next.state == DownloadState.queued &&
        next.originalFence == fence) {
      await schedule(next.id, next.originalFence, next.generation);
    }
  }
}
