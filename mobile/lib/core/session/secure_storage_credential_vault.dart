import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../model/app_failure.dart';
import '../model/owner_key.dart';
import '../network/api_transport.dart';
import 'credential_vault.dart';

/// One versioned JSON record per origin: rotating tokens cannot be torn apart.
/// Android uses the plugin's AES-GCM/KeyStore defaults. iOS permits background
/// reads after the first device unlock and never syncs this device's credentials.
/// The broker, not this adapter, provides the write/delete barrier.
final class SecureStorageCredentialVault implements CredentialVault {
  SecureStorageCredentialVault({FlutterSecureStorage? storage})
    : _storage =
          storage ??
          const FlutterSecureStorage(
            aOptions: AndroidOptions(resetOnError: false),
            iOptions: IOSOptions(
              accessibility: KeychainAccessibility.first_unlock_this_device,
              synchronizable: false,
            ),
          );

  final FlutterSecureStorage _storage;
  static const _unavailable = AppFailure(
    code: 'credential_storage_unavailable',
    message: 'Защищённое хранилище недоступно',
  );
  static const _invalid = AppFailure(
    code: 'invalid_stored_credentials',
    message: 'Не удалось восстановить сессию',
  );

  String _key(Uri origin) =>
      'soundspan.session.v1.${sha256.convert(utf8.encode(normalizeServerOrigin(origin).toString()))}';

  @override
  Future<StoredCredentials?> read(Uri origin) async {
    try {
      final normalized = normalizeServerOrigin(origin);
      final raw = await _storage.read(key: _key(normalized));
      if (raw == null) return null;
      if (raw.length > 100000) throw _invalid;
      final data = jsonDecode(raw);
      if (data is! Map<String, dynamic> ||
          data['version'] != 1 ||
          data['origin'] != normalized.toString() ||
          data['userId'] is! String ||
          data['epoch'] is! int ||
          (data['epoch'] as int) < 1 ||
          data['tokenRevision'] is! int ||
          (data['tokenRevision'] as int) < 1 ||
          data['accessToken'] is! String ||
          data['refreshToken'] is! String) {
        throw _invalid;
      }
      final owner = OwnerKey(
        serverOrigin: normalized,
        userId: data['userId'] as String,
      );
      final tokens = TokenPair(
        accessToken: data['accessToken'] as String,
        refreshToken: data['refreshToken'] as String,
      );
      tokens.validate();
      return StoredCredentials(
        fence: SessionFence(owner: owner, epoch: data['epoch'] as int),
        tokenRevision: data['tokenRevision'] as int,
        tokens: tokens,
      );
    } on PlatformException {
      throw _unavailable;
    } on FormatException {
      throw _invalid;
    } on ArgumentError {
      throw _invalid;
    }
  }

  @override
  Future<void> write(StoredCredentials credentials) async {
    credentials.tokens.validate();
    if (credentials.fence.epoch < 1 || credentials.tokenRevision < 1) {
      throw _invalid;
    }
    final owner = credentials.fence.owner;
    final value = jsonEncode({
      'version': 1,
      'origin': owner.serverOrigin.toString(),
      'userId': owner.userId,
      'epoch': credentials.fence.epoch,
      'tokenRevision': credentials.tokenRevision,
      'accessToken': credentials.tokens.accessToken,
      'refreshToken': credentials.tokens.refreshToken,
    });
    try {
      await _storage.write(key: _key(owner.serverOrigin), value: value);
    } on PlatformException {
      throw _unavailable;
    }
  }

  @override
  Future<void> delete(OwnerKey owner) async {
    try {
      StoredCredentials? stored;
      try {
        stored = await read(owner.serverOrigin);
      } on AppFailure catch (error) {
        if (error.code != 'invalid_stored_credentials' &&
            error.code != 'invalid_credentials') {
          rethrow;
        }
        // A corrupt record can never authorize an owner. Remove only this
        // origin's key so logout/relogin can recover without clearing other data.
        await _storage.delete(key: _key(owner.serverOrigin));
        return;
      }
      if (stored?.fence.owner == owner) {
        await _storage.delete(key: _key(owner.serverOrigin));
      }
    } on PlatformException {
      throw _unavailable;
    }
  }
}
