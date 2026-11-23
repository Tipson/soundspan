import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/dart_api_transport.dart';
import 'package:soundspan/playback/playback_resolver.dart';
import 'package:soundspan/playback/resolved_media.dart';

import '../support/auth_fakes.dart';
import '../support/media_fixtures.dart';

void main() {
  test(
    'native resolve posts exact strict recording body and validates lease',
    () async {
      final authority = await mediaAuthority(origin);
      final client = ScriptedJsonClient((request, token) async {
        expect(request.path, '/api/music-sources/resolve');
        expect(request.method, ApiMethod.post);
        expect(request.body, {
          'provider': 'yandex',
          'providerTrackId': '42',
          'title': 'Exact clean recording',
          'artists': ['Artist'],
          'duration': 180.0,
          'contentVersion': 'clean',
        });
        return const ApiResponse(200, {
          'playback': {
            'provider': 'yandex',
            'leaseId': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            'streamPath': leasePath,
          },
        });
      });
      final result =
          await PlaybackResolver(
            transport: DartApiTransport(client: client, authority: authority),
            authority: authority,
            quality: 'original',
          ).resolve(
            recordingRef,
            ResolvePurpose.playback,
            authority.requireFence(),
          );
      expect(result.uri, origin.resolve(leasePath));
      expect(result.renewableUri, origin.resolve(recordingPath));
      expect(result.ref, recordingRef);
    },
  );
  for (final bad in [
    null,
    {
      'provider': 'vk',
      'leaseId': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'streamPath': leasePath,
    },
    {
      'provider': 'yandex',
      'leaseId': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'streamPath': 'https://evil.example$leasePath',
    },
  ]) {
    test('reject malformed/unavailable native resolution $bad', () async {
      final authority = await mediaAuthority(origin);
      final resolver = PlaybackResolver(
        authority: authority,
        transport: DartApiTransport(
          authority: authority,
          client: ScriptedJsonClient(
            (_, _) async => ApiResponse(200, {'playback': bad}),
          ),
        ),
      );
      await expectLater(
        resolver.resolve(
          recordingRef,
          ResolvePurpose.playback,
          authority.requireFence(),
        ),
        throwsA(isA<AppFailure>()),
      );
    });
  }
  test(
    'provider-specific paths and purpose do not invent query fields',
    () async {
      final authority = await mediaAuthority(origin);
      final resolver = PlaybackResolver(
        authority: authority,
        transport: DartApiTransport(
          authority: authority,
          client: ScriptedJsonClient(
            (_, _) async => throw StateError('No JSON expected'),
          ),
        ),
      );
      final fence = authority.requireFence();
      final local = await resolver.resolve(
        const LibraryTrackRef('db-id'),
        ResolvePurpose.playback,
        fence,
      );
      expect(
        local.uri.toString(),
        'https://music.example/api/library/tracks/db-id/stream',
      );
      final yt = await resolver.resolve(
        const YoutubeTrackRef('abcdefghijk'),
        ResolvePurpose.playback,
        fence,
      );
      expect(yt.uri.path, '/api/ytmusic/stream/abcdefghijk');
      expect(yt.uri.queryParameters.keys, ['playbackSession']);
      final preload = await resolver.resolve(
        const YoutubeTrackRef('abcdefghijk'),
        ResolvePurpose.preload,
        fence,
      );
      expect(preload.uri.queryParameters, {'purpose': 'preload'});
      final regular = await resolver.resolve(
        const YoutubeTrackRef('abcdefghijk', youtubeKind: YoutubeKind.regular),
        ResolvePurpose.download,
        fence,
      );
      expect(regular.uri.path, '/api/youtube/stream/abcdefghijk');
      expect(regular.uri.hasQuery, false);
    },
  );
  for (final kind in YoutubeKind.values) {
    for (final purpose in ResolvePurpose.values) {
      test('YouTube $kind $purpose maps original to supported HIGH', () async {
        final authority = await mediaAuthority(origin);
        addTearDown(authority.invalidate);
        final resolver = PlaybackResolver(
          authority: authority,
          transport: DartApiTransport(
            authority: authority,
            client: ScriptedJsonClient(
              (_, _) async => throw StateError('No JSON expected'),
            ),
          ),
          quality: 'original',
        );
        final media = await resolver.resolve(
          YoutubeTrackRef('abcdefghijk', youtubeKind: kind),
          purpose,
          authority.requireFence(),
        );
        expect(media.uri.queryParameters['quality'], 'HIGH');
      });
    }
    for (final quality in [
      'low',
      'medium',
      'high',
      'lossless',
      'LOW',
      'MEDIUM',
      'HIGH',
      'LOSSLESS',
    ]) {
      test('YouTube $kind preserves selected $quality quality', () async {
        final authority = await mediaAuthority(origin);
        addTearDown(authority.invalidate);
        final resolver = PlaybackResolver(
          authority: authority,
          transport: DartApiTransport(
            authority: authority,
            client: ScriptedJsonClient(
              (_, _) async => throw StateError('No JSON expected'),
            ),
          ),
          quality: quality,
        );
        final media = await resolver.resolve(
          YoutubeTrackRef('abcdefghijk', youtubeKind: kind),
          ResolvePurpose.playback,
          authority.requireFence(),
        );
        expect(media.uri.queryParameters['quality'], quality);
      });
    }
  }
  test('library original retains original file representation', () async {
    final authority = await mediaAuthority(origin);
    addTearDown(authority.invalidate);
    final resolver = PlaybackResolver(
      authority: authority,
      transport: DartApiTransport(
        authority: authority,
        client: ScriptedJsonClient(
          (_, _) async => throw StateError('No JSON expected'),
        ),
      ),
      quality: 'original',
    );
    final media = await resolver.resolve(
      const LibraryTrackRef('db-id'),
      ResolvePurpose.playback,
      authority.requireFence(),
    );
    expect(media.uri.queryParameters, {'quality': 'original'});
  });
}
