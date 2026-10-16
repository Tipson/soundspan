import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/downloads/download_models.dart';
import 'package:soundspan/playback/resolved_media.dart';

import '../../integration_test/support/whole_app_fixture.dart';
import 'download_fixture.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  HttpOverrides.global = null;
  for (final kind in YoutubeKind.values) {
    Future<DownloadHarness> harness() async {
      final h = await DownloadHarness.create();
      h.handler = (request) async {
        if (!const {
          'LOW',
          'MEDIUM',
          'HIGH',
          'LOSSLESS',
        }.contains(request.uri.queryParameters['quality']?.toUpperCase())) {
          request.response.statusCode = 400;
          request.response.write('Invalid quality');
          await request.response.close();
          return;
        }
        await h.send(request);
      };
      return h;
    }

    test(
      'original YouTube $kind transfers complete and ranged audio',
      () async {
        final h = await harness();
        addTearDown(h.close);
        final media = await h.runner
            .resolverForQuality('original')
            .resolve(
              YoutubeTrackRef('abcdefghijk', youtubeKind: kind),
              ResolvePurpose.playback,
              h.fence,
            );
        final response = await h.runner.fetcher.open(media, h.fence);
        addTearDown(response.close);
        expect(response.statusCode, 200);
        expect(
          await response.body.expand((chunk) => chunk).toList(),
          wavBytes(),
        );
        final range = await h.runner.fetcher.open(
          media,
          h.fence,
          range: ByteRange(start: 64),
        );
        addTearDown(range.close);
        expect(range.statusCode, 206);
        expect(
          await range.body.expand((chunk) => chunk).toList(),
          wavBytes().sublist(64),
        );
      },
    );

    test('original YouTube $kind downloads verified reusable bytes', () async {
      final h = await harness();
      addTearDown(h.close);
      final track = Track(
        ref: YoutubeTrackRef('abcdefghijk', youtubeKind: kind),
        title: 'Synthetic YouTube recording',
        artist: 'Synthetic Artist',
      );
      final job = await h.repo.enqueue(track, 'original', h.fence);
      expect(
        await h.runner.run(job.id, h.fence, job.generation),
        DownloadRunResult.ready,
      );
      final ready = (await h.repo.status(job.id, h.fence))!;
      expect(ready.state, DownloadState.ready);
      expect(ready.quality, 'original');
      final file = (await h.repo.openReady(track.ref, 'original', h.fence))!;
      expect(await file.readAsBytes(), wavBytes());
    });
  }

  test('whole app fixture rejects unsupported YouTube quality', () async {
    final fixture = await WholeAppFixture.open();
    addTearDown(fixture.close);
    final client = HttpClient(context: WholeAppFixture.trust());
    addTearDown(() => client.close(force: true));
    for (final provider in ['ytmusic', 'youtube']) {
      final request = await client.getUrl(
        fixture.origin.resolve(
          '/api/$provider/stream/abcdefghijk?quality=original',
        ),
      );
      request.headers.set('authorization', 'Bearer synthetic-ui-access');
      final response = await request.close();
      await response.drain<void>();
      expect(response.statusCode, 400, reason: '$provider quality contract');
      final supported = await client.getUrl(
        fixture.origin.resolve(
          '/api/$provider/stream/abcdefghijk?quality=HIGH',
        ),
      );
      supported.headers.set('authorization', 'Bearer synthetic-ui-access');
      final audio = await supported.close();
      await audio.drain<void>();
      expect(audio.statusCode, 200, reason: '$provider supports HIGH');
    }
    expect(fixture.unexpected, isEmpty);
  });
}
