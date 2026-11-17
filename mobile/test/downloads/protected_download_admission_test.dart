import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/downloads/download_network_access.dart';
import 'package:soundspan/playback/resolved_media.dart';

import 'download_fixture.dart';

void main() {
  late DownloadHarness h;
  setUp(() async => h = await DownloadHarness.create());
  tearDown(() async => h.close());

  test('download policy is checked before any protected audio HTTP', () async {
    final media = await h.runner
        .resolverForQuality('original')
        .resolve(DownloadHarness.track.ref, ResolvePurpose.download, h.fence);
    await expectLater(
      h.runner.fetcher.open(
        media,
        h.fence,
        admitRequest: () async => throw DownloadNetworkAccess.restricted,
      ),
      throwsA(DownloadNetworkAccess.restricted),
    );
    expect(h.requests, isEmpty);
  });

  test('route restriction after 401 prevents auth replay and another audio request', () async {
    var allowed = true;
    h.handler = (request) async {
      allowed = false;
      request.response.statusCode = HttpStatus.unauthorized;
      await request.response.close();
    };
    final media = await h.runner
        .resolverForQuality('original')
        .resolve(DownloadHarness.track.ref, ResolvePurpose.download, h.fence);
    await expectLater(
      h.runner.fetcher.open(
        media,
        h.fence,
        admitRequest: () async {
          if (!allowed) throw DownloadNetworkAccess.restricted;
        },
      ),
      throwsA(DownloadNetworkAccess.restricted),
    );
    expect(h.requests, hasLength(1));
  });
}
