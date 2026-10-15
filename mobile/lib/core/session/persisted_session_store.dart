import '../model/owner_key.dart';

/// Durable admission record. A tombstone survives crashes before vault deletion.
final class PersistedSession {
  const PersistedSession({
    required this.epoch,
    required this.tombstone,
    this.owner,
  });
  final int epoch;
  final bool tombstone;
  final OwnerKey? owner;

  bool admits(SessionFence fence) =>
      !tombstone && owner == fence.owner && epoch == fence.epoch;
}

/// The adapter must increment epoch atomically in persistent storage. Every SQL
/// owner write must compare its original fence in that same database transaction.
/// Implementations must never reset/reuse an epoch after logout or restart.
abstract interface class PersistedSessionStore {
  Future<PersistedSession> read();
  Future<PersistedSession> advance(OwnerKey? owner);
}
