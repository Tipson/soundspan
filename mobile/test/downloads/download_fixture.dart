import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/network/dart_api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/core/session/local_session_authority.dart';
import 'package:soundspan/core/storage/owner_store.dart';
import 'package:soundspan/core/session/session_authority.dart';
import 'package:soundspan/downloads/download_verifier.dart';
import 'package:soundspan/downloads/download_models.dart';
import 'package:soundspan/downloads/download_repository.dart';
import 'package:soundspan/downloads/download_coordinator.dart';
import 'package:soundspan/downloads/private_media_paths.dart';
import 'package:soundspan/downloads/protected_media_fetcher.dart';
import 'package:soundspan/playback/playback_resolver.dart';

import '../support/auth_fakes.dart';
import '../support/fake_tls_server.dart';
import '../support/media_fixtures.dart';

class DownloadHarness {
  static const track = Track(
    ref: LibraryTrackRef('fixture'),
    title: 'Тест',
    artist: 'Автор',
  );
  late FakeTlsServer server;
  late LocalSessionAuthority authority;
  late DownloadTestStore store;
  late Directory root;
  late PrivateMediaPaths paths;
  final probe = WavProbe();
  late DownloadRepository repo;
  late DownloadCoordinator runner;
  DateTime currentTime = DateTime.now();
  SessionFence get fence => authority.requireFence();
  final requests = <String?>[];
  final validators = <String?>[];
  Future<void> Function(HttpRequest)? handler;
  Future<void> Function(DeviceDownload)? beforeRemove;
  static Future<DownloadHarness> create({
    PrivateMediaIo io = const NativePrivateMediaIo(),
  }) async {
    final h = DownloadHarness();
    h.server = await FakeTlsServer.start((r) async {
      h.requests.add(r.headers.value('range'));
      h.validators.add(r.headers.value('if-range'));
      try {
        if (h.handler != null) {
          await h.handler!(r);
        } else {
          await h.send(r);
        }
      } catch (_) {
        r.response.close().ignore();
      }
    });
    h.authority = await mediaAuthority(h.server.origin);
    h.store = DownloadTestStore(h.authority);
    h.root = await Directory.systemTemp.createTemp('t07-case-');
    h.paths = await PrivateMediaPaths.create(h.root, io: io);
    h.repo = h.newRepository();
    h.runner = h.newRunner(h.repo);
    return h;
  }

  DownloadRepository newRepository() => DownloadRepository(
    store: store,
    authority: authority,
    paths: paths,
    verifier: DownloadVerifier(probe: probe),
    beforeRemove: (j) async => await beforeRemove?.call(j),
    clock: () => currentTime,
  );
  DownloadCoordinator newRunner(
    DownloadRepository repository, {
    Future<void> Function(int bytes)? beforeWrite,
  }) => DownloadCoordinator(
    repository: repository,
    resolverForQuality: (q) => PlaybackResolver(
      authority: authority,
      transport: DartApiTransport(
        authority: authority,
        client: ScriptedJsonClient(
          (_, _) => throw StateError('Unexpected JSON'),
        ),
      ),
      quality: q,
    ),
    fetcher: ProtectedMediaFetcher(
      authority: authority,
      securityContext: server.clientContext,
      idleTimeout: const Duration(seconds: 2),
      maxConcurrent: 1,
    ),
    networkPolicy: const NetworkPolicy.online(),
    beforeWrite: beforeWrite,
  );
  Future<void> send(
    HttpRequest r, {
    String? etag = '"v1"',
    bool ignoreRange = false,
    bool chunked = false,
    int? wrongStart,
    List<int>? bytes,
  }) async {
    final payload = bytes ?? wavBytes();
    var start = 0;
    final range = r.headers.value('range');
    if (range != null && !ignoreRange) {
      start =
          wrongStart ??
          int.parse(RegExp(r'bytes=(\d+)-').firstMatch(range)![1]!);
      r.response.statusCode = 206;
      r.response.headers.set(
        'content-range',
        'bytes $start-${payload.length - 1}/${payload.length}',
      );
    }
    r.response.headers.set('content-type', 'audio/wav');
    if (etag != null) r.response.headers.set('etag', etag);
    if (!chunked) r.response.contentLength = payload.length - start;
    r.response.add(payload.sublist(start));
    await r.response.close();
  }

  Future<void> close() async {
    await runner.close();
    await server.close();
    await authority.invalidate();
    await root.delete(recursive: true);
  }
}

class FaultMediaIo implements PrivateMediaIo {
  String? fault;
  Future<void> Function()? afterRename;
  @override
  Future<RandomAccessFile> openWrite(File file, {required bool append}) async {
    if (fault == 'permission') {
      throw FileSystemException(
        'permission',
        file.path,
        const OSError('EACCES', 13),
      );
    }
    final real = await const NativePrivateMediaIo().openWrite(
      file,
      append: append,
    );
    return fault == 'full' ? FullFile(real) : real;
  }

  @override
  Future<void> rename(File source, File target) async {
    if (fault == 'rename') {
      throw FileSystemException(
        'rename',
        source.path,
        const OSError('EACCES', 13),
      );
    }
    await const NativePrivateMediaIo().rename(source, target);
    await afterRename?.call();
  }
}

class FullFile implements RandomAccessFile {
  FullFile(this.real);
  final RandomAccessFile real;
  @override
  Future<RandomAccessFile> writeFrom(
    List<int> buffer, [
    int start = 0,
    int? end,
  ]) async =>
      throw const FileSystemException('disk full', '', OSError('ENOSPC', 28));
  @override
  Future<void> close() => real.close();
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

// Generated silence, valid PCM WAV: no downloaded/commercial fixture assets.
List<int> wavBytes([int samples = 16000]) {
  final data = ByteData(44 + samples * 2);
  void text(int offset, String value) {
    for (var i = 0; i < value.length; i++) {
      data.setUint8(offset + i, value.codeUnitAt(i));
    }
  }

  text(0, 'RIFF');
  data.setUint32(4, data.lengthInBytes - 8, Endian.little);
  text(8, 'WAVE');
  text(12, 'fmt ');
  data.setUint32(16, 16, Endian.little);
  data.setUint16(20, 1, Endian.little);
  data.setUint16(22, 1, Endian.little);
  data.setUint32(24, 8000, Endian.little);
  data.setUint32(28, 16000, Endian.little);
  data.setUint16(32, 2, Endian.little);
  data.setUint16(34, 16, Endian.little);
  text(36, 'data');
  data.setUint32(40, samples * 2, Endian.little);
  return data.buffer.asUint8List();
}

class WavProbe implements MediaProbe {
  Future<void> Function()? before;
  @override
  Future<MediaProbeResult> probe(File file) async {
    await before?.call();
    final bytes = await file.readAsBytes();
    final data = ByteData.sublistView(Uint8List.fromList(bytes));
    final valid =
        bytes.length >= 44 &&
        latin1.decode(bytes.take(4).toList()) == 'RIFF' &&
        data.getUint32(4, Endian.little) + 8 == bytes.length &&
        data.getUint32(40, Endian.little) + 44 == bytes.length;
    return MediaProbeResult(
      decodable: valid,
      duration: valid
          ? Duration(milliseconds: (bytes.length - 44) ~/ 16)
          : Duration.zero,
    );
  }
}

class DownloadTestStore implements OwnerStore {
  DownloadTestStore(this.authority);
  final SessionAuthority authority;
  Map<String, Map<String, Object?>> rows = {};
  Future<void> tail = Future.value();
  String? failState;
  @override
  Future<T> transaction<T>(
    SessionFence fence,
    Future<T> Function(OwnerTransaction) operation,
  ) {
    final done = Completer<T>();
    tail = tail.then((_) async {
      try {
        await authority.assertCurrent(fence);
        final working = rows.map(
          (k, v) => MapEntry(
            k,
            Map<String, Object?>.from(jsonDecode(jsonEncode(v)) as Map),
          ),
        );
        final result = await operation(_Tx(working, fence.owner, failState));
        await authority.assertCurrent(fence);
        rows = working;
        done.complete(result);
      } catch (e, st) {
        done.completeError(e, st);
      }
    });
    return done.future;
  }
}

class _Tx implements OwnerTransaction {
  _Tx(this.rows, this.owner, this.failState);
  final Map<String, Map<String, Object?>> rows;
  final OwnerKey owner;
  final String? failState;
  String prefix(String ns) => '${owner.serverOrigin}|${owner.userId}|$ns|';
  @override
  Future<Map<String, Object?>?> read(String ns, String key) async =>
      rows['${prefix(ns)}$key'];
  @override
  Future<void> write(String ns, String key, Map<String, Object?> value) async {
    if (failState != null && value['state'] == failState) {
      throw const FileSystemException('injected disk full');
    }
    rows['${prefix(ns)}$key'] = value;
  }

  @override
  Future<void> remove(String ns, String key) async {
    rows.remove('${prefix(ns)}$key');
  }

  @override
  Future<List<OwnerRecord>> list(
    String ns, {
    String? afterKey,
    int limit = 100,
  }) async {
    final keys =
        rows.keys
            .where((k) => k.startsWith(prefix(ns)))
            .map((k) => k.substring(prefix(ns).length))
            .where((k) => afterKey == null || k.compareTo(afterKey) > 0)
            .toList()
          ..sort();
    return keys
        .take(limit)
        .map((k) => OwnerRecord(key: k, value: rows['${prefix(ns)}$k']!))
        .toList();
  }
}
