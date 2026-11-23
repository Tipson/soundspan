import '../core/model/app_failure.dart';
import '../core/model/owner_key.dart';
import '../core/network/network_policy.dart';
import '../core/storage/owner_store.dart';
import 'download_models.dart';
import 'download_network_policy.dart';
import 'download_network_rules.dart';
import 'download_repository.dart';
import 'stored_download_network_rules.dart';

/// Coarse native scheduling filter. Durable rules and actual route capabilities
/// remain authoritative, including Wi-Fi transport and per-job consent.
enum DownloadNetworkConstraint { unmetered, notRoaming, connected }

/// One admission path for manual jobs, automatic jobs and speculative audio.
/// A manual exception is stored against the exact owner epoch and generation,
/// never in WorkData, a global preference or an authenticated media URL.
final class DownloadNetworkAccess {
  const DownloadNetworkAccess({
    required this.repository,
    required this.fence,
    required this.policy,
    required this.readNetwork,
  });

  final DownloadRepository repository;
  final SessionFence fence;
  final NetworkPolicy policy;
  final Future<DeviceNetworkState> Function() readNetwork;
  static const consentNamespace = 'downloadNetworkConsent.v1';

  Future<DownloadNetworkRules> rules() =>
      loadDownloadNetworkRules(repository.store, fence);

  Future<void> _online() async {
    policy.requireNetwork();
    (await loadDownloadNetworkPolicy(repository.store, fence)).requireNetwork();
    await repository.authority.assertCurrent(fence);
    policy.requireNetwork();
  }

  Future<void> requireNetwork({DeviceDownload? job}) async {
    await _online();
    final state = await readNetwork();
    // Retain the durable legacy stop barrier even when a future policy cannot
    // be decoded. Admission itself uses a later, single transactional snapshot.
    await rules();
    await repository.authority.assertCurrent(fence);
    await repository.store.transaction(
      fence,
      (tx) => _admit(tx, state, job: job),
    );
  }

  Future<void> _admit(
    OwnerTransaction tx,
    DeviceNetworkState state, {
    DeviceDownload? job,
    bool oneOff = false,
  }) async {
    policy.requireNetwork();
    decodeDownloadNetworkPolicy(await tx.read('settings', 'network'))
        .requireNetwork();
    final currentRules = DownloadNetworkRules.decode(
      await tx.read(DownloadNetworkRules.namespace, DownloadNetworkRules.key),
    );
    final once = oneOff || (job != null && await _hasConsentIn(tx, job));
    policy.requireNetwork();
    if (!currentRules.allows(state, oneOff: once)) throw restricted;
  }

  /// A failed route does not forbid queuing a job for an allowed future route.
  Future<DownloadNetworkConstraint> constraintFor(DeviceDownload job) async {
    await repository.authority.assertCurrent(fence);
    final currentRules = await rules();
    if (currentRules.mode == DownloadNetworkMode.unmetered &&
        !await _hasConsent(job)) {
      return DownloadNetworkConstraint.unmetered;
    }
    return currentRules.allowRoaming
        ? DownloadNetworkConstraint.connected
        : DownloadNetworkConstraint.notRoaming;
  }

  Future<bool> _hasConsent(DeviceDownload job) async {
    if (!job.manual || job.originalFence != fence) return false;
    return repository.store.transaction(fence, (tx) => _hasConsentIn(tx, job));
  }

  Future<bool> _hasConsentIn(OwnerTransaction tx, DeviceDownload job) async {
    if (!job.manual || job.originalFence != fence) return false;
    final row = await tx.read(DownloadRepository.namespace, job.id);
    if (row == null) return false;
    final current = DeviceDownload.fromJson(row);
    if (current.id != job.id ||
        current.originalFence != fence ||
        current.generation != job.generation ||
        !current.manual) {
      return false;
    }
    return _matches(await tx.read(consentNamespace, job.id), job);
  }

  static bool _matches(Map<String, Object?>? row, DeviceDownload job) =>
      row != null &&
      row.length == 3 &&
      row['version'] is int &&
      row['version'] == 1 &&
      row['epoch'] is int &&
      row['epoch'] == job.originalFence.epoch &&
      row['generation'] is int &&
      row['generation'] == job.generation;

  /// Called only after explicit consent for the selected manual jobs. A stale
  /// UI result cannot authorize a replacement generation or an automatic job.
  Future<void> allowOnce(DeviceDownload job) async {
    await _online();
    if (!job.manual || job.originalFence != fence) throw staleConsent;
    final state = await readNetwork();
    await rules();
    await repository.authority.assertCurrent(fence);
    await repository.store.transaction(fence, (tx) async {
      await _admit(tx, state, oneOff: true);
      final row = await tx.read(DownloadRepository.namespace, job.id);
      if (row == null) throw staleConsent;
      final current = DeviceDownload.fromJson(row);
      if (current.id != job.id ||
          current.originalFence != fence ||
          current.generation != job.generation ||
          !current.manual ||
          !const {
            DownloadState.queued,
            DownloadState.downloading,
            DownloadState.verifying,
          }.contains(current.state)) {
        throw staleConsent;
      }
      await tx.write(consentNamespace, job.id, {
        'version': 1,
        'epoch': fence.epoch,
        'generation': job.generation,
      });
    });
  }

  /// Conditional cleanup protects a newer generation from a late old callback.
  Future<void> revokeOnce(DeviceDownload job) =>
      repository.store.transaction(fence, (tx) async {
        if (job.originalFence == fence &&
            _matches(await tx.read(consentNamespace, job.id), job)) {
          await tx.remove(consentNamespace, job.id);
        }
      });

  static const restricted = AppFailure(
    code: 'download_network_restricted',
    message: 'Загрузка ждёт сеть, разрешённую в настройках.',
    retryable: true,
  );
  static const staleConsent = AppFailure(
    code: 'download_consent_stale',
    message: 'Загрузка изменилась. Выберите её снова.',
  );
}
