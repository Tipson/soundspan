import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'download_test_tls.dart';
import 'synthetic_audio.dart';

/// Synthetic contracts served over verified localhost TLS. This is test data,
/// never a replacement transport, controller, vault, store or audio engine.
class WholeAppFixture {
  late final HttpServer server;
  final requests = <String, int>{};
  final unexpected = <String>[];
  final _flights = <Future<void>>{};
  late final List<int> audio;
  final artwork = <List<int>>[];
  final preferences = <String, String>{};
  Map<String, Object?> get importJob => {
    'id': 'import-complete',
    'userId': 't24-synthetic',
    'sourceType': 'youtube',
    'sourceId': 'synthetic-list',
    'normalizedSource': 'youtube:synthetic-list',
    'playlistName': 'Тестовый импорт · готово',
    'status': 'completed',
    'progress': 100,
    'summary': {
      'total': 40,
      'local': 40,
      'youtube': 0,
      'tidal': 0,
      'unresolved': 0,
    },
    'createdPlaylistId': 'p-evening',
    'resolutionProcessed': 40,
    'resolutionAttempt': 1,
    'estimatedRemainingSeconds': null,
    'error': null,
  };
  final settings = <String, Object?>{
    'displayName': 'Synthetic Listener',
    'hasProfilePicture': false,
    'loudnessMode': 'off',
    'shareOnlinePresence': false,
    'shareListeningStatus': false,
  };
  final playlists = <Map<String, Object?>>[
    {
      'id': 'p-evening',
      'name': 'Вечер без спешки',
      'isOwner': true,
      'isPublic': false,
      'isHidden': false,
      'trackCount': 40,
    },
    {
      'id': 'p-road',
      'name': 'Дорога к морю',
      'isOwner': true,
      'isPublic': false,
      'isHidden': false,
      'trackCount': 101,
    },
    {
      'id': 'p-friend',
      'name': 'Тихие города',
      'isOwner': false,
      'isPublic': true,
      'isHidden': false,
      'trackCount': 8,
    },
  ];
  final notifications = <Map<String, Object?>>[
    {
      'id': 'n-server',
      'type': 'download_complete',
      'title': 'Альбом готов на сервере',
      'message': '«После дождя» можно слушать. Для прослушивания без сети сохраните его на этот телефон.',
      'read': false,
      'cleared': false,
      'createdAt': '2026-10-15T08:10:00Z',
      'metadata': {'albumId': 'album-0'},
    },
    {
      'id': 'n-playlist',
      'type': 'playlist_ready',
      'title': 'Вечер без спешки',
      'message': 'В подборке 40 синтетических тестовых записей.',
      'read': false,
      'cleared': false,
      'createdAt': '2026-10-15T07:30:00Z',
      'metadata': {'playlistId': 'p-evening'},
    },
  ];
  Uri get origin => Uri.parse('https://localhost:${server.port}');
  static SecurityContext trust() =>
      SecurityContext(withTrustedRoots: false)
        ..setTrustedCertificatesBytes(utf8.encode(testCertificate));

  static Future<WholeAppFixture> open() async {
    final result = WholeAppFixture();
    result.audio = syntheticWav(duration: const Duration(seconds: 90));
    for (var i = 0; i < 6; i++) {
      result.artwork.add(await _cover(i));
    }
    result.server = await HttpServer.bindSecure(
      InternetAddress.loopbackIPv4,
      0,
      SecurityContext()
        ..useCertificateChainBytes(utf8.encode(testCertificate))
        ..usePrivateKeyBytes(utf8.encode(testPrivateKey)),
    );
    result.server.listen((request) {
      late Future<void> flight;
      flight = result
          ._serve(request)
          .whenComplete(() => result._flights.remove(flight));
      result._flights.add(flight);
    });
    return result;
  }

  String title(int i) =>
      const [
        'После дождя',
        'Тёплый ветер',
        'Медленный свет',
        'По дороге домой',
        'Линия горизонта',
        'Ночной трамвай',
        'Открытые окна',
        'На берегу',
      ][i % 8] +
      (i < 8 ? '' : ' · ${i + 1}');
  Map<String, Object?> artist(int i) => {
    'id': 'artist-${i % 3}',
    'name': const ['Тихие города', 'Северный берег', 'Комната света'][i % 3],
    'heroUrl': cover(i),
  };
  String cover(int i) => '$origin/api/library/cover-art?id=fixture-${i % 6}';
  Map<String, Object?> album(int i) => {
    'id': 'album-${i % 3}',
    'title': const ['После дождя', 'Тёплый ветер', 'Медленный свет'][i % 3],
    'artist': artist(i),
    'coverArt': cover(i),
    'coverUrl': cover(i),
    'year': 2026,
  };
  Map<String, Object?> track(int i, {bool remote = false}) => {
    'id': remote
        ? 'yt:synthetic${(i % 100).toString().padLeft(2, '0')}'
        : 'local-$i',
    'source': remote ? 'youtube' : 'library',
    if (remote) 'streamSource': 'youtube',
    if (remote)
      'provider': {
        'youtubeVideoId': 'synthetic${(i % 100).toString().padLeft(2, '0')}',
      },
    'title': title(i),
    'duration': 90,
    'artist': artist(i),
    'album': album(i),
    'filePath': remote ? null : 'synthetic/$i.wav',
    'trackNo': i + 1,
  };
  List<Map<String, Object?>> tracks(
    int count, {
    int offset = 0,
    bool remote = false,
  }) => List.generate(count, (i) => track(i + offset, remote: remote));
  Map<String, Object?> feed({bool wave = false}) => {
    'shelves': {
      'listenAgain': tracks(4),
      'quickPicks': tracks(6, offset: 8),
      'discovery': tracks(wave ? 12 : 8, offset: 16, remote: wave),
    },
    'nextCursor': null,
    'generationId': 'fixture-20261015',
    'degraded': false,
    'seedCount': 40,
  };

  Future<void> _serve(HttpRequest request) async {
    final path = request.uri.path, key = '${request.method} $path';
    requests.update(key, (n) => n + 1, ifAbsent: () => 1);
    try {
      if (!path.startsWith('/api/auth/') &&
          request.headers.value(HttpHeaders.authorizationHeader) !=
              'Bearer synthetic-ui-access') {
        request.response.statusCode = 401;
        request.response.write('{"error":"synthetic token required"}');
        return;
      }
      if (path == '/api/library/cover-art') {
        final hint = Uri.tryParse(request.uri.queryParameters['url'] ?? '');
        final index =
            int.tryParse(
              (hint?.queryParameters['id'] ??
                      request.uri.queryParameters['id'] ??
                      '0')
                  .split('-')
                  .last,
            ) ??
            0;
        final bytes = artwork[index % artwork.length];
        request.response.headers.contentType = ContentType('image', 'png');
        request.response.contentLength = bytes.length;
        request.response.add(bytes);
        return;
      }
      if ((path.startsWith('/api/ytmusic/stream/') ||
              path.startsWith('/api/youtube/stream/')) &&
          !const {'LOW', 'MEDIUM', 'HIGH', 'LOSSLESS'}.contains(
            (request.uri.queryParameters['quality'] ?? 'HIGH').toUpperCase(),
          )) {
        request.response.statusCode = 400;
        request.response.headers.contentType = ContentType.json;
        request.response.write('{"error":"Invalid quality"}');
        return;
      }
      if (path.contains('/stream') || path.startsWith('/api/ytmusic/stream/')) {
        final match = RegExp(r'^bytes=(\d+)-(\d*)$')
            .firstMatch(request.headers.value(HttpHeaders.rangeHeader) ?? '');
        final start = match == null ? 0 : int.parse(match[1]!);
        final end = match == null || match[2]!.isEmpty
            ? audio.length - 1
            : int.parse(match[2]!);
        request.response.headers.contentType = ContentType('audio', 'wav');
        request.response.headers.set('Accept-Ranges', 'bytes');
        request.response.headers.set('ETag', '"fixture-wav-v1"');
        if (match != null) {
          request.response.statusCode = 206;
          request.response.headers.set(
            'Content-Range',
            'bytes $start-$end/${audio.length}',
          );
        }
        request.response.contentLength = end - start + 1;
        request.response.add(audio.sublist(start, end + 1));
        return;
      }
      final raw = await utf8.decoder.bind(request).join();
      final body = raw.isEmpty
          ? <String, dynamic>{}
          : jsonDecode(raw) as Map<String, dynamic>;
      final data = _json(request, body);
      request.response.headers.contentType = ContentType.json;
      request.response.write(jsonEncode(data));
    } catch (error) {
      unexpected.add('$key: $error');
      request.response.statusCode = 500;
      request.response.write('{"error":"unexpected synthetic request"}');
    } finally {
      await request.response.close();
    }
  }

  Object? _json(HttpRequest r, Map<String, dynamic> body) {
    final p = r.uri.path, q = r.uri.queryParameters, get = r.method == 'GET';
    switch (p) {
      case '/api/auth/config':
        return {
          'localLoginEnabled': true,
          'oidcEnabled': false,
          'oidcProviderName': '',
        };
      case '/api/auth/login':
        if (body['username'] != 'synthetic' ||
            body['password'] != 'synthetic-only') {
          r.response.statusCode = 401;
          return {'error': 'invalid synthetic credentials'};
        }
        return {
          'token': 'synthetic-ui-access',
          'refreshToken': 'synthetic-ui-refresh',
          'user': {'id': 't24-synthetic'},
        };
      case '/api/auth/refresh':
        return {
          'token': 'synthetic-ui-access',
          'refreshToken': 'synthetic-ui-refresh',
        };
      case '/api/auth/me':
        return {
          'id': 't24-synthetic',
          'username': 'synthetic',
          'displayName': 'Synthetic Listener',
          'email': 'listener@example.invalid',
        };
      case '/api/system/features':
        return {
          'discovery': true,
          'autoPlaylists': true,
          'federation': false,
          'audius': false,
          'loudnessTargetLufs': -14,
        };
      case '/api/settings':
        if (!get) settings.addAll(body);
        return settings;
      case '/api/taste-profile':
        return {
          'needsOnboarding': false,
          'profile': {
            'genres': ['Инди', 'Эмбиент'],
            'artists': ['Тихие города'],
          },
        };
      case '/api/taste-profile/artists':
        return {
          'artists': ['Тихие города', 'Северный берег', 'Комната света'],
          'nextPage': null,
        };
      case '/api/personalized/home':
        return feed(wave: q['surface'] == 'wave');
      case '/api/personalized/daily-mixes':
        return {
          'mixes': [
            for (var i = 0; i < 3; i++)
              {
                'key': 'style-$i',
                'title': const [
                  'Ваш инди',
                  'Тихая электроника',
                  'Близкое и новое',
                ][i],
                'description': '40 записей · синтетическая библиотека',
                'generationId': 'day-$i',
                'tracks': tracks(40, offset: i * 3),
              },
          ],
        };
      case '/api/discover/current':
        return {
          'kind': 'online-weekly',
          'generationId': 'weekly-fixture',
          'weekStart': '2026-10-12',
          'weekEnd': '2026-10-19',
          'tracks': [
            for (var i = 0; i < 40; i++)
              {
                ...track(i),
                'sourceType': 'library',
                'artist': artist(i)['name'],
                'album': album(i)['title'],
                'albumId': album(i)['id'],
                'coverUrl': cover(i),
                'available': true,
              },
          ],
          'unavailable': [],
          'totalCount': 40,
          'unavailableCount': 0,
        };
      case '/api/mixes':
        return [
          {
            'id': 'local-mix',
            'name': 'Снова рядом',
            'description': 'Из вашей коллекции',
            'trackCount': 40,
            'coverUrls': [cover(2)],
          },
        ];
      case '/api/mixes/local-mix':
        return {
          'id': 'local-mix',
          'name': 'Снова рядом',
          'description': 'Из вашей коллекции',
          'trackCount': 40,
          'tracks': tracks(40),
        };
      case '/api/personalized/impressions':
        return {'ok': true};
      case '/api/search':
        return {
          'tracks': tracks(12),
          'artists': [artist(0), artist(1)],
          'albums': [album(0), album(1)],
        };
      case '/api/search/discover':
        return {'results': []};
      case '/api/music-sources/catalog':
        return {'tracks': [], 'unavailable': []};
      case '/api/library/liked':
        final offset = q.containsKey('cursor') ? 100 : 0;
        return {
          'playlist': {'id': 'my-liked', 'name': 'Любимое'},
          'tracks': tracks(40, offset: offset),
          'total': 40,
          'pagination': {'limit': 100, 'hasMore': false, 'nextCursor': null},
        };
      case '/api/library/saved':
        return {
          'items': [
            {
              'entityType': 'album',
              'source': 'library',
              'entityId': 'album-0',
              'title': 'После дождя',
              'subtitle': 'Тихие города',
              'imageUrl': cover(0),
            },
            {
              'entityType': 'artist',
              'source': 'library',
              'entityId': 'artist-0',
              'title': 'Тихие города',
              'imageUrl': cover(1),
            },
          ],
          'total': 2,
        };
      case '/api/library/saved/status':
        return {'saved': true};
      case '/api/playlists':
        if (!get) {
          final value = {
            'id': 'created-${playlists.length}',
            'name': body['name'] ?? 'Новый плейлист',
            'isOwner': true,
            'isPublic': false,
            'isHidden': false,
            'trackCount': 0,
          };
          playlists.add(value);
          return value;
        }
        return playlists;
      case '/api/plays':
        return get
            ? [
                for (var i = 0; i < 6; i++)
                  {
                    'id': 'history-$i',
                    'playedAt': '2026-10-15T08:00:00Z',
                    'track': track(i),
                  },
              ]
            : {'id': 'play-${requests['POST /api/plays']}'};
      case '/api/plays/summary':
        return {
          'allTime': 126,
          'last7Days': 40,
          'last30Days': 92,
          'last365Days': 126,
        };
      case '/api/player/related':
        return {
          'tracks': [
            for (var i = 3; i < 9; i++)
              {...track(i), 'artist': artist(i)['name'], 'inLibrary': true},
          ],
          'artists': [],
          'albums': [],
          'degradedSources': [],
          'nextCursor': null,
          'generationId': 'related',
        };
      case '/api/personalized/radio':
        return {
          'tracks': tracks(12, remote: true),
          'nextCursor': null,
          'generationId': 'radio',
          'degradedSources': [],
        };
      case '/api/library/radio/playlists':
        return [];
      case '/api/notifications':
        return notifications.where((n) => n['cleared'] == false).toList();
      case '/api/notifications/unread-count':
        return {
          'count': notifications
              .where((n) => n['read'] == false && n['cleared'] == false)
              .length,
        };
      case '/api/share-links':
        return [];
      case '/api/import/jobs':
        return {
          'jobs': [importJob],
        };
      case '/api/import/jobs/import-complete':
        return {'job': importJob};
      case '/api/auth/2fa/status':
        return {'enabled': false};
      case '/api/auth/app-passwords':
        return {'appPasswords': []};
      case '/api/api-keys':
        return {'apiKeys': []};
      case '/api/auth/identities':
        return {'identities': []};
    }
    if (p.startsWith('/api/notifications/') && !get) {
      for (final n in notifications) {
        if (p.endsWith('-all') || n['id'] == r.uri.pathSegments[2]) {
          n[p.contains('clear') ? 'cleared' : 'read'] = true;
        }
      }
      return {'success': true};
    }
    if (p.startsWith('/api/lyrics/')) {
      return {
        'synced': true,
        'source': 'synthetic',
        'plainLyrics': 'После дождя\nГород просыпается\nМедленно светит день',
        'syncedLyrics': '[00:00.00] После дождя\n[00:10.00] Город просыпается\n[00:20.00] Медленно светит день',
      };
    }
    if (p.startsWith('/api/plays/') && p.endsWith('/engagement')) {
      return {'ok': true};
    }
    if ((p.startsWith('/api/library/tracks/') ||
            p.startsWith('/api/library/remote-tracks/')) &&
        p.endsWith('/preference')) {
      final id = r.uri.pathSegments[3];
      final signal = body['signal'] ?? preferences[id] ?? 'clear';
      if (!get) preferences[id] = signal;
      return {
        'trackId': id,
        'signal': signal,
        'state': signal == 'thumbs_up'
            ? 'liked'
            : signal == 'thumbs_down'
            ? 'disliked'
            : 'neutral',
        'score': signal == 'thumbs_up'
            ? 1
            : signal == 'thumbs_down'
            ? -1
            : 0,
        'likedAt': null,
        'dislikedAt': null,
        'updatedAt': null,
      };
    }
    if (p.startsWith('/api/library/albums/')) {
      return {
        ...album(0),
        'tracks': tracks(12),
        'description': 'Синтетический альбом для проверки приложения.',
      };
    }
    if (p.startsWith('/api/library/artists/')) {
      return {
        ...artist(0),
        'topTracks': tracks(5),
        'albums': [
          ...List.generate(3, (i) => {...album(i), 'owned': true}),
        ],
        'bio': 'Музыка тихих улиц и длинных прогулок. Синтетический исполнитель для проверки интерфейса.',
      };
    }
    if (p.startsWith('/api/playlists/')) {
      final id = p.split('/')[3];
      final playlist = playlists.firstWhere((e) => e['id'] == id);
      final count = playlist['trackCount'] as int;
      final offset = int.tryParse(r.uri.queryParameters['cursor'] ?? '') ?? 0;
      final limit = (int.tryParse(r.uri.queryParameters['limit'] ?? '') ?? 100)
          .clamp(1, 100);
      final end = (offset + limit).clamp(0, count);
      if (r.method == 'PUT') playlist.addAll(body);
      return {
        ...playlist,
        'pendingCount': 0,
        'totalItemCount': count,
        'truncated': false,
        'mergedItems': [
          for (var i = offset; i < end; i++)
            {
              'id': '$id-item-$i',
              'type': 'track',
              'sort': i,
              'playback': {'isPlayable': true},
              'track': track(i),
            },
        ],
        'pagination': {
          'limit': limit,
          'hasMore': end < count,
          'nextCursor': end < count ? '$end' : null,
        },
      };
    }
    throw StateError('No fixture contract: ${r.method} $p');
  }

  Future<void> close() async {
    await server.close(force: true);
    await Future.wait(_flights.toList());
  }
}

Future<List<int>> _cover(int seed) async {
  final recorder = ui.PictureRecorder(), canvas = ui.Canvas(recorder);
  canvas.scale(2);
  const palettes = [
    [0xff534652, 0xffd8ac8c],
    [0xff253f41, 0xffa8b4a3],
    [0xff594b68, 0xffc9aaf2],
    [0xff6b4435, 0xffe2b783],
    [0xff333b50, 0xffa5afc4],
    [0xff4f5144, 0xffd2c3a4],
  ];
  final colors = palettes[seed % 6].map(ui.Color.new).toList();
  canvas.drawRect(
    const ui.Rect.fromLTWH(0, 0, 512, 512),
    ui.Paint()..color = colors[0],
  );
  canvas.drawCircle(
    ui.Offset(330 - seed * 17, 160 + seed * 12),
    100,
    ui.Paint()..color = colors[1],
  );
  for (var j = 0; j < 4; j++) {
    final path = ui.Path()
      ..moveTo(0, 320 + j * 44)
      ..cubicTo(150, 210 + j * 47, 300, 480 - j * 18, 512, 290 + j * 55)
      ..lineTo(512, 512)
      ..lineTo(0, 512)
      ..close();
    canvas.drawPath(
      path,
      ui.Paint()..color = ui.Color.lerp(colors[0], colors[1], .18 + j * .12)!,
    );
  }
  final picture = recorder.endRecording(),
      image = await picture.toImage(1024, 1024);
  final bytes = (await image.toByteData(format: ui.ImageByteFormat.png))!.buffer
      .asUint8List();
  image.dispose();
  picture.dispose();
  return Uint8List.fromList(bytes);
}
