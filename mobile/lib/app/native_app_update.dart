import 'package:flutter/services.dart';

import '../core/model/app_failure.dart';
import '../features/updates/apk_update_downloader.dart';
import '../features/updates/mobile_release_manifest.dart';

abstract interface class AppUpdateInstaller {
  Future<InstalledAppInfo> installedInfo();
  Future<bool> installPermission();
  Future<void> openInstallSettings();
  Future<void> stageAndRequestInstall(
    VerifiedApk apk,
    String nonce,
    bool Function() isCurrent, {
    Future<void> Function()? beforeCommit,
  });
  Future<void> cancelOwn(String nonce);
  Future<bool> pendingInstall();
  Future<void> cancelPendingInstall();
}

final class NativeAppUpdate implements AppUpdateInstaller {
  static const _channel = MethodChannel('soundspan/app_update');
  static const unavailable = AppFailure(
    code: 'app_update_unavailable',
    message: 'Не удалось подготовить обновление приложения.',
  );
  Future<Object?> _call(
    String method, [
    Object? args,
    Duration timeout = const Duration(seconds: 5),
  ]) async {
    try {
      return await _channel
          .invokeMethod<Object?>(method, args)
          .timeout(timeout);
    } catch (_) {
      throw unavailable;
    }
  }

  @override
  Future<InstalledAppInfo> installedInfo() async {
    final raw = await _call('installedInfo');
    if (raw is! Map ||
        raw.length != 8 ||
        raw['applicationId'] is! String ||
        raw['versionCode'] is! int ||
        raw['versionName'] is! String ||
        raw['channel'] is! String ||
        raw['signerSha256'] is! String ||
        raw['sdk'] is! int ||
        raw['abis'] is! List ||
        raw['trusted'] != true) {
      throw unavailable;
    }
    final abis = raw['abis'] as List;
    if (abis.isEmpty || abis.length > 16 || abis.any((a) => a is! String)) {
      throw unavailable;
    }
    final info = InstalledAppInfo(
      applicationId: raw['applicationId'] as String,
      versionCode: raw['versionCode'] as int,
      versionName: raw['versionName'] as String,
      channel: raw['channel'] as String,
      signerSha256: raw['signerSha256'] as String,
      sdk: raw['sdk'] as int,
      abis: List.unmodifiable(abis.cast<String>()),
    );
    if (!info.trusted || info.sdk < 24) throw unavailable;
    return info;
  }

  @override
  Future<bool> installPermission() async {
    final value = await _call('installPermission');
    if (value is! bool) throw unavailable;
    return value;
  }

  @override
  Future<void> openInstallSettings() async {
    await _call('openInstallSettings');
  }

  @override
  Future<void> stageAndRequestInstall(
    VerifiedApk apk,
    String nonce,
    bool Function() isCurrent, {
    Future<void> Function()? beforeCommit,
  }) async {
    void check() {
      if (!isCurrent()) throw UpdateCancellation.cancelled;
    }

    try {
      check();
      final staged = await _call('stage', {
        'id': apk.id,
        'nonce': nonce,
        'versionCode': apk.manifest.versionCode,
        'channel': apk.manifest.channel,
        'bytes': apk.manifest.bytes,
        'sha256': apk.manifest.sha256,
      }, const Duration(seconds: 60));
      check();
      if (staged is! Map ||
          staged.length != 1 ||
          staged['sessionId'] is! int ||
          (staged['sessionId'] as int) <= 0) {
        throw unavailable;
      }
      await beforeCommit?.call();
      check();
      final result = await _call('commit', {
        'nonce': nonce,
        'sessionId': staged['sessionId'],
      });
      if (result != 'handedToSystem') throw unavailable;
      // Accepted OS handoff is not an installed-version assertion.
    } catch (_) {
      try {
        await cancelOwn(nonce);
      } catch (_) {}
      rethrow;
    }
  }

  @override
  Future<void> cancelOwn(String nonce) async {
    await _call('cancel', {'nonce': nonce});
  }

  @override
  Future<bool> pendingInstall() async {
    final value = await _call('pendingInstall');
    if (value is! bool) throw unavailable;
    return value;
  }

  @override
  Future<void> cancelPendingInstall() async {
    await _call('cancelPendingInstall');
  }
}
