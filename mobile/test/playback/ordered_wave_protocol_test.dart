import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/app/server_capabilities.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/dart_api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/features/recommendations/recommendation_repository.dart';
import 'package:soundspan/playback/wave_selection.dart';

import '../support/collection_fixtures.dart';
import '../support/fake_tls_server.dart';
import '../support/media_fixtures.dart' show mediaAuthority;
import '../support/wave_reporting_fixtures.dart';

Map<String, Object?> clone(Object value) =>
    (jsonDecode(jsonEncode(value)) as Map).cast<String, Object?>();
final fixture =
    (jsonDecode(File('../fixtures/ordered-wave-v1.json').readAsStringSync())
            as Map)['cases']
        as List;
Map<String, Object?> firstOrdered() =>
    clone((fixture.first as Map)['orderedWave']);

void main() {
  for (final raw in fixture) {
    final item = raw as Map;
    test(
      'shared ordered fixture ${item['name']} retains exact server order',
      () {
        final page = OrderedWavePage.decode(item['orderedWave']);
        expect(
          page.tracks.map((t) => (t.ref as YoutubeTrackRef).videoId),
          item['expectedIds'],
        );
        expect(
          page.references.map((r) => r.position),
          List.generate(page.tracks.length, (i) => page.startPosition + i),
        );
        expect(
          page.tail.map((r) => r.toJson()),
          (item['orderedWave'] as Map)['tail'],
        );
      },
    );
  }

  for (final label in [
    'version',
    'uuid',
    'cursor',
    'position',
    'tail-reorder',
    'tail-artist',
    'tail-mismatch',
    'extra',
  ]) {
    test('malformed present ordered Wave fails closed: $label', () {
      final raw = firstOrdered();
      if (label == 'version') raw['version'] = 2;
      if (label == 'uuid') raw['sequenceId'] = 'not-uuid';
      if (label == 'cursor') raw['nextCursor'] = 'x' * 1025;
      if (label == 'position') (raw['items'] as List)[1]['position'] = 88;
      if (label == 'tail-reorder') {
        raw['tail'] = (raw['tail'] as List).reversed.toList();
      }
      if (label == 'tail-artist') {
        (raw['tail'] as List)[0]['artistKey'] = 'forged';
      }
      if (label == 'tail-mismatch') {
        (raw['tail'] as List).last['id'] = 'ZZZZZZZZZZ1';
      }
      if (label == 'extra') raw['artistNames'] = ['forged'];
      expect(() => OrderedWavePage.decode(raw), throwsA(isA<AppFailure>()));
    });
  }

  test('repository opts in and consumes ordered items without shelf or mode remapping', () async {
    final transport = ControlledTransport()
      ..respond = (_) async => ApiResponse(200, {
        'orderedWave': firstOrdered(),
        'generationId': 'served-generation',
        'shelves': {'discovery': [], 'quickPicks': [], 'listenAgain': []},
        'nextCursor': 7,
      });
    final repo = RecommendationRepository(
      transport: transport,
      orderedWaveCapability: (_, _) async => true,
    );
    final page = await repo.wave(
      const WaveSelection(mode: WaveMode.familiar),
      collectionFence,
      sessionId: 'wave',
    );
    expect(transport.requests.single.query['waveSequenceVersion'], '1');
    expect(
      page.tracks.map((t) => (t.ref as YoutubeTrackRef).videoId),
      (fixture.first as Map)['expectedIds'],
    );
    expect(page.orderedWave, isNotNull);
  });

  test('repository echoes opaque cursor and complete exact tail without numeric cursor', () async {
    final previous = OrderedWavePage.decode(firstOrdered());
    final transport = ControlledTransport()
      ..respond = (_) async => ApiResponse(200, {
        'orderedWave': {
          ...firstOrdered(),
          'startPosition': 6,
          'items': [],
          'tail': previous.tail.map((r) => r.toJson()).toList(),
        },
        'generationId': 'served-next',
      });
    final repo = RecommendationRepository(
      transport: transport,
      orderedWaveCapability: (_, _) async => true,
    );
    await repo.wave(
      const WaveSelection(),
      collectionFence,
      sessionId: 'wave',
      cursor: 999,
      continuation: previous,
    );
    final query = transport.requests.single.query;
    expect(query['waveSequenceCursor'], previous.nextCursor);
    expect(
      jsonDecode(query['waveSequenceTail']!),
      previous.tail.map((r) => r.toJson()).toList(),
    );
    expect(query, isNot(contains('cursor')));
  });

  test(
    'missing ordered payload is accepted only after explicit capability off',
    () async {
      final transport = ControlledTransport()
        ..respond = (_) async => ApiResponse(200, waveFeed(['legacy']));
      final off = RecommendationRepository(
        transport: transport,
        orderedWaveCapability: (_, _) async => false,
      );
      expect(
        (await off.wave(
          const WaveSelection(),
          collectionFence,
          sessionId: 'wave',
        )).tracks.single.ref,
        const YoutubeTrackRef('legacy'),
      );
      final on = RecommendationRepository(
        transport: transport,
        orderedWaveCapability: (_, _) async => true,
      );
      await expectLater(
        on.wave(const WaveSelection(), collectionFence, sessionId: 'wave'),
        throwsA(isA<AppFailure>()),
      );
      final unknown = RecommendationRepository(
        transport: transport,
        orderedWaveCapability: (_, _) async => null,
      );
      final before = transport.requests.length;
      await expectLater(
        unknown.wave(const WaveSelection(), collectionFence, sessionId: 'wave'),
        throwsA(isA<AppFailure>()),
      );
      expect(transport.requests.length, before);
    },
  );

  test(
    'ordered Wave capability is exact, online-only and owner-fenced',
    () async {
      final authority = CollectionAuthority();
      var elapsed = Duration.zero;
      final features = {
        'discovery': true,
        'autoPlaylists': true,
        'federation': false,
        'orderedWave': {'version': 1},
      };
      final transport = CollectionTransport(
        (_, _) => ApiResponse(200, features),
      );
      final caps = ServerCapabilitiesRepository(
        transport: transport,
        store: ReportingStore(),
        authority: authority,
        fence: collectionFence,
        policy: const NetworkPolicy.online(),
        elapsed: () => elapsed,
      );
      addTearDown(caps.close);
      addTearDown(authority.updates.close);
      expect(caps.orderedWaveEnabled, isNull);
      await caps.refresh();
      expect(caps.orderedWaveEnabled, isTrue);
      elapsed = const Duration(seconds: 301);
      expect(caps.orderedWaveEnabled, isNull);
      await caps.refresh();
      authority.switchOwner();
      expect(caps.orderedWaveEnabled, isNull);
      expect(
        () => ServerCapabilities.decode({...features, 'orderedWave': null}),
        throwsFormatException,
      );
      expect(
        () => ServerCapabilities.decode({
          ...features,
          'orderedWave': {'version': 2},
        }),
        throwsFormatException,
      );
    },
  );

  test('all five exact source identities survive DTO decoding, including retired Tidal', () {
    final local = waveDto('ignored')
      ..addAll({
        'id': 'library-real',
        'source': 'library',
        'streamSource': 'library',
        'provider': {'youtubeVideoId': null, 'tidalTrackId': null},
      });
    final tidal = waveDto('ignored')
      ..addAll({
        'id': 'tidal:42',
        'source': 'tidal',
        'streamSource': 'tidal',
        'provider': {'youtubeVideoId': null, 'tidalTrackId': 42},
      });
    Map<String, Object?> native(String source, String id) => {
      ...waveDto('ignored'),
      'id': '$source:$id',
      'source': source,
      'streamSource': source,
      'title': 'Song',
      'duration': 180,
      'artist': {'id': null, 'name': 'Artist'},
      'provider': {
        'source': source,
        'providerTrackId': id,
        'youtubeVideoId': null,
        'tidalTrackId': null,
      },
      'musicSourceRecording': {
        'provider': source,
        'id': id,
        'title': 'Song',
        'artists': ['Artist'],
        'duration': 180,
        'contentVersion': 'unknown',
        'preview': false,
      },
    };
    final tracks = [
      local,
      waveDto('YYYYYYYYYY1'),
      tidal,
      native('vk', '-42_13'),
      native('yandex', '123'),
    ];
    final raw = firstOrdered()
      ..addAll({
        'items': [
          for (final (i, track) in tracks.indexed)
            {'position': i, 'track': track},
        ],
        'tail': [
          {'source': 'vk', 'id': '-42_13', 'position': 3},
          {'source': 'yandex', 'id': '123', 'position': 4},
        ],
      });
    final before = jsonEncode(raw);
    final decoded = OrderedWavePage.decode(raw);
    expect(decoded.references.map((r) => '${r.source}:${r.id}'), [
      'library:library-real',
      'youtube:YYYYYYYYYY1',
      'tidal:42',
      'vk:-42_13',
      'yandex:123',
    ]);
    expect(decoded.tracks.length, 5);
    expect(decoded.tracks[2].ref, isA<UnavailableTrackRef>());
    expect(jsonEncode(raw), before);
  });

  test('malformed present v1 never falls through to legacy even when capability is off', () async {
    final transport = ControlledTransport()
      ..respond = (_) async => ApiResponse(200, {
        ...waveFeed(['legacy']),
        'orderedWave': null,
      });
    final repo = RecommendationRepository(
      transport: transport,
      orderedWaveCapability: (_, _) async => false,
    );
    await expectLater(
      repo.wave(const WaveSelection(), collectionFence, sessionId: 'wave'),
      throwsA(isA<AppFailure>()),
    );
    expect(transport.requests.length, 1);
  });

  test('ordered library identity rejects conflicting provider metadata while legacy stays intact', () async {
    final local = waveDto('ignored')
      ..addAll({
        'id': 'library-real',
        'source': 'library',
        'streamSource': 'library',
        'provider': {'youtubeVideoId': 'MMMMMMMMMM1', 'tidalTrackId': null},
      });
    final raw = firstOrdered()
      ..addAll({
        'items': [
          {'position': 0, 'track': local},
        ],
        'tail': [
          {'source': 'library', 'id': 'library-real', 'position': 0},
        ],
      });
    expect(() => OrderedWavePage.decode(raw), throwsA(isA<AppFailure>()));
    final transport = ControlledTransport()
      ..respond = (_) async => ApiResponse(200, {
        ...waveFeed([]),
        'shelves': {
          'discovery': [local],
          'quickPicks': [],
          'listenAgain': [],
        },
      });
    final legacy = RecommendationRepository(transport: transport);
    expect(
      (await legacy.wave(
        const WaveSelection(),
        collectionFence,
        sessionId: 'legacy',
      )).tracks.single.ref,
      const LibraryTrackRef('library-real'),
    );
  });

  for (final known in [true, false]) {
    test(
      'real TLS bridge classifies only exact ordered Wave409 code: $known',
      () async {
        final server = await FakeTlsServer.start((request) async {
          request.response.statusCode = 409;
          request.response.headers.contentType = ContentType.json;
          request.response.write(
            jsonEncode({
              'code': known ? 'WAVE_SEQUENCE_RESET' : 'OTHER_CONFLICT',
              'cursor': 'private_cursor',
            }),
          );
          await request.response.close();
        });
        addTearDown(server.close);
        final authority = await mediaAuthority(server.origin);
        final client = DartJsonHttpClient(
          securityContext: server.clientContext,
        );
        addTearDown(client.close);
        final transport = DartApiTransport(
          client: client,
          authority: authority,
        );
        await expectLater(
          transport.send(
            ApiRequest(
              origin: server.origin,
              method: ApiMethod.get,
              path: '/api/personalized/home',
              query: {'surface': 'wave', 'waveSequenceVersion': '1'},
            ),
            fence: authority.requireFence(),
          ),
          throwsA(
            isA<AppFailure>()
                .having(
                  (e) => e.code,
                  'code',
                  known ? 'wave_sequence_reset' : 'http_error',
                )
                .having(
                  (e) => e.message.contains('private_cursor'),
                  'no body leak',
                  false,
                ),
          ),
        );
      },
    );
  }
}
