import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:crypto/crypto.dart';

import '../core/storage/owner_store.dart';
import 'download_checkpoint.dart';

/// A playback reservation, not an upstream capability or an open Dart file.
/// The queue releases it only after the native decoder has stopped.
final class DeviceMediaReader {
  DeviceMediaReader(this.file, this._release);
  final File file;
  final Future<void> Function() _release;
  bool _released = false;
  Future<void>? _releasing;
  Future<void> release() {
    if (_released) return Future<void>.value();
    return _releasing ??= Future<void>.sync(_release)
        .then((_) => _released = true)
        .whenComplete(() => _releasing = null);
  }

  @override
  String toString() => 'DeviceMediaReader(<private>)';
}

final class DeviceFileRemoval {
  const DeviceFileRemoval(this.downloadId, this.file, this.token);
  final String downloadId, token;
  final DownloadCheckpoint file;
}

/// Exact-file metadata under the existing owner transaction. No timer expires
/// readers: an abandoned or unproven decoder remains conservatively protected.
abstract final class DeviceMediaBarrier {
  static const namespace = 'deviceMediaReaders.v1';
  static String fileKey(DownloadCheckpoint file) =>
      '${file.generation}:${file.claim}';
  static String key(String id, DownloadCheckpoint file) => sha256
      .convert(utf8.encode(jsonEncode([id, file.generation, file.claim])))
      .toString();
  static String _nonce() {
    final random = Random.secure();
    return List.generate(
      24,
      (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'),
    ).join();
  }

  static bool _opaque(Object? value) =>
      value is String && RegExp(r'^[a-f0-9]{48}$').hasMatch(value);

  static Map<String, Object?> _decode(
    Map<String, Object?> raw,
    String id,
    DownloadCheckpoint file,
  ) {
    final readers = raw['readers'];
    if (raw['version'] is! int ||
        raw['version'] != 1 ||
        raw['downloadId'] != id ||
        raw['file'] is! Map ||
        !const {'available', 'deleting', 'deleted'}.contains(raw['state']) ||
        readers is! Map ||
        readers.length > 64 ||
        readers.entries.any(
          (e) => !_opaque(e.key) || e.value is! int || (e.value as int) < 0,
        ) ||
        (raw['state'] == 'available'
            ? raw['removal'] != null
            : !_opaque(raw['removal'])) ||
        (raw['state'] != 'available' && readers.isNotEmpty)) {
      throw const FormatException('Invalid device media barrier');
    }
    final persisted = DownloadCheckpoint.fromJson(
      Map<String, Object?>.from(raw['file'] as Map),
    );
    if (fileKey(persisted) != fileKey(file)) {
      throw const FormatException('Device media file mismatch');
    }
    return {...raw, 'readers': Map<String, Object?>.from(readers)};
  }

  static Future<Map<String, Object?>> _read(
    OwnerTransaction tx,
    String id,
    DownloadCheckpoint file,
  ) async {
    final raw = await tx.read(namespace, key(id, file));
    return raw == null
        ? {
            'version': 1,
            'downloadId': id,
            'file': file.toJson(),
            'state': 'available',
            'readers': <String, Object?>{},
            'removal': null,
          }
        : _decode(raw, id, file);
  }

  static Future<bool> unavailable(
    OwnerTransaction tx,
    String id,
    DownloadCheckpoint file,
  ) async => (await _read(tx, id, file))['state'] != 'available';

  static Future<String?> acquire(
    OwnerTransaction tx,
    String id,
    DownloadCheckpoint file,
    int epoch,
  ) async {
    final row = await _read(tx, id, file);
    final readers = Map<String, Object?>.from(row['readers'] as Map);
    if (row['state'] != 'available' || readers.length >= 64) return null;
    final nonce = _nonce();
    readers[nonce] = epoch;
    await tx.write(namespace, key(id, file), {...row, 'readers': readers});
    return nonce;
  }

  static Future<void> release(
    OwnerTransaction tx,
    String id,
    DownloadCheckpoint file,
    String nonce,
  ) async {
    final row = await _read(tx, id, file),
        readers = Map<String, Object?>.from(row['readers'] as Map);
    if (!readers.containsKey(nonce)) return;
    readers.remove(nonce);
    if (readers.isEmpty && row['state'] == 'available') {
      await tx.remove(namespace, key(id, file));
    } else {
      await tx.write(namespace, key(id, file), {...row, 'readers': readers});
    }
  }

  /// All checks precede all writes; a rejected acquisition never leaves half
  /// of a download reserved. Existing admitted removals are recoverable.
  static Future<List<DeviceFileRemoval>?> reserve(
    OwnerTransaction tx,
    String id,
    Iterable<DownloadCheckpoint> files,
  ) async {
    final rows = <String, Map<String, Object?>>{};
    for (final file in files) {
      final row = await _read(tx, id, file);
      if ((row['readers'] as Map).isNotEmpty) return null;
      rows[key(id, file)] = row;
    }
    final removals = <DeviceFileRemoval>[];
    for (final entry in rows.entries) {
      final row = entry.value;
      if (row['state'] == 'deleted') continue;
      final token = row['state'] == 'deleting'
          ? row['removal'] as String
          : _nonce();
      final file = DownloadCheckpoint.fromJson(
        Map<String, Object?>.from(row['file'] as Map),
      );
      if (row['state'] != 'deleting') {
        await tx.write(namespace, entry.key, {
          ...row,
          'state': 'deleting',
          'removal': token,
        });
      }
      removals.add(DeviceFileRemoval(id, file, token));
    }
    return removals;
  }

  static Future<void> finalize(
    OwnerTransaction tx,
    DeviceFileRemoval removal,
  ) async {
    final row = await _read(tx, removal.downloadId, removal.file);
    if (row['state'] == 'deleted') return;
    if (row['state'] != 'deleting' || row['removal'] != removal.token) {
      throw const FormatException('Removal reservation changed');
    }
    await tx.write(namespace, key(removal.downloadId, removal.file), {
      ...row,
      'state': 'deleted',
    });
  }

  static Future<List<DeviceFileRemoval>> pending(OwnerTransaction tx) async {
    final result = <DeviceFileRemoval>[];
    String? after;
    while (true) {
      final page = await tx.list(namespace, afterKey: after);
      if (page.isEmpty) return result;
      for (final record in page) {
        final id = record.value['downloadId'];
        if (id is! String ||
            !RegExp(r'^[a-f0-9]{64}$').hasMatch(id) ||
            record.value['file'] is! Map) {
          throw const FormatException('Invalid removal identity');
        }
        final file = DownloadCheckpoint.fromJson(
          Map<String, Object?>.from(record.value['file'] as Map),
        );
        final row = _decode(record.value, id, file);
        if (record.key != key(id, file)) {
          throw const FormatException('Invalid removal key');
        }
        if (row['state'] == 'deleting') {
          result.add(DeviceFileRemoval(id, file, row['removal'] as String));
        }
      }
      after = page.last.key;
    }
  }
}
