import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/design_system/design_system.dart';
import 'package:soundspan/features/home/home_controller.dart';
import 'package:soundspan/features/home/home_models.dart';
import 'package:soundspan/features/home/home_repository.dart';
import 'package:soundspan/features/home/home_screen.dart';

import '../support/collection_fixtures.dart';
import '../support/wave_reporting_fixtures.dart' show waveDto, waveFeed;

final _key = 'daypart-v1:${'a' * 64}';
Map<String, Object?> _snapshot({int count = 40}) => {
  'checkedAt': '2026-11-17T10:20:00Z',
  'compositionKey': _key,
  'refreshAfter': '2026-11-17T10:30:00Z',
  'requestedCount': 40,
  'snapshotCount': count,
  'availableCount': count,
  'reasons': [if (count < 40) 'pool_limited'],
};

Future<HomeFeed> _load(Object? authoritative, {bool present = true}) async {
  final authority = CollectionAuthority();
  try {
    return await HomeRepository(
      authority: authority,
      fence: collectionFence,
      transport: CollectionTransport(
        (_, _) => ApiResponse(200, {
          ...waveFeed(['legacy']),
          if (present) 'timeOfDayMix': authoritative,
        }),
      ),
    ).load(
      HomeRequest(
        localHour: 8,
        timezoneOffsetMinutes: 180,
        autoPlaylists: false,
        discovery: false,
      ),
      sections: {'daypart'},
    );
  } finally {
    await authority.updates.close();
  }
}

void main() {
  test(
    'authoritative daypart preserves all40 occurrences in server order',
    () async {
      final feed = await _load({
        'tracks': [
          waveDto('server-2'),
          waveDto('server-1'),
          waveDto('server-2'),
          for (var i = 0; i < 37; i++) waveDto('tail-$i'),
        ],
        'snapshot': _snapshot(),
      });
      final mix = feed.mixes.single;
      expect(mix.kind, MusicMixKind.daypart);
      expect(mix.trackCount, 40);
      expect(mix.tracks.take(3).map((t) => t.ref.identityKey), [
        'yt:server-2',
        'yt:server-1',
        'yt:server-2',
      ]);
      expect(mix.tracks.last.ref.identityKey, 'yt:tail-36');
      expect(mix.snapshot?.availableCount, 40);
      expect(mix.snapshot?.generatedAt, isNull);
      expect(
        mix.snapshot?.labels,
        contains(matches(r'^Проверено в \d{2}:\d{2}$')),
      );
      expect(feed.failures, isEmpty);
    },
  );

  test(
    'authoritative empty daypart stays empty despite nonempty public shelves',
    () async {
      final feed = await _load({'tracks': [], 'snapshot': _snapshot(count: 0)});
      final mix = feed.mixes.single;
      expect(mix.tracks, isEmpty);
      expect(mix.trackCount, 0);
      expect(mix.playableCount, 0);
      expect(mix.snapshot?.labels, contains('Пока меньше подходящих треков'));
    },
  );

  test('older servers retain the daypart shelf fallback', () async {
    for (final present in [false, true]) {
      final feed = await _load(null, present: present);
      expect(feed.mixes.single.tracks.single.ref.identityKey, 'yt:legacy');
      expect(feed.mixes.single.snapshot, isNull);
    }
  });

  test('oversized optional daypart uses the bounded legacy fallback', () async {
    final feed = await _load({
      'tracks': [for (var i = 0; i < 41; i++) waveDto('extra-$i')],
      'snapshot': _snapshot(count: 41),
    });
    expect(feed.mixes.single.trackCount, 1);
    expect(feed.mixes.single.tracks.single.ref.identityKey, 'yt:legacy');
    expect(feed.mixes.single.snapshot, isNull);
    expect(feed.failures, isEmpty);
  });

  test(
    'malformed optional daypart shape retains the legacy fallback',
    () async {
      for (final projection in <Object?>[
        'broken',
        [],
        {},
        {'tracks': null},
        {'tracks': 'broken'},
        {'tracks': {}},
      ]) {
        final feed = await _load(projection);
        expect(feed.mixes, hasLength(1), reason: '$projection');
        expect(feed.mixes.single.tracks.single.ref.identityKey, 'yt:legacy');
        expect(feed.mixes.single.snapshot, isNull);
        expect(feed.failures, isEmpty);
      }
    },
  );

  testWidgets('Home hides empty daypart cards and diagnostic status rows', (
    tester,
  ) async {
    final authority = CollectionAuthority();
    final controller = HomeController(
      repository: HomeRepository(
        authority: authority,
        fence: collectionFence,
        transport: CollectionTransport(
          (request, _) => ApiResponse(
            200,
            request.path == '/api/personalized/daily-mixes'
                ? {'mixes': []}
                : {
                    ...waveFeed([]),
                    if (request.query['timeOfDay'] == '1')
                      'timeOfDayMix': {
                        'tracks': [],
                        'snapshot': _snapshot(count: 0),
                      },
                  },
          ),
        ),
      ),
      request: HomeRequest(
        localHour: 8,
        timezoneOffsetMinutes: 180,
        autoPlaylists: false,
        discovery: false,
      ),
    );
    var plays = 0;
    try {
      await controller.refresh();
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: HomeScreen(
            controller: controller,
            autoLoad: false,
            onOpenWave: () {},
            onOpenMix: (_) {},
            onPlay: (_) => plays++,
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(controller.state.feed.mixes.single.trackCount, 0);
      expect(find.text('Ваше утро'), findsNothing);
      expect(find.text('0 треков'), findsNothing);
      expect(find.text('Пока меньше подходящих треков'), findsNothing);
      expect(find.textContaining('Проверено в '), findsNothing);
      expect(plays, 0);
      expect(tester.takeException(), isNull);
    } finally {
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      await authority.updates.close();
    }
  });

  test('authoritative tracks retain the native identity guard', () async {
    final feed = await _load({
      'tracks': [
        {
          ...waveDto('poison'),
          'source': 'yandex',
          'streamSource': 'yandex',
          'musicSourceRecording': {
            'provider': 'yandex',
            'id': 'different-recording',
            'title': 'poison',
            'artists': ['Artist'],
            'duration': 180,
            'contentVersion': 'unknown',
            'preview': false,
          },
        },
      ],
      'snapshot': _snapshot(count: 1),
    });
    expect(feed.mixes, isEmpty);
    expect(feed.failures, contains('daypart'));
  });

  test(
    'malformed optional daypart metadata never discards authoritative tracks',
    () async {
      for (final snapshot in <Object?>[
        null,
        'broken',
        {..._snapshot(count: 2), 'checkedAt': '2026-02-30T01:30:00Z'},
        {..._snapshot(count: 2), 'checkedAt': '2026-11-17T10:20:00'},
        {..._snapshot(count: 2), 'compositionKey': 'daypart-v1:short'},
        {..._snapshot(count: 2), 'compositionKey': 'other:${'a' * 64}'},
        {..._snapshot(count: 2), 'compositionKey': 1},
        {..._snapshot(count: 2), 'compositionKey': 'daypart-v1:${'z' * 64}'},
      ]) {
        final feed = await _load({
          'tracks': [waveDto('kept'), waveDto('kept')],
          'snapshot': snapshot,
        });
        final mix = feed.mixes.single;
        expect(mix.tracks.map((t) => t.ref.identityKey), [
          'yt:kept',
          'yt:kept',
        ]);
        expect(mix.snapshot, isNull, reason: '$snapshot');
        expect(feed.failures, isEmpty);
      }
    },
  );

  test('checked time never becomes an invented composition date', () {
    final checked = MixSnapshot.tryParse(_snapshot(count: 2));
    expect(checked?.generatedAt, isNull);
    expect(checked?.checkedAt, DateTime.utc(2026, 11, 17, 10, 20));
    expect(checked?.compositionKey, _key);
    expect(checked?.labels, contains(matches(r'^Проверено в \d{2}:\d{2}$')));
    expect(
      checked?.labels.any((label) => label.startsWith('Составлен')),
      isFalse,
    );
    final dated = MixSnapshot.tryParse({
      ..._snapshot(count: 2),
      'generatedAt': '2026-11-17T01:30:00+03:00',
    });
    expect(dated?.labels, contains('Составлен 16 ноября 2026'));
    final rechecked = MixSnapshot.tryParse({
      ..._snapshot(count: 2),
      'checkedAt': '2026-11-17T10:25:00Z',
    });
    expect(rechecked?.compositionKey, checked?.compositionKey);
    expect(rechecked?.checkedAt, DateTime.utc(2026, 11, 17, 10, 25));
    final undated = MixSnapshot.tryParse({..._snapshot()}..remove('checkedAt'));
    expect(undated?.labels, isEmpty);
  });

  test('invalid optional checked time or composition key invalidates only metadata', () {
    for (final field in ['checkedAt', 'compositionKey']) {
      expect(MixSnapshot.tryParse({..._snapshot(), field: 'invalid'}), isNull);
    }
  });
}
