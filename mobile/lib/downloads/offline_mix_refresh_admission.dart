import '../core/model/owner_key.dart';
import '../core/storage/owner_store.dart';
import 'download_models.dart';
import 'offline_mix_refresh_policy.dart';

/// Durable associations in the existing owner store, never WorkData secrets.
abstract final class OfflineMixRefreshAdmission {
  static const jobsNamespace = 'offlineMixRefreshJobs.v1';
  static const bindingNamespace = 'offlineMixRefreshBinding.v1';
  static const statusNamespace = 'offlineMixRefreshStatus.v1';

  static bool onlyDaily(DeviceDownload job) =>
      !job.manual &&
      job.origins.length == 1 &&
      job.origins.contains('offlineMixDaily');

  static Future<OfflineMixRefreshTicket?> jobTicketIn(
    OwnerTransaction tx,
    DeviceDownload job,
  ) async {
    final row = await tx.read(jobsNamespace, job.id);
    if (row == null) return null;
    if (row.length != 3 ||
        row['version'] is! int ||
        row['version'] != 1 ||
        row['generation'] is! int) {
      throw const FormatException('Refresh job binding');
    }
    if (row['generation'] != job.generation) return null;
    final ticket = OfflineMixRefreshTicket.decode(
      row['ticket'],
      job.originalFence,
    );
    return ticket.quality == job.quality ? ticket : null;
  }

  static Future<bool> currentJobIn(
    OwnerTransaction tx,
    DeviceDownload job,
    OfflineMixRefreshPolicy policy,
  ) async {
    final ticket = await jobTicketIn(tx, job);
    if (ticket == null) return false;
    return policy.isCurrentIn(tx, ticket);
  }

  static Future<OfflineMixRefreshTicket?> bindingIn(
    OwnerTransaction tx,
    int generation,
    SessionFence fence,
  ) async {
    final row = await tx.read(bindingNamespace, 'current');
    if (row == null) return null;
    if (row.length != 3 ||
        row['version'] is! int ||
        row['version'] != 1 ||
        row['mixGeneration'] is! int) {
      throw const FormatException('Refresh manifest binding');
    }
    if (row['mixGeneration'] != generation) return null;
    final ticket = row['ticket'];
    if (ticket is! Map ||
        ticket['epoch'] is! int ||
        (ticket['epoch'] as int) < 1) {
      throw const FormatException('Refresh binding epoch');
    }
    // Historical automatic intent may be recognized by a new session of this
    // same owner. It is not admission: every effect still validates its fence.
    return OfflineMixRefreshTicket.decode(
      ticket,
      SessionFence(owner: fence.owner, epoch: ticket['epoch'] as int),
    );
  }

  static Future<bool> admitsManifest(
    OwnerTransaction tx,
    int generation,
    OfflineMixRefreshPolicy policy,
    OfflineMixRefreshTicket? ticket,
  ) async {
    final bound = await bindingIn(tx, generation, policy.fence);
    if (bound == null) return ticket == null;
    return ticket != null &&
        bound.fence == ticket.fence &&
        bound.revision == ticket.revision &&
        bound.sourceIdentity == ticket.sourceIdentity &&
        bound.quality == ticket.quality &&
        bound.nonce == ticket.nonce &&
        await policy.isCurrentIn(tx, ticket);
  }
}
