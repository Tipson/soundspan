import 'dart:convert';
import 'dart:io';
import 'dart:math';

import '../core/network/api_transport.dart';

/// Public bootstrap hint only. Credentials and owner admission belong to broker.
final class BootstrapPreferences {
  BootstrapPreferences(this.root);
  final Directory root;
  Future<void> _tail = Future.value();
  File get _file => File('${root.path}${Platform.pathSeparator}bootstrap.json');

  Future<void> _checkRoot() async {
    if (await FileSystemEntity.type(root.path, followLinks: false) !=
            FileSystemEntityType.directory ||
        await root.resolveSymbolicLinks() != root.absolute.path) {
      throw const FileSystemException('Noncanonical bootstrap directory');
    }
  }

  Future<Uri?> readOrigin() async {
    await _tail;
    await _checkRoot();
    if (await FileSystemEntity.type(_file.path, followLinks: false) !=
        FileSystemEntityType.file) {
      return null;
    }
    if (await _file.resolveSymbolicLinks() != _file.absolute.path ||
        await _file.length() > 4096) {
      return null;
    }
    try {
      final row = jsonDecode(await _file.readAsString());
      if (row is! Map ||
          row.length != 2 ||
          row['version'] != 1 ||
          row['origin'] is! String) {
        return null;
      }
      return normalizeServerOrigin(Uri.parse(row['origin'] as String));
    } catch (_) {
      return null;
    }
  }

  Future<void> saveOrigin(Uri origin) {
    final value = normalizeServerOrigin(origin).toString();
    final next = _tail.then((_) async {
      await _checkRoot();
      final nonce = List.generate(
        16,
        (_) => Random.secure().nextInt(256).toRadixString(16).padLeft(2, '0'),
      ).join();
      final temporary = File(
        '${root.path}${Platform.pathSeparator}bootstrap-$nonce.part',
      );
      try {
        await temporary.create(exclusive: true);
        await temporary.writeAsString(
          jsonEncode({'version': 1, 'origin': value}),
          flush: true,
        );
        await _checkRoot();
        final kind = await FileSystemEntity.type(
          _file.path,
          followLinks: false,
        );
        if (kind != FileSystemEntityType.notFound &&
            kind != FileSystemEntityType.file) {
          throw const FileSystemException('Unexpected bootstrap target');
        }
        if (kind == FileSystemEntityType.file &&
            await _file.resolveSymbolicLinks() != _file.absolute.path) {
          throw const FileSystemException('Linked bootstrap target');
        }
        await temporary.rename(_file.path);
      } finally {
        if (await FileSystemEntity.type(temporary.path, followLinks: false) ==
            FileSystemEntityType.file) {
          await temporary.delete();
        }
      }
    });
    _tail = next.then<void>((_) {}, onError: (Object _) {});
    return next;
  }

  Future<void> close() => _tail;
}
