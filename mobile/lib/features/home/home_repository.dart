import '../../core/mapping/home_track_mapper.dart';
import '../../core/mapping/track_mapping.dart';
import '../../core/mapping/weekly_track_mapper.dart';
import '../../core/model/app_failure.dart';
import '../../core/model/track.dart';
import '../../core/network/api_transport.dart';
import '../../core/network/network_policy.dart';
import '../../core/session/session_authority.dart';
import '../../playback/wave_selection.dart';
import '../recommendations/recommendation_repository.dart';
import 'home_models.dart';

/// Home-only DTO adapters. All network work retains this captured owner fence.
final class HomeRepository {
  HomeRepository({
    required this.transport,
    required this.authority,
    required this.fence,
    this.networkPolicy = const NetworkPolicy.online(),
  });
  final ApiTransport transport;
  final SessionAuthority authority;
  final SessionFence fence;
  final NetworkPolicy networkPolicy;
  bool _revoked = false;
  bool get isCurrent {
    if (!authority.isCurrent(fence)) _revoked = true;
    return !_revoked;
  }

  void revoke() => _revoked = true;
  Future<void> _guard() async {
    if (!isCurrent) throw homeStale;
    await authority.assertCurrent(fence);
    if (!isCurrent) throw homeStale;
  }

  Future<Object?> _get(
    String path, [
    Map<String, String> query = const {},
  ]) async {
    networkPolicy.requireNetwork();
    await _guard();
    final response = await transport.send(
      ApiRequest(
        origin: fence.owner.serverOrigin,
        method: ApiMethod.get,
        path: path,
        query: query,
      ),
      fence: fence,
    );
    await _guard();
    response.requireSuccess();
    return response.data;
  }

  Map<String, String> _query(
    HomeRequest request,
    String surface, {
    bool daypart = false,
  }) => {
    'limit': surface == 'home' ? '12' : '25',
    'surface': surface,
    'mode': surface == 'home' ? waveModeWire(request.mode) : 'for-you',
    if (surface == 'home' && request.mood != null) 'mood': request.mood!,
    'deviceClass': 'mobile',
    'localHour': '${request.localHour}',
    'timezoneOffsetMinutes': '${request.timezoneOffsetMinutes}',
    if (daypart) 'timeOfDay': '1',
  };

  Future<HomeFeed> load(HomeRequest request, {Set<String>? sections}) async {
    networkPolicy.requireNetwork();
    await _guard();
    final failures = <String, AppFailure>{};
    Future<T?> part<T>(String name, Future<T> Function() operation) async {
      if (sections != null && !sections.contains(name)) return null;
      try {
        return await operation();
      } catch (error) {
        if (!isCurrent) rethrow;
        failures[name] = homeFailure(error);
        return null;
      }
    }

    // Every request starts independently; a failing shelf does not erase others.
    final results = await Future.wait<Object?>([
      part(
        'home',
        () async => _feed(
          await _get('/api/personalized/home', _query(request, 'home')),
        ),
      ),
      part('daily', _daily),
      part<MusicMix?>(
        'dailyBlend',
        () async => _personalMix(
          await _get('/api/personalized/home', _query(request, 'made-for-you')),
          MusicMixKind.dailyBlend,
          'daily-blend',
          'Микс дня',
          'Знакомая музыка и новые открытия',
        ),
      ),
      part<MusicMix?>(
        'daypart',
        () async => _personalMix(
          await _get(
            '/api/personalized/home',
            _query(request, 'made-for-you', daypart: true),
          ),
          MusicMixKind.daypart,
          'time-${request.localHour < 6
              ? 'night'
              : request.localHour < 12
              ? 'morning'
              : request.localHour < 18
              ? 'daytime'
              : 'evening'}',
          daypartTitle(request.localHour),
          'Музыка для вашего времени дня',
        ),
      ),
      if (request.discovery) part('weekly', weekly),
      if (request.autoPlaylists) part('legacy', legacyMixes),
    ]);
    await _guard();
    final main = results[0] as HomeFeed?;
    final dailyResult =
        results[1] as ({List<MusicMix> mixes, List<HomeMixStatus> statuses})?;
    final daily = dailyResult?.mixes;
    var index = 4;
    final weeklyMix = request.discovery ? results[index++] as MusicMix? : null;
    final legacy = request.autoPlaylists
        ? results[index] as List<MusicMix>?
        : null;
    return HomeFeed(
      shelves: main?.shelves ?? [],
      mixStatuses: dailyResult?.statuses ?? [],
      mixes: [
        ...?daily,
        if (daily?.isEmpty == true &&
            results[2] != null &&
            (results[2] as MusicMix).tracks.isNotEmpty)
          results[2] as MusicMix,
        if (results[3] != null) results[3] as MusicMix,
        ?weeklyMix,
        ...?legacy,
      ],
      failures: failures,
      generationId: main?.generationId,
      reason: main?.reason,
      languagePending: main?.languagePending ?? false,
      serverDegraded: main?.serverDegraded ?? false,
    );
  }

  Future<List<MusicMix>> dailyMixes() async => (await _daily()).mixes;

  Future<({List<MusicMix> mixes, List<HomeMixStatus> statuses})>
  _daily() async {
    final value = _map(await _get('/api/personalized/daily-mixes'));
    final mixes = _list(value['mixes'])
        .map((row) {
          final dto = _map(row);
          return MusicMix(
            id: _string(dto['key']),
            title: _string(dto['title']),
            description: _text(dto['description']),
            kind: MusicMixKind.daily,
            tracks: _list(dto['tracks'])
                .map((t) => const HomeTrackMapper().map(_map(t))),
            generationId: _optional(dto['generationId']),
            snapshot: MixSnapshot.tryParse(dto['snapshot']),
          );
        })
        .where((mix) => mix.tracks.isNotEmpty)
        .toList();
    final available = mixes.map((mix) => mix.id).toSet();
    final seen = <String>{};
    final statuses = <HomeMixStatus>[];
    if (value['statuses'] case final List rows) {
      for (final row in rows) {
        if (row is! Map || row['key'] is! String || row['title'] is! String) {
          continue;
        }
        final id = row['key'] as String, title = row['title'] as String;
        final snapshot = MixSnapshot.tryParse(row['snapshot']);
        if (id.isEmpty ||
            title.isEmpty ||
            available.contains(id) ||
            snapshot == null ||
            !seen.add(id)) {
          continue;
        }
        statuses.add(HomeMixStatus(id: id, title: title, snapshot: snapshot));
      }
    }
    return (mixes: mixes, statuses: statuses);
  }

  Future<MusicMix> weekly() async {
    final dto = _map(await _get('/api/discover/current'));
    final tracks = _list(dto['tracks'])
        .map((t) => const WeeklyTrackMapper().map(_map(t)))
        .toList();
    final unavailable = _list(dto['unavailable'])
        .map((t) => const WeeklyTrackMapper().map(_map(t)))
        .toList();
    return MusicMix(
      id: 'weekly',
      title: 'Открытия недели',
      description: 'Новая музыка для вас',
      kind: MusicMixKind.weekly,
      tracks: [...tracks, ...unavailable],
      trackCount: _count(dto['totalCount']),
      generationId: _optional(dto['generationId']),
      weekStart: _optional(dto['weekStart']),
      weekEnd: _optional(dto['weekEnd']),
      snapshot: MixSnapshot.tryParse(dto['snapshot']),
    );
  }

  Future<List<MusicMix>> legacyMixes() async =>
      _list(await _get('/api/mixes'))
          .map((row) => _legacy(_map(row), detail: false))
          .toList();

  Future<MusicMix> detail(MusicMix mix) async {
    if (mix.kind != MusicMixKind.legacy) {
      await _guard();
      return mix;
    }
    return _legacy(
      _map(await _get('/api/mixes/${Uri.encodeComponent(mix.id)}')),
      detail: true,
    );
  }

  Future<MixSaveReceipt> saveLegacy(MusicMix mix) async {
    if (mix.kind != MusicMixKind.legacy) {
      throw ArgumentError('Daily mixes use explicit playlist subset review');
    }
    networkPolicy.requireNetwork();
    await _guard();
    try {
      final response = await transport.send(
        ApiRequest(
          origin: fence.owner.serverOrigin,
          method: ApiMethod.post,
          path: '/api/mixes/${Uri.encodeComponent(mix.id)}/save',
          body: {},
        ),
        fence: fence,
      );
      await _guard();
      response.requireSuccess();
      final dto = _map(response.data);
      return MixSaveReceipt(
        playlistId: _string(dto['id']),
        message: 'Подборка сохранена в плейлист',
      );
    } on AppFailure catch (failure) {
      if (failure.statusCode != 409) rethrow;
      // DartApiTransport deliberately withholds error bodies. Confirm the
      // destination using only the authenticated owned playlist relationship.
      return _existingLegacy(mix.id);
    }
  }

  Future<MixSaveReceipt> _existingLegacy(String mixId) async {
    const limit = 500;
    var offset = 0;
    final seen = <String>{};
    while (true) {
      final rows = _list(
        await _get('/api/playlists', {'limit': '$limit', 'offset': '$offset'}),
      );
      if (rows.length > limit) throw _shape;
      var fresh = 0;
      for (final value in rows) {
        final row = _map(value);
        final id = _string(row['id']);
        if (seen.add(id)) fresh++;
        if (row['mixId'] == mixId &&
            row['userId'] == fence.owner.userId &&
            row['isOwner'] == true) {
          return MixSaveReceipt(
            playlistId: id,
            message: 'Подборка уже сохранена в плейлист',
          );
        }
      }
      if (rows.length < limit) break;
      if (fresh == 0) throw _shape;
      offset += rows.length;
    }
    throw const AppFailure(
      code: 'mix_save_unverified',
      message: 'Подборка уже сохранена, но плейлист пока не удалось подтвердить. Откройте мои плейлисты.',
    );
  }

  Future<void> reportVisible(
    HomeShelf shelf,
    Iterable<Track> tracks, {
    bool Function()? admit,
  }) async {
    networkPolicy.requireNetwork();
    await _guard();
    final generation = shelf.generationId;
    if (generation == null) return;
    if (admit != null && !admit()) return;
    await RecommendationRepository(
      transport: transport,
      networkPolicy: networkPolicy,
    ).reportVisible(generation, tracks, fence);
    await _guard();
  }

  HomeFeed _feed(Object? value) {
    final dto = _map(value), shelves = _map(dto['shelves']);
    final generation = _optional(dto['generationId']);
    return HomeFeed(
      shelves: [
        for (final pair in [
          ('listenAgain', 'Послушайте снова'),
          ('quickPicks', 'Быстрый выбор'),
          ('discovery', 'Новые открытия'),
        ])
          HomeShelf(
            id: pair.$1,
            title: pair.$2,
            generationId: generation,
            tracks: _list(shelves[pair.$1])
                .map((t) => const HomeTrackMapper().map(_map(t))),
          ),
      ],
      generationId: generation,
      reason: _optional(dto['reason']),
      serverDegraded: dto['degraded'] == true,
      languagePending:
          dto['languageStatus'] is Map &&
          (dto['languageStatus'] as Map)['pending'] == true,
    );
  }

  MusicMix? _personalMix(
    Object? value,
    MusicMixKind kind,
    String id,
    String title,
    String description,
  ) {
    final dto = _map(value), feed = _feed(dto);
    final projection = dto['timeOfDayMix'];
    if (kind == MusicMixKind.daypart && projection is Map) {
      final projectedTracks = projection['tracks'];
      if (projectedTracks is List && projectedTracks.length <= 40) {
        // Keep server occurrence order, including an empty pool. Absent or
        // malformed optional projections use the shelf recipe below.
        return MusicMix(
          id: id,
          title: title,
          description: description,
          kind: kind,
          tracks: projectedTracks.map(
            (track) => const HomeTrackMapper().map(_map(track)),
          ),
          generationId: feed.generationId,
          reason: feed.reason,
          languagePending: feed.languagePending,
          snapshot: MixSnapshot.tryParse(projection['snapshot']),
        );
      }
    }
    final seen = <String>{};
    final lanes = kind == MusicMixKind.daypart
        ? [feed.shelves[2], feed.shelves[1], feed.shelves[0]]
        : [feed.shelves[1], feed.shelves[2], feed.shelves[0]];
    final tracks = <Track>[];
    // Round-robin daily blend follows the web recipe; daypart starts discovery.
    if (kind == MusicMixKind.daypart) {
      for (final shelf in lanes) {
        for (final track in shelf.tracks) {
          if (seen.add(track.ref.identityKey)) tracks.add(track);
        }
      }
    } else {
      for (var i = 0; lanes.any((l) => i < l.tracks.length); i++) {
        for (final lane in lanes) {
          if (i < lane.tracks.length &&
              seen.add(lane.tracks[i].ref.identityKey)) {
            tracks.add(lane.tracks[i]);
          }
        }
      }
    }
    if (tracks.isEmpty) return null;
    return MusicMix(
      id: id,
      title: title,
      description: description,
      kind: kind,
      tracks: tracks.take(40),
      generationId: feed.generationId,
      reason: feed.reason,
      languagePending: feed.languagePending,
    );
  }

  MusicMix _legacy(Map<String, Object?> dto, {required bool detail}) {
    final tracks = <Track>[];
    if (detail) {
      const f = TrackFields('/api/mixes/:id');
      for (final row in _list(dto['tracks'])) {
        final t = _map(row), album = _map(t['album']);
        final artist = _map(t['artist'] ?? album['artist']);
        tracks.add(
          f.buildTrack(
            t,
            title: f.string(t['title'], 'title', nonempty: true),
            artist: f.string(artist['name'], 'artist.name', nonempty: true),
            artistId: f.optionalString(artist['id'], 'artist.id'),
            album: f.string(album['title'], 'album.title'),
            albumId: f.optionalString(album['id'], 'album.id'),
            cover: f.artwork(album['coverArt'], 'album.coverArt'),
          ),
        );
      }
    }
    final covers = dto['coverUrls'];
    return MusicMix(
      id: _string(dto['id']),
      title: _string(dto['name']),
      description: _text(dto['description']),
      kind: MusicMixKind.legacy,
      tracks: tracks,
      trackCount: dto['trackCount'] == null
          ? tracks.length
          : _count(dto['trackCount']),
      artwork: covers is List && covers.isNotEmpty && covers.first is String
          ? Uri.tryParse(covers.first as String)
          : null,
      loaded: detail,
    );
  }

  static const _shape = AppFailure(
    code: 'invalid_home',
    message: 'Сервер вернул некорректные данные подборки.',
  );
  static Map<String, Object?> _map(Object? value) {
    if (value is! Map || value.keys.any((k) => k is! String)) throw _shape;
    return value.cast<String, Object?>();
  }

  static List<Object?> _list(Object? value) {
    if (value is! List) throw _shape;
    return value;
  }

  static String _string(Object? value) {
    if (value is! String || value.isEmpty) throw _shape;
    return value;
  }

  static String _text(Object? value) {
    if (value is! String) throw _shape;
    return value;
  }

  static String? _optional(Object? value) =>
      value == null ? null : _string(value);
  static int _count(Object? value) {
    if (value is! int || value < 0) throw _shape;
    return value;
  }
}
