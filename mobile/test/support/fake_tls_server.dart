import 'dart:async';
import 'dart:io';

/// Loopback-only test CA/key. This is not a production certificate or secret.
final class FakeTlsServer {
  FakeTlsServer._(this.server, this.clientContext);
  final HttpServer server;
  final SecurityContext clientContext;
  Uri get origin => Uri(scheme: 'https', host: 'localhost', port: server.port);

  static Future<FakeTlsServer> start(
    Future<void> Function(HttpRequest) handler,
  ) async {
    final certificate = File('test/support/localhost-test-cert.pem')
        .readAsBytesSync();
    final key = File('test/support/localhost-test-key.pem').readAsBytesSync();
    final serverContext = SecurityContext()
      ..useCertificateChainBytes(certificate)
      ..usePrivateKeyBytes(key);
    final clientContext = SecurityContext(withTrustedRoots: false)
      ..setTrustedCertificatesBytes(certificate);
    final server = await HttpServer.bindSecure(
      InternetAddress.loopbackIPv4,
      0,
      serverContext,
    );
    server.listen((request) {
      unawaited(handler(request));
    });
    return FakeTlsServer._(server, clientContext);
  }

  Future<void> close() => server.close(force: true);
}
