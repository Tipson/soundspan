import '../model/owner_key.dart';
import '../session/session_authority.dart';

/// Single-flight per original fence/revision, owned by the one broker isolate.
/// This class alone does not provide coordination across Flutter engines.
final class RefreshCoordinator {
  RefreshCoordinator({
    required this.currentStamp,
    required this.performRefresh,
  });
  final AuthStamp Function(SessionFence) currentStamp;
  final Future<AuthStamp> Function(AuthStamp) performRefresh;
  final Map<AuthStamp, Future<AuthStamp>> _pending = {};

  Future<void> refresh(SessionFence fence) async {
    await after401(currentStamp(fence));
  }

  Future<AuthStamp> after401(AuthStamp rejected) {
    final existing = _pending[rejected];
    if (existing != null) return existing;
    final future = _run(rejected);
    _pending[rejected] = future;
    return future;
  }

  Future<AuthStamp> _run(AuthStamp rejected) async {
    try {
      // Defer once so the map entry exists even if the callback fails synchronously.
      await Future<void>.value();
      return await performRefresh(rejected);
    } finally {
      _pending.remove(rejected);
    }
  }
}
