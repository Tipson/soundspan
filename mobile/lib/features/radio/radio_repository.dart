import '../../core/mapping/home_track_mapper.dart';
import '../../core/mapping/track_mapping.dart';
import '../../core/model/track.dart';
import '../../core/model/track_ref.dart';
import '../../core/model/app_failure.dart';
import '../../core/network/api_transport.dart';
import '../library/library_models.dart';
import '../lyrics/lyrics_repository.dart';
import '../playlists/playlist_repository.dart';

enum RadioSeedKind {
  track,
  artist,
  playlist,
  genre,
  decade,
  discovery,
  favorites,
  workout,
}

/// Seed identifiers are exact. Artist discovery explicitly uses artist-name.
class RadioSeed {
  const RadioSeed.genre(this.value)
    : kind = RadioSeedKind.genre,
      track = null,
      discoveryArtist = false;
  const RadioSeed.track(Track this.track)
    : kind = RadioSeedKind.track,
      value = '',
      discoveryArtist = false;
  const RadioSeed.artist(this.value, {this.discoveryArtist = false})
    : kind = RadioSeedKind.artist,
      track = null;
  const RadioSeed.playlist(this.value)
    : kind = RadioSeedKind.playlist,
      track = null,
      discoveryArtist = false;
  const RadioSeed.station(this.kind, {this.value = ''})
    : track = null,
      discoveryArtist = false;
  final RadioSeedKind kind;
  final String value;
  final Track? track;
  final bool discoveryArtist;
  bool get persisted => {
    RadioSeedKind.genre,
    RadioSeedKind.decade,
    RadioSeedKind.discovery,
    RadioSeedKind.favorites,
    RadioSeedKind.workout,
  }.contains(kind);
  String get identity =>
      '${kind.name}:$discoveryArtist:${track?.ref.identityKey ?? value}';
  String get title => switch (kind) {
    RadioSeedKind.track => track!.title,
    RadioSeedKind.genre => value,
    RadioSeedKind.artist => value,
    RadioSeedKind.playlist => 'По плейлисту',
    RadioSeedKind.decade => '$value-е',
    RadioSeedKind.discovery => 'Открытия',
    RadioSeedKind.favorites => 'Любимое',
    RadioSeedKind.workout => 'Для тренировки',
  };
}

class RadioStation {
  RadioStation({
    this.playlistId,
    Iterable<Track> tracks = const [],
    this.nextCursor,
    this.generationId,
    Iterable<String> degradedSources = const [],
  }) : tracks = List.unmodifiable(tracks),
       degradedSources = List.unmodifiable(degradedSources);
  final String? playlistId, generationId;
  final List<Track> tracks;
  final int? nextCursor;
  final List<String> degradedSources;
}

/// POST acknowledged this ID, but the authoritative GET did not finish.
class RadioReadbackFailure extends AppFailure {
  const RadioReadbackFailure(this.playlistId)
    : super(
        code: 'radio_uncertain',
        message: 'Не удалось проверить сохранённое радио. Повторная отправка отключена.',
      );
  final String playlistId;
}

class RadioRepository extends ExtrasRepository {
  RadioRepository({
    required super.transport,
    required super.authority,
    required super.fence,
    required super.networkPolicy,
  });
  Future<RadioStation> start(RadioSeed seed, {bool Function()? current}) async {
    if (seed.persisted) {
      final dto = collectionObject(
        await request(
          '/api/library/radio/playlists',
          method: ApiMethod.post,
          body: {
            'filter': {
              'type': seed.kind.name,
              if (seed.value.isNotEmpty) 'value': seed.value,
            },
            'size': 25,
          },
          current: current,
        ),
      );
      final id = collectionString(dto['playlistId']);
      // Response can contain only {id}; read authoritative detail for display.
      return _readAcknowledged(id, current: current);
    }
    return readSeed(seed, current: current);
  }

  Future<RadioStation> readSeed(
    RadioSeed seed, {
    int? cursor,
    bool Function()? current,
    int limit = 25,
  }) async {
    if (limit < 1 || limit > 50) {
      throw ArgumentError('Invalid finite radio limit');
    }
    String type, value = seed.value;
    switch (seed.kind) {
      case RadioSeedKind.track:
        final ref = seed.track!.ref;
        switch (ref) {
          case LibraryTrackRef(:final libraryId):
            type = 'vibe';
            value = libraryId;
          case YoutubeTrackRef(:final videoId):
            type = 'youtube';
            value = videoId;
          case NativeTrackRef(:final recording):
            type = recording.provider.name;
            value = recording.id;
          default:
            throw collectionFailure(StateError('unavailable radio seed'));
        }
      case RadioSeedKind.artist:
        type = seed.discoveryArtist ? 'artist-name' : 'artist';
      case RadioSeedKind.playlist:
        type = 'playlist';
      default:
        throw ArgumentError('Persisted station requires start');
    }
    final local = seed.kind == RadioSeedKind.playlist;
    final dto = collectionObject(
      await request(
        local ? '/api/library/radio' : '/api/personalized/radio',
        query: {
          'type': type,
          'value': value,
          'limit': '$limit',
          if (!local && cursor != null) 'cursor': '$cursor',
        },
        current: current,
      ),
    );
    final next = dto['nextCursor'];
    if (next != null && (next is! int || next < 0)) {
      throw collectionFailure(StateError('radio cursor'));
    }
    return RadioStation(
      tracks: [
        for (final raw in collectionList(dto['tracks']))
          radioTrack({
            ...collectionObject(raw),
            'recommendationGenerationId': dto['generationId'],
          }),
      ],
      nextCursor: next as int?,
      generationId: dto['generationId'] as String?,
      degradedSources: (dto['degradedSources'] as List? ?? []).map(
        collectionString,
      ),
    );
  }

  Future<RadioStation> append(String id, {bool Function()? current}) async {
    await request(
      '/api/library/radio/playlists/${Uri.encodeComponent(id)}/append',
      method: ApiMethod.post,
      body: {},
      current: current,
    );
    return _readAcknowledged(id, current: current);
  }

  Future<RadioStation> regenerate(String id, {bool Function()? current}) async {
    await request(
      '/api/library/radio/playlists/${Uri.encodeComponent(id)}/regenerate',
      method: ApiMethod.post,
      body: {},
      current: current,
    );
    return _readAcknowledged(id, current: current);
  }

  // A refused GET cannot undo an acknowledged POST. Retain that stage and ID
  // for all station mutations; only a later explicit GET can reconcile them.
  Future<RadioStation> _readAcknowledged(
    String id, {
    bool Function()? current,
  }) async {
    try {
      return await reconcile(id, current: current);
    } catch (_) {
      throw RadioReadbackFailure(id);
    }
  }

  /// GET only. Unknown create IDs cannot be found: generated playlists are
  /// excluded from /playlists, so the UI must retain an uncertain result.
  Future<RadioStation> reconcile(String id, {bool Function()? current}) async {
    final repo = PlaylistRepository(
      transport: transport,
      authority: authority,
      fence: fence,
      networkPolicy: networkPolicy,
    );
    final tracks = <Track>[];
    String? cursor;
    final seen = <String>{};
    do {
      await guard(current);
      final page = await repo.page(id, cursor);
      await guard(current);
      tracks.addAll(page.items.map((item) => item.track));
      cursor = page.nextCursor;
      if (cursor != null && !seen.add(cursor)) {
        throw collectionFailure(StateError('repeating radio cursor'));
      }
    } while (cursor != null);
    return RadioStation(playlistId: id, tracks: tracks);
  }
}

/// Radio local DTOs have an album.artist; personalized native DTOs carry the
/// full recording tuple and provider envelope validated by T01.
Track radioTrack(Map<String, Object?> row) {
  if (row['artist'] is Map) return const HomeTrackMapper().map(row);
  final album = collectionObject(row['album']);
  final artist = album['artist'] is Map
      ? collectionObject(album['artist'])
      : {'name': row['artist']};
  const fields = TrackFields('/api/library/radio');
  return fields.buildTrack(
    row,
    title: collectionString(row['title']),
    artist: collectionString(artist['name']),
    artistId: artist['id'] as String?,
    album: album['title'] as String?,
    albumId: album['id'] as String?,
    cover: fields.artwork(album['coverArt'], 'album.coverArt'),
  );
}
