import 'dart:async';
import 'dart:io';

import 'package:crypto/crypto.dart' as crypto;

import '../../core/model/app_failure.dart';
import '../../core/network/api_transport.dart';
import '../../core/network/request_cancellation.dart';
import 'mobile_release_manifest.dart';

final class UpdateCancellation implements RequestCancellation {
  AppFailure? _reason;
  final _listeners = <void Function()>{};
  void cancel({AppFailure reason = cancelled}) {
    if (_reason != null) return;
    _reason = reason;
    for (final listener in _listeners.toList()) {
      listener();
    }
    _listeners.clear();
  }

  @override
  void check() {
    if (_reason case final reason?) throw reason;
  }

  @override
  void Function() listen(void Function() listener) {
    if (_reason != null) {
      listener();
      return () {};
    }
    _listeners.add(listener);
    return () => _listeners.remove(listener);
  }

  static const cancelled = AppFailure(
    code: 'update_cancelled',
    message: 'Обновление отменено',
  );
}

final class VerifiedApk {
  const VerifiedApk(this.id, this.manifest);
  final String id;
  final MobileReleaseManifest manifest;
}

abstract interface class UpdateApkDownload {
  Future<void> prepare();
  Future<VerifiedApk> download(
    MobileReleaseManifest manifest, {
    required bool Function() isCurrent,
    required UpdateCancellation cancellation,
    void Function(int)? onProgress,
  });
  Future<void> requireSpace(MobileReleaseManifest manifest);
  Future<void> discard(VerifiedApk apk);
}

final class ApkUpdateDownloader implements UpdateApkDownload {
  /// Explicit-entry recovery only; unknown entries and links block cleanup.
  @override
  Future<void> prepare() async {
    if (_busy) throw _failed;
    final type = await FileSystemEntity.type(
      directory.path,
      followLinks: false,
    );
    if (type == FileSystemEntityType.notFound) return;
    if (type != FileSystemEntityType.directory) throw _failed;
    final entries = await directory.list(followLinks: false).take(5).toList();
    if (entries.length > 4) throw _failed;
    final name = RegExp(r'^[A-Za-z0-9_-]{32}\.(apk|part)$');
    for (final entry in entries) {
      if (!name.hasMatch(entry.uri.pathSegments.last) ||
          await FileSystemEntity.type(entry.path, followLinks: false) !=
              FileSystemEntityType.file) {
        throw _failed;
      }
    }
    for (final entry in entries) {
      await entry.delete();
    }
  }

  ApkUpdateDownloader({
    required this.directory,
    required this.admit,
    required this.readFreeBytes,
    HttpClient Function()? createClient,
    this.idleTimeout = const Duration(seconds: 30),
    this.totalTimeout = const Duration(minutes: 10),
  }) : createClient = createClient ?? HttpClient.new;
  final Directory directory;
  final Future<void> Function() admit;
  final Future<int> Function() readFreeBytes;
  final HttpClient Function() createClient;
  final Duration idleTimeout, totalTimeout;
  bool _busy = false;
  static const reserveBytes = 256 * 1024 * 1024;
  static const _failed = AppFailure(
    code: 'update_download_failed',
    message: 'Не удалось скачать и проверить обновление. Попробуйте ещё раз.',
  );
  static const _lowDisk = AppFailure(
    code: 'update_storage',
    message: 'Недостаточно свободного места для обновления.',
  );
  static const _deadline = AppFailure(
    code: 'update_timeout',
    message: 'Загрузка обновления заняла слишком много времени.',
  );
  @override
  Future<void> requireSpace(MobileReleaseManifest manifest) async {
    final free = await readFreeBytes();
    if (free < reserveBytes + manifest.bytes * 2) throw _lowDisk;
  }

  @override
  Future<void> discard(VerifiedApk apk) async {
    if (!RegExp(r'^[A-Za-z0-9_-]{32}$').hasMatch(apk.id)) throw _failed;
    final file = File('${directory.path}/${apk.id}.apk');
    if (await file.exists()) await file.delete();
  }

  @override
  Future<VerifiedApk> download(
    MobileReleaseManifest manifest, {
    required bool Function() isCurrent,
    required UpdateCancellation cancellation,
    void Function(int)? onProgress,
  }) async {
    if (_busy) throw _failed;
    _busy = true;
    final id = newPlaybackTraceId();
    final partial = File('${directory.path}/$id.part');
    final target = File('${directory.path}/$id.apk');
    HttpClient? client;
    RandomAccessFile? file;
    var complete = false;
    void check() {
      cancellation.check();
      if (!isCurrent()) throw UpdateCancellation.cancelled;
    }

    Future<void> admission() async {
      check();
      await cancellation.run(admit);
      check();
    }

    void Function()? remove;
    final timer = Timer(
      totalTimeout,
      () => cancellation.cancel(reason: _deadline),
    );
    try {
      await admission();
      await cancellation.run(() => requireSpace(manifest));
      check();
      await directory.create(recursive: true);
      check();
      client = createClient()
        ..connectionTimeout = const Duration(seconds: 15)
        ..autoUncompress = false;
      remove = cancellation.listen(() => client?.close(force: true));
      final request = await cancellation.run(
        () => client!.getUrl(manifest.apkUri),
      );
      check();
      request.followRedirects = false;
      request.headers.set(HttpHeaders.acceptEncodingHeader, 'identity');
      final response = await cancellation.run(
        () => request.close().timeout(const Duration(seconds: 15)),
      );
      check();
      if (response.statusCode != 200 ||
          (response.contentLength >= 0 &&
              response.contentLength != manifest.bytes) ||
          (response.headers.value(HttpHeaders.contentEncodingHeader) != null &&
              response.headers.value(HttpHeaders.contentEncodingHeader) !=
                  'identity')) {
        throw _failed;
      }
      file = await partial.open(mode: FileMode.write);
      check();
      final digest = _DigestSink();
      final hash = crypto.sha256.startChunkedConversion(digest);
      var received = 0;
      await for (final chunk in response.timeout(idleTimeout)) {
        await admission();
        if (received + chunk.length > manifest.bytes) throw _failed;
        hash.add(chunk);
        await file.writeFrom(chunk);
        check();
        received += chunk.length;
        onProgress?.call(received);
        check();
      }
      hash.close();
      if (received != manifest.bytes ||
          digest.value?.toString() != manifest.sha256) {
        throw _failed;
      }
      await file.flush();
      check();
      await file.close();
      file = null;
      await admission();
      await partial.rename(target.path);
      check();
      complete = true;
      return VerifiedApk(id, manifest);
    } catch (e) {
      if (e is AppFailure) rethrow;
      throw _failed;
    } finally {
      timer.cancel();
      remove?.call();
      client?.close(force: true);
      try {
        await file?.close();
      } finally {
        try {
          if (!complete) {
            for (final owned in [partial, target]) {
              if (await owned.exists()) await owned.delete();
            }
          }
        } finally {
          _busy = false;
        }
      }
    }
  }
}

final class _DigestSink implements Sink<crypto.Digest> {
  crypto.Digest? value;
  @override
  void add(crypto.Digest data) {
    value = data;
  }

  @override
  void close() {}
}
