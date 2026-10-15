import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import '../core/model/app_failure.dart';
import '../core/model/owner_key.dart';
import '../core/session/session_authority.dart';
import '../downloads/protected_media_fetcher.dart';
import 'resolved_media.dart';

/// Runtime-only capability for one media target and immutable session fence.
final class MediaHandle {
  MediaHandle._(this.uri, this._revoke);
  final Uri uri;
  final Future<void> Function() _revoke;
  Future<void> revoke() => _revoke();
  @override
  String toString() => 'MediaHandle(<private>)';
}

final class _Entry {
  _Entry(this.media, this.fence);
  final ResolvedMedia media;
  final SessionFence fence;
  final MediaCancellation cancellation = MediaCancellation();
  final Set<Socket> sockets = {};
}

/// A bounded IPv4 loopback gateway. Native requests select a random capability;
/// they cannot supply upstream URLs, identities or account credentials.
final class MediaGateway {
  MediaGateway({
    required this.fetcher,
    required this.authority,
    this.maxHandles = 128,
    this.maxStreams = 8,
  }) {
    _events = authority.changes.listen((_) {
      for (final entry in List.of(_entries.entries)) {
        if (!authority.isCurrent(entry.value.fence)) _revoke(entry.key);
      }
    });
  }
  final ProtectedMediaFetcher fetcher;
  final SessionAuthority authority;
  final int maxHandles;
  final int maxStreams;
  final Map<String, _Entry> _entries = {};
  late final StreamSubscription<SessionState> _events;
  Future<HttpServer>? _binding;
  bool _closed = false;
  int _streams = 0;

  Future<MediaHandle> open(ResolvedMedia media, SessionFence fence) async {
    await authority.assertCurrent(fence);
    if (_closed || media.fence != fence || _entries.length >= maxHandles) {
      throw invalidMedia;
    }
    _binding ??= _bind();
    final server = await _binding!;
    await authority.assertCurrent(fence);
    if (_closed || _entries.length >= maxHandles) throw invalidMedia;
    final random = Random.secure();
    String path;
    do {
      path =
          '/${base64Url.encode(List.generate(24, (_) => random.nextInt(256)))}/media';
    } while (_entries.containsKey(path));
    _entries[path] = _Entry(media, fence);
    return MediaHandle._(
      Uri(scheme: 'http', host: '127.0.0.1', port: server.port, path: path),
      () async {
        _revoke(path);
      },
    );
  }

  Future<HttpServer> _bind() async {
    final server = await HttpServer.bind(
      InternetAddress.loopbackIPv4,
      0,
      shared: false,
    );
    server.idleTimeout = const Duration(seconds: 30);
    server.listen((request) {
      unawaited(_serve(server, request));
    });
    return server;
  }

  void _revoke(String path) {
    final entry = _entries.remove(path);
    if (entry == null) return;
    entry.cancellation.cancel();
    for (final socket in List.of(entry.sockets)) {
      socket.destroy();
    }
  }

  Future<void> _serve(HttpServer server, HttpRequest request) async {
    final output = request.response;
    ProtectedMediaResponse? upstream;
    _Entry? entry;
    Socket? socket;
    StreamSubscription<List<int>>? incoming;
    void Function()? unlink;
    final cancellation = MediaCancellation();
    var slot = false;
    var headersSent = false;
    var headerSize = 0;
    request.headers.forEach((name, values) {
      headerSize +=
          name.length + values.fold<int>(0, (sum, value) => sum + value.length);
    });
    try {
      final uri = request.uri;
      if (_closed ||
          request.connectionInfo?.remoteAddress.isLoopback != true ||
          uri.hasAuthority ||
          uri.hasQuery ||
          uri.hasFragment ||
          uri.toString().length > 128 ||
          uri.toString().contains('%') ||
          headerSize > 8192 ||
          request.headers.value('host') != '127.0.0.1:${server.port}' ||
          request.headers.value('origin') != null ||
          !RegExp(r'^/[a-zA-Z0-9_-]{32}/media$').hasMatch(uri.path)) {
        output.statusCode = 404;
        return;
      }
      if (!const {'GET', 'HEAD'}.contains(request.method)) {
        output.statusCode = 405;
        return;
      }
      if (request.contentLength > 0 ||
          request.headers.chunkedTransferEncoding) {
        output.statusCode = 400;
        return;
      }
      entry = _entries[uri.path];
      if (entry == null || !authority.isCurrent(entry.fence)) {
        output.statusCode = 404;
        return;
      }
      if (_streams >= maxStreams) {
        output.statusCode = 503;
        return;
      }
      final rawRange = request.headers.value('range');
      final range = rawRange == null ? null : ByteRange.parse(rawRange);
      final ifRange = request.headers.value('if-range');
      _streams++;
      slot = true;
      final currentEntry = entry;
      // Dart's HTTP parser pauses while a response is active. response.done
      // alone therefore cannot observe native disconnect while upstream stalls.
      // Detach after admission, observe socket EOF, and own bounded framing.
      // One request per connection avoids accepting pipelined native requests.
      socket = await output.detachSocket(writeHeaders: false);
      entry.sockets.add(socket);
      final downstream = socket;
      unlink = entry.cancellation.listen(() {
        cancellation.cancel();
        downstream.destroy();
      });
      incoming = socket.listen(
        (_) {
          cancellation.cancel();
          downstream.destroy();
        },
        onDone: cancellation.cancel,
        onError: (Object _) {
          cancellation.cancel();
        },
      );
      upstream = await fetcher.open(
        entry.media,
        entry.fence,
        method: request.method,
        range: range,
        ifRange: ifRange,
        cancellation: cancellation,
      );
      await authority.assertCurrent(currentEntry.fence);
      cancellation.check();
      final chunked =
          !upstream.headers.containsKey('content-length') &&
          request.method != 'HEAD';
      _writeHeaders(socket, upstream.statusCode, {
        ...upstream.headers,
        if (chunked) 'transfer-encoding': 'chunked',
      });
      headersSent = true;
      await socket.flush().timeout(fetcher.idleTimeout);
      await for (final chunk in upstream.body) {
        cancellation.check();
        if (chunk.isEmpty) continue;
        if (chunked) {
          socket.add(ascii.encode('${chunk.length.toRadixString(16)}\r\n'));
        }
        socket.add(chunk);
        if (chunked) socket.add(const [13, 10]);
        await socket.flush().timeout(fetcher.idleTimeout);
      }
      cancellation.check();
      if (chunked) socket.add(const [48, 13, 10, 13, 10]);
      await socket.flush().timeout(fetcher.idleTimeout);
    } catch (error) {
      final status = error is AppFailure && error.code == 'invalid_media'
          ? 400
          : 502;
      if (socket == null) {
        output.statusCode = status;
      } else if (!headersSent && !cancellation.isCancelled) {
        try {
          _writeHeaders(socket, status, const {'content-length': '0'});
          await socket.flush().timeout(fetcher.idleTimeout);
        } catch (_) {
          /* disconnected */
        }
      }
    } finally {
      cancellation.cancel();
      unlink?.call();
      await upstream?.close();
      await incoming?.cancel();
      if (socket != null) {
        entry?.sockets.remove(socket);
        socket.destroy();
      }
      if (slot) _streams--;
      if (socket == null) {
        try {
          await output.close();
        } catch (_) {
          /* disconnected */
        }
      }
    }
  }

  static void _writeHeaders(
    Socket socket,
    int status,
    Map<String, String> headers,
  ) {
    final reason = switch (status) {
      200 => 'OK',
      206 => 'Partial Content',
      416 => 'Range Not Satisfiable',
      400 => 'Bad Request',
      _ => 'Bad Gateway',
    };
    final block = StringBuffer(
      'HTTP/1.1 $status $reason\r\nconnection: close\r\ncache-control: private, no-store\r\n',
    );
    for (final entry in headers.entries) {
      if (entry.value.contains(RegExp(r'[\r\n\x00]'))) throw invalidMedia;
      block.write('${entry.key}: ${entry.value}\r\n');
    }
    block.write('\r\n');
    socket.add(latin1.encode(block.toString()));
  }

  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    for (final path in List.of(_entries.keys)) {
      _revoke(path);
    }
    await _events.cancel();
    final binding = _binding;
    if (binding != null) await (await binding).close(force: true);
  }

  /// Revokes an owner's captured epoch synchronously before the returned future
  /// completes. Useful for stopping media before an asynchronous logout barrier.
  Future<void> revoke(SessionFence fence) async {
    for (final entry in List.of(_entries.entries)) {
      if (entry.value.fence == fence) _revoke(entry.key);
    }
  }
}
