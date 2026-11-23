import 'dart:io';

import 'package:flutter/services.dart';

/// Best-effort disk admission, not a filesystem reservation or file-retention
/// policy. Keep a reserve plus two bounded writes for the shared Android pool;
/// unexpected external disk use still follows the existing IO failure path.
final class DeviceStorageGuard {
  const DeviceStorageGuard({this.readFreeBytes});
  final Future<Object?> Function()? readFreeBytes;
  static const minimumFreeBytes = 256 * 1024 * 1024;
  static const _channel = MethodChannel('soundspan/storage');

  Future<void> requireSpace(int bytes) async {
    if (bytes < 1 || bytes > 1024 * 1024) {
      throw RangeError.range(bytes, 1, 1024 * 1024, 'bytes');
    }
    Object? available;
    try {
      available = readFreeBytes != null
          ? await readFreeBytes!()
          : await _channel.invokeMethod<Object?>('freeBytes');
    } catch (_) {
      throw const FileSystemException('Storage capacity unavailable');
    }
    if (available is! int || available < 0) {
      throw const FileSystemException('Invalid storage capacity');
    }
    if (available < minimumFreeBytes + bytes * 2) {
      throw const FileSystemException(
        'Insufficient storage reserve',
        '',
        OSError('ENOSPC', 28),
      );
    }
  }
}
