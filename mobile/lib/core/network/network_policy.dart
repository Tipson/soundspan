import '../model/app_failure.dart';

/// Explicit user/network admission policy, independent of credential freshness.
/// A locally restored session may make authenticated requests while online.
/// Connectivity failures do not silently change this user's offline setting.
abstract interface class NetworkPolicy {
  const factory NetworkPolicy.online() = _OnlineNetworkPolicy;
  const factory NetworkPolicy.offline() = _OfflineNetworkPolicy;

  bool get networkAllowed;

  /// Call immediately before network work. Offline implementations fail closed.
  void requireNetwork();
}

final class _OnlineNetworkPolicy implements NetworkPolicy {
  const _OnlineNetworkPolicy();

  @override
  bool get networkAllowed => true;

  @override
  void requireNetwork() {}
}

final class _OfflineNetworkPolicy implements NetworkPolicy {
  const _OfflineNetworkPolicy();

  @override
  bool get networkAllowed => false;

  @override
  Never requireNetwork() => throw const AppFailure(
    code: 'offline_mode',
    message: 'Включён офлайн-режим. Откройте загруженную музыку.',
  );
}
