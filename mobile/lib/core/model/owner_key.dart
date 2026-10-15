/// Stable account namespace: an exact HTTPS origin and an opaque server user ID.
final class OwnerKey {
  factory OwnerKey({required Uri serverOrigin, required String userId}) {
    if (serverOrigin.scheme != 'https' ||
        !serverOrigin.hasAuthority ||
        serverOrigin.host.isEmpty ||
        serverOrigin.userInfo.isNotEmpty ||
        (serverOrigin.path.isNotEmpty && serverOrigin.path != '/') ||
        serverOrigin.hasQuery ||
        serverOrigin.hasFragment ||
        serverOrigin.port < 1 ||
        serverOrigin.port > 65535 ||
        userId.isEmpty) {
      throw ArgumentError('Expected an HTTPS origin and a nonempty user ID');
    }
    final normalized = Uri(
      scheme: 'https',
      host: serverOrigin.host.toLowerCase(),
      port: serverOrigin.port == 443 ? null : serverOrigin.port,
    );
    return OwnerKey._(normalized, userId);
  }

  const OwnerKey._(this.serverOrigin, this.userId);

  final Uri serverOrigin;
  final String userId;

  @override
  bool operator ==(Object other) =>
      other is OwnerKey &&
      serverOrigin == other.serverOrigin &&
      userId == other.userId;

  @override
  int get hashCode => Object.hash(serverOrigin, userId);
}

/// A captured session generation. Invalidation changes the authority's epoch;
/// this value remains immutable for rejecting late asynchronous results.
final class SessionFence {
  const SessionFence({required this.owner, required this.epoch});

  final OwnerKey owner;
  final int epoch;

  @override
  bool operator ==(Object other) =>
      other is SessionFence && owner == other.owner && epoch == other.epoch;

  @override
  int get hashCode => Object.hash(owner, epoch);
}
