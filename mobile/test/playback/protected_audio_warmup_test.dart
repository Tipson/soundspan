import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/dart_api_transport.dart';
import 'package:soundspan/downloads/protected_media_fetcher.dart';
import 'package:soundspan/playback/playback_resolver.dart';
import 'package:soundspan/playback/protected_audio_warmup.dart';
import 'package:soundspan/playback/resolved_media.dart';

import '../support/fake_tls_server.dart';
import '../support/media_fixtures.dart';
import '../support/wave_reporting_fixtures.dart';

void main() {
  test('cancel aborts a pending native resolver POST and leaves another request usable', () async {
    final started = Completer<void>();
    var resolves = 0;
    final server = await FakeTlsServer.start((r) async {
      await r.drain<void>();
      r.response.headers.contentType = ContentType.json;
      if (r.uri.path == '/api/music-sources/resolve') {
        resolves++;
        r.response.write('{');
        await r.response.flush();
        started.complete();
      } else {
        r.response.write('{}');
        await r.response.close();
      }
    });
    final authority = await mediaAuthority(server.origin);
    final client = DartJsonHttpClient(securityContext: server.clientContext);
    final transport = DartApiTransport(client: client, authority: authority);
    final warmup = ProtectedAudioWarmup(
      resolver: PlaybackResolver(transport: transport, authority: authority),
      fetcher: ProtectedMediaFetcher(
        authority: authority,
        securityContext: server.clientContext,
      ),
      requireNetwork: () {},
    );
    final cancellation = MediaCancellation();
    Object? failure;
    var completed = false;
    final pending = warmup
        .warm(recordingRef, authority.requireFence(), cancellation)
        .then<void>(
          (_) {
            completed = true;
          },
          onError: (Object error) {
            completed = true;
            failure = error;
          },
        );
    addTearDown(() async {
      await client.close();
      await pending;
      await server.close();
    });
    await started.future.timeout(const Duration(seconds: 5));
    cancellation.cancel();
    await Future<void>.delayed(const Duration(milliseconds: 150));
    expect(
      completed,
      true,
      reason: 'cancel must release JSON I/O without waiting its 30s deadline',
    );
    expect(
      failure,
      isA<AppFailure>().having((e) => e.code, 'code', 'media_cancelled'),
    );
    final response = await transport.send(
      ApiRequest(
        origin: server.origin,
        method: ApiMethod.get,
        path: '/api/auth/config',
        authenticated: false,
      ),
    );
    expect(response.statusCode, 200);
    expect(resolves, 1);
  });
  for (final ignoresRange in [false, true]) {
    test(
      'warms a bounded audio prefix without a playback session; ignored range=$ignoresRange',
      () async {
        var reads = 0;
        final server = await FakeTlsServer.start((request) async {
          reads++;
          expect(request.uri.path, '/api/ytmusic/stream/warmup001aa');
          expect(request.uri.queryParameters['purpose'], 'preload');
          expect(
            request.uri.queryParameters.containsKey('playbackSession'),
            false,
          );
          expect(request.headers.value('range'), 'bytes=0-65535');
          expect(request.headers.value('authorization'), 'Bearer initial');
          request.response.headers.contentType = ContentType('audio', 'mpeg');
          final total = ignoresRange ? 262144 : 65536;
          request.response.contentLength = total;
          if (!ignoresRange) {
            request.response.statusCode = 206;
            request.response.headers.set(
              'content-range',
              'bytes 0-65535/262144',
            );
          }
          request.response.add([
            0x49,
            0x44,
            0x33,
            ...List.filled(total - 3, 1),
          ]);
          await request.response.close();
        });
        addTearDown(server.close);
        final authority = await mediaAuthority(server.origin);
        final warmup = ProtectedAudioWarmup(
          resolver: PlaybackResolver(
            authority: authority,
            transport: ControlledTransport(),
            quality: 'original',
          ),
          fetcher: ProtectedMediaFetcher(
            authority: authority,
            securityContext: server.clientContext,
          ),
          requireNetwork: () {},
        );
        await warmup.warm(
          const YoutubeTrackRef('warmup001aa'),
          authority.requireFence(),
          MediaCancellation(),
        );
        expect(reads, 1);
      },
    );
  }
  test('cancelled warmup never sends media traffic', () async {
    final authority = await mediaAuthority(
      Uri.parse('https://no-network.invalid'),
    );
    final warmup = ProtectedAudioWarmup(
      resolver: PlaybackResolver(
        authority: authority,
        transport: ControlledTransport(),
      ),
      fetcher: ProtectedMediaFetcher(authority: authority),
      requireNetwork: () {},
    );
    await expectLater(
      warmup.warm(
        const YoutubeTrackRef('warmup001aa'),
        authority.requireFence(),
        MediaCancellation()..cancel(),
      ),
      throwsA(mediaCancelled),
    );
  });
}
