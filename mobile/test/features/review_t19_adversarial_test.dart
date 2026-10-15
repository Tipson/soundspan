import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/features/history/history_controller.dart';
import 'package:soundspan/features/history/history_repository.dart';
import 'package:soundspan/features/lyrics/lyrics_repository.dart';
import 'package:soundspan/features/radio/radio_controller.dart';
import 'package:soundspan/features/radio/radio_repository.dart';
import 'package:soundspan/playback/playback_controller.dart';

import '../support/collection_fixtures.dart';

Map<String, Object?> stationPage({String? cursor}) => {
  'id': 'station',
  'name': 'Radio',
  'totalItemCount': 2,
  'mergedItems': [
    {
      'id': 'item',
      'sort': 0,
      'type': 'track',
      'track': {
        ...likedDto(1),
        'album': {
          'id': 'album',
          'title': 'Album',
          'artist': {'id': 'artist', 'name': 'Artist'},
        },
      },
    },
  ],
  'pagination': {'hasMore': cursor != null, 'nextCursor': cursor},
};

void main() {
  late CollectionAuthority authority;
  late CollectionPlayback playback;
  setUp(() {
    authority = CollectionAuthority();
    playback = CollectionPlayback(QueueSnapshot(fence: collectionFence));
  });
  tearDown(() async => authority.updates.close());
  RadioController radio(CollectionTransport transport) {
    final controller = RadioController(
      repository: RadioRepository(
        transport: transport,
        authority: authority,
        fence: collectionFence,
        networkPolicy: const NetworkPolicy.online(),
      ),
      playback: playback,
    );
    addTearDown(controller.dispose);
    return controller;
  }

  test('adversarial: malformed provider timestamp does not throw outside repository guard', () async {
    final repo = LyricsRepository(
      transport: CollectionTransport(
        (r, f) => const ApiResponse(200, {
          'plainLyrics': 'fallback',
          'syncedLyrics':
              '[999999999999999999999999:00.00]bad\n[00:02.50]valid',
          'synced': true,
          'source': 'lrclib',
        }),
      ),
      authority: authority,
      fence: collectionFence,
      networkPolicy: const NetworkPolicy.online(),
    );
    addTearDown(repo.dispose);
    final document = await repo.get(collectionTrack(1));
    expect(document.lines.map((line) => line.text), ['valid']);
    expect(document.lines.single.position, const Duration(milliseconds: 2500));
  });

  test('adversarial: parseable giant timestamp cannot wrap into a negative lyric position', () {
    const document = LyricsDocument(
      synced: '[9223372036854775807:01]bad\n[00:02]valid',
    );
    expect(
      document.lines.every((line) => line.position >= Duration.zero),
      isTrue,
    );
    expect(document.lines.map((line) => line.text), ['valid']);
  });

  test('adversarial: old acknowledged GET rejection cannot poison replacement seed', () async {
    final pendingGet = Completer<ApiResponse>();
    final startedGet = Completer<void>();
    final transport = CollectionTransport((r, f) {
      if (r.method == ApiMethod.post) {
        return const ApiResponse(200, {'playlistId': 'station'});
      }
      if (r.path == '/api/playlists/station') {
        startedGet.complete();
        return pendingGet.future;
      }
      return ApiResponse(200, {
        'tracks': [likedDto(2)],
        'generationId': 'replacement',
        'nextCursor': null,
        'degradedSources': [],
      });
    });
    final c = radio(transport);
    c.select(const RadioSeed.genre('rock'));
    final first = c.generate();
    await startedGet.future;
    c.select(RadioSeed.track(collectionTrack(2)));
    await c.generate();
    pendingGet.complete(const ApiResponse(403, {}));
    await first;
    expect(c.uncertain, isFalse);
    expect(c.station!.generationId, 'replacement');
    expect(c.canReconcile, isFalse);
    expect(playback.commands, isEmpty);
  });

  test('adversarial: repeated opaque readback cursor is bounded and blocks POST replay', () async {
    final transport = CollectionTransport(
      (r, f) => r.method == ApiMethod.post
          ? const ApiResponse(200, {'playlistId': 'station'})
          : ApiResponse(200, stationPage(cursor: 'same-cursor')),
    );
    final c = radio(transport);
    c.select(const RadioSeed.genre('rock'));
    await c.generate();
    await c.generate();
    expect(c.uncertain, isTrue);
    expect(c.canReconcile, isTrue);
    expect(
      transport.requests.where((r) => r.method == ApiMethod.post).length,
      1,
    );
    expect(
      transport.requests.where((r) => r.method == ApiMethod.get).length,
      2,
    );
    expect(c.station, isNull);
  });

  test('adversarial: accepted history DELETE retired by owner change cannot read or publish', () async {
    final response = Completer<ApiResponse>();
    final started = Completer<void>();
    final transport = CollectionTransport((r, f) {
      expect(r.method, ApiMethod.delete);
      started.complete();
      return response.future;
    });
    final c = HistoryController(
      repository: HistoryRepository(
        transport: transport,
        authority: authority,
        fence: collectionFence,
        networkPolicy: const NetworkPolicy.online(),
      ),
      playback: playback,
    );
    addTearDown(c.dispose);
    final clear = c.clear(HistoryRange.all, confirmationRevision: c.revision);
    await started.future;
    authority.switchOwner();
    response.complete(
      const ApiResponse(200, {
        'success': true,
        'range': 'all',
        'deletedCount': 12,
      }),
    );
    await clear;
    expect(transport.requests.length, 1);
    expect(c.page, isNull);
    expect(c.summary, isNull);
    expect(c.message, isNull);
    expect(c.busy, isFalse);
    expect(playback.commands, isEmpty);
  });
}
