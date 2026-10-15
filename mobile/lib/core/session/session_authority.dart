import '../model/owner_key.dart';

enum SessionStatus { signedOut, authenticated, offlineValidated }

/// Public state is safe for UI/events; it deliberately contains no credentials.
final class SessionState {
  const SessionState({
    required this.status,
    this.fence,
    this.tokenRevision = 0,
  });
  const SessionState.signedOut()
    : status = SessionStatus.signedOut,
      fence = null,
      tokenRevision = 0;
  final SessionStatus status;
  final SessionFence? fence;
  final int tokenRevision;
}

/// Identifies the exact credential revision rejected by an HTTP attempt.
final class AuthStamp {
  const AuthStamp({required this.fence, required this.tokenRevision});
  final SessionFence fence;
  final int tokenRevision;
  @override
  bool operator ==(Object other) =>
      other is AuthStamp &&
      fence == other.fence &&
      tokenRevision == other.tokenRevision;
  @override
  int get hashCode => Object.hash(fence, tokenRevision);
}

/// Ephemeral transport-only access. Never cache, persist, publish or log a grant.
final class AccessGrant {
  const AccessGrant({required this.authStamp, required this.accessToken});
  final AuthStamp authStamp;
  final String accessToken;
  @override
  String toString() => 'AccessGrant(<redacted>)';
}

/// UI cache and authoritative admission are separate so native engine proxies
/// can implement this boundary without owning credentials or doing refreshes.
abstract interface class SessionAuthority {
  SessionState get state;
  Stream<SessionState> get changes;
  SessionFence requireFence();
  bool isCurrent(SessionFence fence);
  Future<void> assertCurrent(SessionFence fence);
  Future<AccessGrant> grantAccess(SessionFence fence, Uri exactOrigin);
  Future<AuthStamp> after401(AuthStamp rejected);
  Future<void> invalidate();
}
