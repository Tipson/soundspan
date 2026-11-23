import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';

import '../core/model/owner_key.dart';
import '../core/model/track_ref.dart';
import '../core/network/network_policy.dart';
import '../core/session/session_authority.dart';
import '../core/storage/owner_store.dart';
import 'artwork_loader.dart';

/// Downloads only the account server's cover proxy. The durable index contains
/// opaque identities and verified PNG hashes, never upstream hints or tokens.
final class ArtworkRepository extends ChangeNotifier implements ArtworkLoader {
  ArtworkRepository({
    required this.authority,
    required this.store,
    required this.fence,
    required this.networkPolicy,
    required this.privateRoot,
    this.testSecurityContext,
    this.fileIo = const NativeArtworkFileIo(),
    this.timeout = const Duration(seconds: 15),
  }) {
    _session = authority.changes.listen((_) {
      if (!isCurrent) {
        _hints.clear();
        cancelNetwork();
        notifyListeners();
      }
    });
    final policy = networkPolicy;
    if (policy is Listenable) {
      (policy as Listenable).addListener(_policyChanged);
    }
  }
  final SessionAuthority authority;
  final OwnerStore store;
  @override
  final SessionFence fence;
  final NetworkPolicy networkPolicy;

  /// Must be the canonical application-support artwork-cache directory.
  final Directory privateRoot;
  final SecurityContext? testSecurityContext;
  final Duration timeout;
  final ArtworkFileIo fileIo;
  static const maxEncodedBytes = 4 * 1024 * 1024;
  static const maxIntrinsicEdge = 8192;
  static const maxIntrinsicPixels = 32 * 1024 * 1024;
  static const maxDecodedEdge = 1024;
  final _flights = <String, Future<File?>>{};
  final _flightEdges = <String, int>{};
  // Queue codecs discard URLs. Keep only a bounded, owner-local set of original
  // hints for resolution upgrades; the durable index remains URL-free.
  final _hints = <String, Uri>{};
  final _clients = <HttpClient>{};
  final _slots = List<Future<void>>.generate(3, (_) => Future.value());
  late final StreamSubscription<SessionState> _session;
  bool _closed = false;
  int _networkGeneration = 0, _nextSlot = 0;
  Future<void>? _closing;
  Future<void> _publicationTail = Future.value();
  @override
  bool get isCurrent => !_closed && authority.isCurrent(fence);
  void _policyChanged() {
    if (!networkPolicy.networkAllowed) cancelNetwork();
  }

  /// Cancels active requests, but preserves verified cached artwork offline.
  void cancelNetwork() {
    _networkGeneration++;
    for (final client in _clients.toList()) {
      client.close(force: true);
    }
  }

  Future<void> _guard({int? networkGeneration}) async {
    if (!isCurrent) throw StateError('Artwork session revoked');
    await authority.assertCurrent(fence);
    if (!isCurrent) throw StateError('Artwork session revoked');
    if (networkGeneration != null) {
      networkPolicy.requireNetwork();
      if (networkGeneration != _networkGeneration) {
        throw StateError('Artwork cancelled');
      }
    }
  }

  static String _hash(List<int> value) => sha256.convert(value).toString();
  @override
  Future<File?> load({TrackRef? ref, Uri? hint, int edge = 512}) {
    if (!isCurrent || (ref == null && hint == null)) return Future.value();
    final key = _hash(
      utf8.encode(ref == null ? 'hint:$hint' : 'track:${ref.identityKey}'),
    );
    final requestedEdge = edge.clamp(1, maxDecodedEdge);
    if (hint != null && _coverUri(hint, requestedEdge) != null) {
      _hints.remove(key);
      _hints[key] = hint;
      if (_hints.length > 128) _hints.remove(_hints.keys.first);
    }
    final existing = _flights[key];
    if (existing != null) {
      if (_flightEdges[key]! >= requestedEdge) return existing;
      // An earlier thumbnail cannot satisfy a later full-size request. Wait
      // before upgrading, so a late smaller publication can never downgrade it.
      return existing.then(
        (_) => load(ref: ref, hint: hint, edge: requestedEdge),
      );
    }
    if (_flights.length >= 128) return Future.value();
    final slot = _nextSlot++ % _slots.length;
    final result = _slots[slot].then((_) async {
      try {
        return await _load(key, hint ?? _hints[key], requestedEdge);
      } catch (_) {
        return null;
      }
    });
    _flights[key] = result;
    _flightEdges[key] = requestedEdge;
    _slots[slot] = result.then((_) {
      _flights.remove(key);
      _flightEdges.remove(key);
    });
    return result;
  }

  Future<Directory> _directory() async {
    final root = privateRoot.absolute;
    // Reject links at every existing component before creating our namespace.
    Directory cursor = root;
    while (true) {
      if (await FileSystemEntity.type(cursor.path, followLinks: false) ==
          FileSystemEntityType.link) {
        throw const FileSystemException('Linked artwork root');
      }
      final parent = cursor.parent;
      if (parent.path == cursor.path) break;
      cursor = parent;
    }
    await root.create(recursive: true);
    final canonical = await root.resolveSymbolicLinks();
    if (canonical.toLowerCase() != root.path.toLowerCase()) {
      throw const FileSystemException('Noncanonical artwork root');
    }
    final ownerHash = _hash(
      utf8.encode(
        jsonEncode([fence.owner.serverOrigin.toString(), fence.owner.userId]),
      ),
    );
    final dir = Directory('${root.path}${Platform.pathSeparator}$ownerHash');
    if (await FileSystemEntity.type(dir.path, followLinks: false) ==
        FileSystemEntityType.link) {
      throw const FileSystemException('Linked artwork owner');
    }
    await dir.create();
    if ((await dir.resolveSymbolicLinks()).toLowerCase() !=
        dir.path.toLowerCase()) {
      throw const FileSystemException('Noncanonical artwork owner');
    }
    return dir;
  }

  Future<({File file, int edge})?> _cached(String key, Directory dir) async {
    final row = await store.transaction(fence, (tx) => tx.read('artwork', key));
    if (row == null ||
        row['version'] != 1 ||
        row['hash'] is! String ||
        row['bytes'] is! int) {
      return null;
    }
    final hash = row['hash'] as String;
    final size = row['bytes'] as int;
    if (!RegExp(r'^[a-f0-9]{64}$').hasMatch(hash) ||
        size < 1 ||
        size > maxEncodedBytes) {
      return null;
    }
    final file = File('${dir.path}${Platform.pathSeparator}$hash.png');
    if (await FileSystemEntity.type(file.path, followLinks: false) !=
            FileSystemEntityType.file ||
        await file.length() != size) {
      return null;
    }
    if (await file.resolveSymbolicLinks() != file.absolute.path) return null;
    final bytes = await file.readAsBytes();
    if (bytes.length != size || _hash(bytes) != hash) return null;
    await _guard();
    final edge = row['edge'];
    return (
      file: file,
      edge: edge is int && edge > 0 && edge <= maxDecodedEdge ? edge : 0,
    );
  }

  Future<File?> _load(String key, Uri? hint, int edge) async {
    await _guard();
    final dir = await _directory();
    await _guard();
    final cached = await _cached(key, dir);
    if (cached != null && cached.edge >= edge) return cached.file;
    if (hint == null || !networkPolicy.networkAllowed) return cached?.file;
    try {
      final generation = _networkGeneration;
      final uri = _coverUri(hint, edge);
      if (uri == null) return isCurrent ? cached?.file : null;
      final bytes = await _fetch(uri, generation);
      await _guard(networkGeneration: generation);
      final raster = await _raster(bytes, edge);
      await _guard(networkGeneration: generation);
      // Different track identities may normalize to the same content filename.
      // Serialize publication so Windows rename cannot race an existing writer.
      final publication = _publicationTail.then(
        (_) => _publish(key, dir, raster, generation, edge),
      );
      _publicationTail = publication.then<void>((_) {}, onError: (Object _) {});
      return await publication;
    } catch (_) {
      // Keep verified lower-resolution art usable if an upgrade is unavailable.
      return isCurrent ? cached?.file : null;
    }
  }

  Future<File> _publish(
    String key,
    Directory dir,
    Uint8List raster,
    int generation,
    int edge,
  ) async {
    await _guard(networkGeneration: generation);
    // Revalidate directory immediately before writing, after untrusted IO.
    await _directory();
    final hash = _hash(raster);
    final file = File('${dir.path}${Platform.pathSeparator}$hash.png');
    final nonce = _hash(
      List<int>.generate(16, (_) => Random.secure().nextInt(256)),
    );
    final temp = File('${dir.path}${Platform.pathSeparator}$key-$nonce.part');
    try {
      if (await FileSystemEntity.type(temp.path, followLinks: false) !=
          FileSystemEntityType.notFound) {
        throw const FileSystemException('Existing artwork temporary file');
      }
      await temp.writeAsBytes(raster, flush: true);
      await _guard(networkGeneration: generation);
      final targetType = await FileSystemEntity.type(
        file.path,
        followLinks: false,
      );
      if (targetType != FileSystemEntityType.notFound &&
          targetType != FileSystemEntityType.file) {
        throw const FileSystemException('Invalid artwork target');
      }
      if (targetType == FileSystemEntityType.file) {
        if (await file.length() > maxEncodedBytes ||
            _hash(await file.readAsBytes()) != hash) {
          await file.delete();
        } else {
          await temp.delete();
        }
      }
      if (await temp.exists()) await fileIo.rename(temp, file);
      await _guard(networkGeneration: generation);
      await store.transaction(fence, (tx) async {
        // The store checks the original fence under its transaction lock.
        // Calling the broker here could acquire that same database again.
        if (!isCurrent || generation != _networkGeneration) {
          throw StateError('Artwork publication cancelled');
        }
        networkPolicy.requireNetwork();
        await tx.write('artwork', key, {
          'version': 1,
          'hash': hash,
          'bytes': raster.length,
          'edge': edge,
        });
      });
      await _guard(networkGeneration: generation);
      return file;
    } finally {
      if (await FileSystemEntity.type(temp.path, followLinks: false) ==
          FileSystemEntityType.file) {
        await temp.delete();
      }
    }
  }

  Uri? _coverUri(Uri hint, int edge) {
    var value = hint.toString();
    if (value.isEmpty ||
        value.length > 16384 ||
        hint.scheme == 'file' ||
        hint.scheme == 'content' ||
        hint.scheme == 'data') {
      return null;
    }
    final origin = fence.owner.serverOrigin;
    if (hint.scheme == 'http' ||
        hint.scheme == 'https' ||
        hint.scheme == 'native') {
      if ((hint.host == 'i.ytimg.com' || hint.host == 'img.youtube.com') &&
          RegExp(r'^/vi/[^/]+/hqdefault\.jpg$').hasMatch(hint.path)) {
        value = hint
            .replace(
              path: hint.path.replaceFirst('hqdefault.jpg', 'mqdefault.jpg'),
            )
            .toString();
      }
      return origin.replace(
        path: '/api/library/cover-art',
        queryParameters: {'url': value, 'size': '$edge'},
      );
    }
    if (hint.hasScheme || hint.hasAuthority) return null;
    return origin.replace(
      pathSegments: ['api', 'library', 'cover-art', value],
      queryParameters: {'size': '$edge'},
    );
  }

  Future<Uint8List> _fetch(Uri uri, int generation) async {
    await _guard(networkGeneration: generation);
    final client = HttpClient(context: testSecurityContext)
      ..connectionTimeout = timeout
      ..autoUncompress = false;
    _clients.add(client);
    var expired = false;
    final timer = Timer(timeout, () {
      expired = true;
      client.close(force: true);
    });
    Future<void> check() async {
      await _guard(networkGeneration: generation);
      if (expired) throw TimeoutException('Artwork deadline');
    }

    try {
      for (var attempt = 0; attempt < 2; attempt++) {
        await check();
        final grant = await authority
            .grantAccess(fence, fence.owner.serverOrigin)
            .timeout(timeout);
        await check();
        final request = await client.getUrl(uri);
        request.followRedirects = false;
        await check();
        request.headers.set(
          HttpHeaders.authorizationHeader,
          'Bearer ${grant.accessToken}',
        );
        request.headers.set(
          HttpHeaders.acceptHeader,
          'image/png,image/jpeg,image/webp',
        );
        final response = await request.close();
        await check();
        if (response.statusCode == 401 && attempt == 0) {
          // No unbounded body drain is needed: dispose this connection.
          request.abort();
          await authority.after401(grant.authStamp).timeout(timeout);
          await check();
          continue;
        }
        final mime = response.headers.contentType?.mimeType;
        if (response.statusCode != 200 ||
            !{
              'image/png',
              'image/jpeg',
              'image/webp',
              'image/gif',
            }.contains(mime) ||
            response.contentLength > maxEncodedBytes ||
            response.headers.value('content-encoding') != null) {
          throw const FormatException('Invalid artwork response');
        }
        final data = BytesBuilder(copy: false);
        await for (final chunk in response) {
          await check();
          if (data.length + chunk.length > maxEncodedBytes) {
            throw const FormatException('Artwork too large');
          }
          data.add(chunk);
        }
        await check();
        if (data.length == 0 ||
            (response.contentLength >= 0 &&
                data.length != response.contentLength)) {
          throw const FormatException('Truncated artwork');
        }
        return data.takeBytes();
      }
      throw const FormatException('Artwork authorization failed');
    } finally {
      timer.cancel();
      client.close(force: true);
      _clients.remove(client);
    }
  }

  Future<Uint8List> _raster(Uint8List bytes, int edge) async {
    final buffer = await ui.ImmutableBuffer.fromUint8List(bytes);
    ui.ImageDescriptor? descriptor;
    ui.Codec? codec;
    ui.Image? image;
    try {
      descriptor = await ui.ImageDescriptor.encoded(buffer);
      final w = descriptor.width, h = descriptor.height;
      if (w < 1 ||
          h < 1 ||
          w > maxIntrinsicEdge ||
          h > maxIntrinsicEdge ||
          w * h > maxIntrinsicPixels) {
        throw const FormatException('Artwork dimensions exceed budget');
      }
      final scale = (edge / (w > h ? w : h)).clamp(0.0, 1.0);
      codec = await descriptor.instantiateCodec(
        targetWidth: (w * scale).round().clamp(1, edge),
        targetHeight: (h * scale).round().clamp(1, edge),
      );
      image = (await codec.getNextFrame()).image;
      final png = await image.toByteData(format: ui.ImageByteFormat.png);
      if (png == null || png.lengthInBytes > maxEncodedBytes) {
        throw const FormatException('Invalid normalized artwork');
      }
      return png.buffer.asUint8List(png.offsetInBytes, png.lengthInBytes);
    } finally {
      image?.dispose();
      codec?.dispose();
      descriptor?.dispose();
      buffer.dispose();
    }
  }

  /// Stops admission synchronously and drains all IO before the owner DB closes.
  Future<void> close() {
    final existing = _closing;
    if (existing != null) return existing;
    final completion = Completer<void>();
    // Publish before _close synchronously notifies revocation listeners: a
    // listener may request cleanup again while the first close is still here.
    _closing = completion.future;
    completion.complete(_close());
    return completion.future;
  }

  Future<void> _close() async {
    _closed = true;
    _hints.clear();
    cancelNetwork();
    notifyListeners();
    final policy = networkPolicy;
    if (policy is Listenable) {
      (policy as Listenable).removeListener(_policyChanged);
    }
    await _session.cancel();
    await Future.wait(_flights.values.toList());
    super.dispose();
  }
}

/// Narrow filesystem boundary for native rename failures and close/drain tests.
abstract interface class ArtworkFileIo {
  Future<void> rename(File source, File target);
}

final class NativeArtworkFileIo implements ArtworkFileIo {
  const NativeArtworkFileIo();
  @override
  Future<void> rename(File source, File target) async {
    await source.rename(target.path);
  }
}
