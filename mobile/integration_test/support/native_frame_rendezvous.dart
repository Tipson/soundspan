import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// Loopback-only coordination with the host driver. No account data or media.
/// A checkpoint waits until ADB has captured the full framebuffer.
class NativeFrameRendezvous {
  late final HttpServer _server;
  Map<String, Object?>? _pending;
  Completer<void>? _ack;
  var _sequence = 0;
  static Future<NativeFrameRendezvous> open() async {
    final value = NativeFrameRendezvous();
    value._server = await HttpServer.bind(InternetAddress.loopbackIPv4, 18766);
    value._server.listen((request) async {
      request.response.headers.contentType = ContentType.json;
      if (request.method == 'POST' &&
          request.uri.path == '/ack' &&
          request.uri.queryParameters['id'] == '${value._pending?['id']}') {
        value._pending = null;
        value._ack?.complete();
        value._ack = null;
      }
      request.response.write(jsonEncode(value._pending ?? {}));
      await request.response.close();
    });
    return value;
  }

  Future<void> command(String kind, Map<String, Object?> data) async {
    if (_pending != null) throw StateError('Concurrent native frame command');
    final ack = Completer<void>();
    _ack = ack;
    _pending = {'id': ++_sequence, 'kind': kind, ...data};
    await ack.future.timeout(const Duration(seconds: 60));
  }

  Future<void> frame(String name, Map<String, Object?> metrics) =>
      command('frame', {'name': name, 'metrics': metrics});
  Future<void> device({
    int width = 390,
    int height = 844,
    double scale = 1,
    bool reduced = false,
  }) => command('device', {
    'width': width,
    'height': height,
    'scale': scale,
    'reduced': reduced,
  });
  Future<void> back() => command('back', {});
  Future<void> close() => _server.close(force: true);
}
