import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/dart_api_transport.dart';
import 'package:soundspan/core/network/redirect_policy.dart';
import 'package:soundspan/playback/resolved_media.dart';
import 'package:soundspan/playback/track_audio_versions.dart';

import '../support/auth_fakes.dart';
import '../support/media_fixtures.dart';

void main() {
  const id = '19b2ace6-d28a-4d70-9cb5-44fce755a86e';
  test(
    'published audio pins an exact URL and cannot redirect to other audio',
    () async {
      final authority = await mediaAuthority(origin);
      addTearDown(authority.invalidate);
      final fence = authority.requireFence();
      final versions = TrackAudioVersions(
        transport: DartApiTransport(
          authority: authority,
          client: ScriptedJsonClient((request, _) async {
            expect(request.path, '/api/track-audio/yandex/42');
            return const ApiResponse(200, {'publishedId': id});
          }),
        ),
        authority: authority,
      );
      final media = (await versions.resolve(recordingRef, fence))!;
      expect(media.uri.path, '/api/track-audio/versions/$id/stream');
      expect(media.ref, recordingRef);
      RedirectPolicy.validate(media.uri, media);
      expect(
        () => RedirectPolicy.validate(origin.resolve(leasePath), media),
        throwsA(same(invalidMedia)),
      );
      expect(
        () => RedirectPolicy.validate(
          media.uri.replace(query: 'quality=high'),
          media,
        ),
        throwsA(same(invalidMedia)),
      );
    },
  );

  test('absent versions, service failures and malformed responses leave the next lookup available', () async {
    final authority = await mediaAuthority(origin);
    addTearDown(authority.invalidate);
    final outcomes = [
      const ApiResponse(200, {'publishedId': null}),
      const ApiResponse(503, {}),
      const ApiResponse(200, {'publishedId': '/api/other/stream'}),
      const ApiResponse(200, {'publishedId': id}),
    ];
    final versions = TrackAudioVersions(
      transport: DartApiTransport(
        authority: authority,
        client: ScriptedJsonClient((request, _) async {
          expect(request.path, '/api/track-audio/library/track-1');
          return outcomes.removeAt(0);
        }),
      ),
      authority: authority,
    );
    for (var attempt = 0; attempt < 3; attempt++) {
      expect(
        await versions.resolve(
          const LibraryTrackRef('track-1'),
          authority.requireFence(),
        ),
        isNull,
      );
    }
    expect(
      (await versions.resolve(
        const LibraryTrackRef('track-1'),
        authority.requireFence(),
      ))?.publishedAudioVersionId,
      id,
    );
  });

  test(
    'older server 404 skips optional requests across track changes',
    () async {
      final authority = await mediaAuthority(origin);
      addTearDown(authority.invalidate);
      var requests = 0;
      var elapsed = Duration.zero;
      final versions = TrackAudioVersions(
        authority: authority,
        elapsed: () => elapsed,
        transport: DartApiTransport(
          authority: authority,
          client: ScriptedJsonClient((_, _) async {
            requests++;
            return requests == 1
                ? const ApiResponse(404, {})
                : const ApiResponse(200, {'publishedId': id});
          }),
        ),
      );
      final fence = authority.requireFence();
      expect(
        await versions.resolve(const LibraryTrackRef('track-1'), fence),
        isNull,
      );
      expect(await versions.resolve(recordingRef, fence), isNull);
      expect(
        await versions.resolve(const YoutubeTrackRef('abcdefghijk'), fence),
        isNull,
      );
      expect(requests, 1);
      elapsed = const Duration(minutes: 1);
      expect(
        (await versions.resolve(recordingRef, fence))?.publishedAudioVersionId,
        id,
      );
      expect(requests, 2);
    },
  );
}
