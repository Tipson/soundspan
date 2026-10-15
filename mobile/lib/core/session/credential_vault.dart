import '../model/app_failure.dart';
import '../model/owner_key.dart';

/// A complete rotating token pair. Only the broker owns this value.
final class TokenPair {
  const TokenPair({required this.accessToken, required this.refreshToken});
  final String accessToken;
  final String refreshToken;

  void validate() {
    if (!_validToken(accessToken) || !_validToken(refreshToken)) {
      throw const AppFailure(
        code: 'invalid_credentials',
        message: 'Некорректный ответ авторизации',
      );
    }
  }

  static bool _validToken(String value) =>
      value.isNotEmpty &&
      value.length <= 32768 &&
      !RegExp(r'[\s\x00-\x1f\x7f]').hasMatch(value);

  @override
  String toString() => 'TokenPair(<redacted>)';
}

/// One atomic secure-storage record, bound to a durable session generation.
final class StoredCredentials {
  const StoredCredentials({
    required this.fence,
    required this.tokenRevision,
    required this.tokens,
  });
  final SessionFence fence;
  final int tokenRevision;
  final TokenPair tokens;
  @override
  String toString() => 'StoredCredentials(<redacted>)';
}

/// Called only by LocalSessionAuthority, which serializes all writes/deletes.
abstract interface class CredentialVault {
  Future<StoredCredentials?> read(Uri serverOrigin);
  Future<void> write(StoredCredentials credentials);
  Future<void> delete(OwnerKey owner);
}
