import '../model/owner_key.dart';

final class AuthConfig {
  const AuthConfig({
    required this.localLoginEnabled,
    required this.oidcEnabled,
    required this.oidcProviderName,
  });
  final bool localLoginEnabled;
  final bool oidcEnabled;
  final String oidcProviderName;
}

/// Transient password/TOTP input. Never persist or include in a diagnostic.
final class LoginInput {
  const LoginInput({
    required this.origin,
    required this.username,
    required this.password,
    this.token,
  });
  final Uri origin;
  final String username;
  final String password;
  final String? token;
  @override
  String toString() => 'LoginInput(<redacted>)';
}

final class LoginResult {
  const LoginResult.requires2FA() : requires2FA = true, owner = null;
  const LoginResult.success(this.owner) : requires2FA = false;
  final bool requires2FA;
  final OwnerKey? owner;
}

final class AuthUser {
  const AuthUser({
    required this.owner,
    required this.username,
    this.displayName,
  });
  final OwnerKey owner;
  final String username;
  final String? displayName;
}
