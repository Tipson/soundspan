import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';

import '../core/model/owner_key.dart';

/// A root supplied by the application-private platform directory provider.
/// Callers never pass a stored absolute path to a filesystem operation.
final class PrivateMediaPaths {
  PrivateMediaPaths._(this.root, this.io);
  final Directory root;
  final PrivateMediaIo io;
  static Future<PrivateMediaPaths> create(
    Directory root, {
    PrivateMediaIo io = const NativePrivateMediaIo(),
  }) async {
    await root.create(recursive: true);
    final absolute = root.absolute.path;
    if (await FileSystemEntity.type(absolute, followLinks: false) !=
            FileSystemEntityType.directory ||
        await root.resolveSymbolicLinks() != absolute) {
      throw const FileSystemException('Private media root must be canonical');
    }
    return PrivateMediaPaths._(Directory(absolute), io);
  }

  Future<File> file(
    OwnerKey owner,
    String id,
    int generation,
    String claim, {
    bool ready = false,
  }) async {
    if (!RegExp(r'^[a-f0-9]{64}$').hasMatch(id) ||
        generation < 1 ||
        !RegExp(r'^[a-f0-9]{48}$').hasMatch(claim)) {
      throw const FileSystemException('Invalid private media segment');
    }
    final ownerHash = sha256
        .convert(
          utf8.encode(
            jsonEncode([owner.serverOrigin.toString(), owner.userId]),
          ),
        )
        .toString();
    var dir = root;
    for (final segment in [ownerHash, id, generation.toString(), claim]) {
      await _directory(dir);
      dir = Directory('${dir.path}${Platform.pathSeparator}$segment');
      final type = await FileSystemEntity.type(dir.path, followLinks: false);
      if (type == FileSystemEntityType.notFound) await dir.create();
      await _directory(dir);
    }
    final file = File(
      '${dir.path}${Platform.pathSeparator}${ready ? 'audio.media' : 'audio.part'}',
    );
    final type = await FileSystemEntity.type(file.path, followLinks: false);
    if (type != FileSystemEntityType.notFound &&
        type != FileSystemEntityType.file) {
      throw const FileSystemException('Private media file is not regular');
    }
    if (type == FileSystemEntityType.file &&
        await file.resolveSymbolicLinks() != file.absolute.path) {
      throw const FileSystemException('Private media path escaped root');
    }
    return file;
  }

  Future<void> _directory(Directory dir) async {
    if (await FileSystemEntity.type(dir.path, followLinks: false) !=
            FileSystemEntityType.directory ||
        await dir.resolveSymbolicLinks() != dir.absolute.path ||
        (dir.path != root.path &&
            !dir.path.startsWith('${root.path}${Platform.pathSeparator}'))) {
      throw const FileSystemException('Private media directory escaped root');
    }
  }
}

/// Narrow IO seam for platform storage failures. Path construction/validation
/// stays in PrivateMediaPaths; the production implementation uses ordinary
/// private Dart IO and never accepts a persisted path string.
abstract interface class PrivateMediaIo {
  Future<RandomAccessFile> openWrite(File file, {required bool append});
  Future<void> rename(File source, File target);
}

final class NativePrivateMediaIo implements PrivateMediaIo {
  const NativePrivateMediaIo();
  @override
  Future<RandomAccessFile> openWrite(File file, {required bool append}) =>
      file.open(mode: append ? FileMode.append : FileMode.write);
  @override
  Future<void> rename(File source, File target) async {
    await source.rename(target.path);
  }
}
