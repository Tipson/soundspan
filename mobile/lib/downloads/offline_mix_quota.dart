import '../core/model/app_failure.dart';
import '../core/model/owner_key.dart';
import '../core/storage/owner_store.dart';
import 'download_models.dart';
import 'download_repository.dart';

/// Automatic-file accounting includes reserved writes, not only ready songs.
final class OfflineMixQuotaUsage {
  const OfflineMixQuotaUsage({
    required this.limitBytes,
    required this.usedBytes,
  });
  final int limitBytes, usedBytes;
}

/// A policy ledger in the existing owner store, not another download engine.
/// All writers reserve before IO. Eight-MiB grants amortize inventory scans;
/// the existing claim checks still surround every actual file write.
final class OfflineMixQuota {
  OfflineMixQuota({
    required this.repository,
    required this.fence,
    this.evict,
    this.recover,
  });
  final DownloadRepository repository;
  final SessionFence fence;
  final Future<bool> Function(DeviceDownload)? evict;
  final Future<int> Function()? recover;
  static const policyNamespace = 'offlineMixQuotaPolicy.v1';
  static const ledgerNamespace = 'offlineMixQuotaFiles.v1';
  static const defaultLimit = 1024 * 1024 * 1024;
  static const _window = 8 * 1024 * 1024;
  static const _maxBytes = 16 * 1024 * 1024 * 1024;
  static const _maxRows = 100000;
  final _grants = <String, int>{};

  /// Called only by the coordinator after the captured writer is drained.
  Future<void> writerDrained(DeviceDownload claim) async {
    if (claim.originalFence != fence || claim.writer == null) return;
    final file = _QuotaFile(claim.id, claim.generation, claim.writer!, 0);
    final measured = await _measure(file);
    final key = _key(file.id, file.generation, file.claim);
    await repository.store.transaction(fence, (tx) async {
      final row = await tx.read(DownloadRepository.namespace, file.id);
      if (row == null) return;
      final current = _job(row, file.id);
      final actual = _inventory([current])[key];
      if (!current.exclusivelyOfflineMixOwned || actual == null) {
        await tx.remove(ledgerNamespace, key);
      } else {
        await tx.write(
          ledgerNamespace,
          key,
          _record(actual, measured > actual.bytes ? measured : actual.bytes),
        );
      }
      _grants.remove(key);
    });
  }

  /// Lowering a limit preserves saved files and previously reserved writes;
  /// the updated value governs further grants, without forced deletion.
  Future<void> setLimit(int bytes) async {
    if (bytes < 16 * 1024 * 1024 ||
        bytes > _maxBytes ||
        bytes % (1024 * 1024) != 0) {
      throw ArgumentError.value(bytes, 'bytes');
    }
    await repository.store.transaction(fence, (tx) async {
      _limit(await tx.read(policyNamespace, 'control'));
      await tx.write(policyNamespace, 'control', {
        'version': 1,
        'maxBytes': bytes,
      });
    });
    _grants.clear();
  }

  Future<OfflineMixQuotaUsage> usage() async {
    await _seedInventory();
    return repository.store.transaction(fence, (tx) async {
      final state = await _scan(tx);
      return OfflineMixQuotaUsage(
        limitBytes: state.limit,
        usedBytes: state.used,
      );
    });
  }

  /// Reserve the resulting length of this exact writer's private file.
  /// The caller must retain its ordinary before/after-write claim fence.
  Future<void> reserveWrite(DeviceDownload claim, int nextLength) async {
    if (claim.originalFence != fence ||
        claim.writer == null ||
        nextLength < 1 ||
        nextLength > _maxBytes) {
      throw const AppFailure(
        code: 'media_cancelled',
        message: 'Загрузка изменилась.',
      );
    }
    await repository.assertClaim(claim);
    if (!claim.exclusivelyOfflineMixOwned) return;
    final key = _key(claim.id, claim.generation, claim.writer!);
    if ((_grants[key] ?? 0) >= nextLength) return;
    await recover?.call();
    await _seedInventory();
    final attempted = <String>{};
    while (true) {
      final granted = await repository.store.transaction(fence, (tx) async {
        final state = await _scan(tx);
        final current = state.jobs[claim.id];
        if (!repository.owns(current, claim)) {
          throw const AppFailure(
            code: 'media_cancelled',
            message: 'Загрузка изменилась.',
          );
        }
        if (!current!.exclusivelyOfflineMixOwned) return nextLength;
        final slot = state.files[key];
        if (slot == null) throw const FormatException('Quota writer inventory');
        final allocated = state.allocated[key] ?? slot.bytes;
        if (allocated >= nextLength) return allocated;
        final available = state.limit - state.used;
        if (nextLength - allocated > available) return null;
        final wanted = ((nextLength + _window - 1) ~/ _window) * _window;
        final grant = wanted < allocated + available
            ? wanted
            : allocated + available;
        await tx.write(ledgerNamespace, key, _record(slot, grant));
        return grant;
      });
      if (granted != null) {
        if (_grants.length >= 128) _grants.clear();
        _grants[key] = granted;
        return;
      }
      if (evict == null || attempted.length >= 64) throw _exceeded;
      final candidates = (await repository.list(fence)).where(
        (job) =>
            job.state == DownloadState.ready &&
            job.writer == null &&
            job.exclusivelyOfflineMixOwned &&
            !attempted.contains(job.id),
      );
      var removed = false;
      for (final candidate in candidates) {
        attempted.add(candidate.id);
        if (await evict!(candidate)) {
          removed = true;
          break;
        }
        if (attempted.length >= 64) break;
      }
      if (!removed) throw _exceeded;
      // Only the repository may unlink and finalize its exact inventory. The
      // next transaction prunes that file's ledger after finalization, never
      // just because it was selected or its writer lease expired.
    }
  }

  static const _exceeded = AppFailure(
    code: 'offline_mix_quota_exceeded',
    message: 'Лимит офлайн-микса исчерпан. Увеличьте его в настройках и повторите сохранение.',
  );

  int _limit(Map<String, Object?>? row) {
    if (row == null) return defaultLimit;
    final bytes = row['maxBytes'];
    if (row.length != 2 ||
        row['version'] is! int ||
        row['version'] != 1 ||
        bytes is! int ||
        bytes < 16 * 1024 * 1024 ||
        bytes > _maxBytes ||
        bytes % (1024 * 1024) != 0) {
      throw const FormatException('Offline mix quota policy');
    }
    return bytes;
  }

  DeviceDownload _job(Map<String, Object?> row, String id) {
    final job = DeviceDownload.fromJson(row);
    if (job.id != id ||
        job.originalFence.owner != fence.owner ||
        repository.key(job.track.ref, job.quality, fence.owner) != id) {
      throw const FormatException('Quota owner identity');
    }
    return job;
  }

  static String _key(String id, int generation, String claim) =>
      '$id:$generation:$claim';
  static Map<String, Object?> _record(_QuotaFile file, int bytes) => {
    'version': 1,
    'id': file.id,
    'generation': file.generation,
    'claim': file.claim,
    'bytes': bytes,
  };

  Future<List<OwnerRecord>> _list(OwnerTransaction tx, String namespace) async {
    final rows = <OwnerRecord>[];
    String? after;
    while (true) {
      final page = await tx.list(namespace, afterKey: after);
      if (page.isEmpty) return rows;
      rows.addAll(page);
      if (rows.length > _maxRows) {
        throw const FormatException('Quota inventory bound');
      }
      after = page.last.key;
    }
  }

  Map<String, _QuotaFile> _inventory(Iterable<DeviceDownload> jobs) {
    final result = <String, _QuotaFile>{};
    for (final job in jobs) {
      for (final cp in [
        ...job.files,
        if (job.checkpoint != null) job.checkpoint!,
      ]) {
        if (cp.bytes > _maxBytes) {
          throw const FormatException('Quota file byte bound');
        }
        final key = _key(job.id, cp.generation, cp.claim);
        final previous = result[key]?.bytes ?? 0;
        result[key] = _QuotaFile(
          job.id,
          cp.generation,
          cp.claim,
          cp.bytes > previous ? cp.bytes : previous,
        );
        if (result.length > _maxRows) {
          throw const FormatException('Quota file bound');
        }
      }
    }
    return result;
  }

  Future<_QuotaScan> _scan(OwnerTransaction tx) async {
    final jobs = <String, DeviceDownload>{};
    for (final row in await _list(tx, DownloadRepository.namespace)) {
      jobs[row.key] = _job(row.value, row.key);
    }
    final files = _inventory(jobs.values);
    final allocated = <String, int>{};
    for (final row in await _list(tx, ledgerNamespace)) {
      final value = row.value,
          id = value['id'],
          gen = value['generation'],
          claim = value['claim'],
          bytes = value['bytes'];
      if (value['version'] is! int ||
          value['version'] != 1 ||
          id is! String ||
          !RegExp(r'^[a-f0-9]{64}$').hasMatch(id) ||
          gen is! int ||
          gen < 1 ||
          claim is! String ||
          !RegExp(r'^[a-f0-9]{48}$').hasMatch(claim) ||
          bytes is! int ||
          bytes < 0 ||
          bytes > _maxBytes ||
          row.key != _key(id, gen, claim)) {
        throw const FormatException('Quota ledger');
      }
      final job = jobs[id];
      if (job != null &&
          (!job.exclusivelyOfflineMixOwned || !files.containsKey(row.key))) {
        await tx.remove(ledgerNamespace, row.key);
        continue;
      }
      allocated[row.key] = bytes;
    }
    var used = 0;
    for (final entry in allocated.entries) {
      final actual = files[entry.key]?.bytes ?? 0;
      used += entry.value > actual ? entry.value : actual;
    }
    for (final entry in files.entries) {
      if (!allocated.containsKey(entry.key) &&
          jobs[entry.value.id]!.exclusivelyOfflineMixOwned) {
        used += entry.value.bytes;
      }
    }
    return _QuotaScan(
      jobs,
      files,
      allocated,
      _limit(await tx.read(policyNamespace, 'control')),
      used,
    );
  }

  Future<void> _seedInventory() async {
    final missing = await repository.store.transaction(fence, (tx) async {
      final state = await _scan(tx);
      return state.files.entries
          .where(
            (entry) =>
                state.jobs[entry.value.id]!.exclusivelyOfflineMixOwned &&
                (!state.allocated.containsKey(entry.key) ||
                    (_isReadyFile(state.jobs[entry.value.id]!, entry.value) &&
                        state.allocated[entry.key]! > entry.value.bytes)),
          )
          .map(
            (entry) =>
                (file: entry.value, previous: state.allocated[entry.key]),
          )
          .toList();
    });
    for (final seed in missing) {
      final file = seed.file;
      final measured = await _measure(file);
      await repository.store.transaction(fence, (tx) async {
        final row = await tx.read(DownloadRepository.namespace, file.id);
        final key = _key(file.id, file.generation, file.claim);
        if (row == null) return;
        final existing = await tx.read(ledgerNamespace, key);
        if (seed.previous == null && existing != null) return;
        final current = _job(row, file.id);
        final actual = _inventory([current])[key];
        if (!current.exclusivelyOfflineMixOwned || actual == null) return;
        if (seed.previous != null &&
            (existing?['bytes'] != seed.previous ||
                !_isReadyFile(current, actual))) {
          return;
        }
        final bytes = measured > actual.bytes ? measured : actual.bytes;
        await tx.write(ledgerNamespace, key, _record(actual, bytes));
      });
    }
  }

  bool _isReadyFile(DeviceDownload job, _QuotaFile file) =>
      job.state == DownloadState.ready &&
      job.checkpoint?.sha256 != null &&
      job.checkpoint?.generation == file.generation &&
      job.checkpoint?.claim == file.claim;

  Future<int> _measure(_QuotaFile file) async {
    await repository.authority.assertCurrent(fence);
    var bytes = 0;
    for (final ready in [false, true]) {
      final path = await repository.paths.file(
        fence.owner,
        file.id,
        file.generation,
        file.claim,
        ready: ready,
      );
      if (await path.exists()) bytes += await path.length();
    }
    await repository.authority.assertCurrent(fence);
    return bytes;
  }
}

final class _QuotaFile {
  const _QuotaFile(this.id, this.generation, this.claim, this.bytes);
  final String id, claim;
  final int generation, bytes;
}

final class _QuotaScan {
  const _QuotaScan(
    this.jobs,
    this.files,
    this.allocated,
    this.limit,
    this.used,
  );
  final Map<String, DeviceDownload> jobs;
  final Map<String, _QuotaFile> files;
  final Map<String, int> allocated;
  final int limit, used;
}
