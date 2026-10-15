import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/mapping/home_track_mapper.dart';
import 'package:soundspan/core/mapping/weekly_track_mapper.dart';
import 'package:soundspan/core/mapping/search_track_mapper.dart';
import 'package:soundspan/core/mapping/liked_track_mapper.dart';
import 'package:soundspan/core/mapping/playlist_track_mapper.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/model/queue_entry.dart';
import 'package:soundspan/core/model/track_ref.dart';

Map<String, Object?> fixture(String name) =>
    (jsonDecode(File('test/fixtures/$name.json').readAsStringSync()) as Map)
        .cast<String, Object?>();

Map<String, Object?> object(Object? value) =>
    (value as Map).cast<String, Object?>();

void main() {
  test('actual federated liked projection without peer remains playable', () {
    final track = const LikedTrackMapper().map(fixture('liked_federated'));
    expect(track.ref, const LibraryTrackRef('federated-db-id'));
    expect(track.playable, true);
    expect(track.unavailableReason, isNull);
  });

  test('explicit federated peer offline still blocks liked playback', () {
    final dto = fixture('liked_federated')
      ..['peer'] = {'id': 'peer', 'name': 'Peer', 'online': false};
    final track = const LikedTrackMapper().map(dto);
    expect(track.playable, false);
    expect(track.unavailableReason, 'peer_offline');
  });

  test(
    'library search reads actual flat SQL projection and peer availability',
    () {
      final dto = <String, Object?>{
        'id': 'opaque-search-id',
        'title': 'SQL result',
        'artistId': 'artist-id',
        'artistName': 'SQL artist',
        'albumId': 'album-id',
        'albumTitle': 'SQL album',
        'duration': 152.75,
        'rank': 0.7,
        'loudnessLufs': -14.5,
        'albumLoudnessLufs': -17.1,
        'albumTruePeakDb': -1.2,
        'source': 'federated',
        'peer': {'id': 'peer', 'name': 'Peer', 'online': false},
      };
      final track = const SearchTrackMapper().mapLibrary(dto);
      expect(track.ref.identityKey, 'library:opaque-search-id');
      expect(track.artist, 'SQL artist');
      expect(track.album, 'SQL album');
      expect(track.artistId, 'artist-id');
      expect(track.albumLoudnessLufs, -17.1);
      expect(track.playable, false);
      expect(track.unavailableReason, 'peer_offline');
    },
  );

  test('saved local weekly has no streamSource or provider requirement', () {
    final track = const WeeklyTrackMapper().map({
      'id': 'local-weekly-id',
      'title': 'Saved discovery',
      'artist': 'Artist',
      'album': 'Album',
      'albumId': 'album-id',
      'duration': 212,
      'sourceType': 'local',
      'coverUrl': null,
      'available': true,
      'loudnessLufs': -14.2,
      'albumLoudnessLufs': -16.8,
    });
    expect(track.ref, const LibraryTrackRef('local-weekly-id'));
    expect(track.playable, true);
    expect(track.albumLoudnessLufs, -16.8);
  });

  test('maps each endpoint shape without identity substitution', () {
    final home = const HomeTrackMapper().map(fixture('home'));
    final weekly = const WeeklyTrackMapper().map(fixture('weekly'));
    final search = const SearchTrackMapper().map(fixture('search'));
    final liked = const LikedTrackMapper().map(fixture('liked'));
    final playlist = const PlaylistTrackMapper().map(fixture('playlist'));
    expect(home.ref.identityKey, 'vk:-1_2');
    expect(weekly.ref.identityKey, 'yandex:3');
    expect(search.ref.identityKey, 'yt:aB_12-xyz89');
    expect(liked.ref, isA<LibraryTrackRef>());
    expect(
      (liked.ref as LibraryTrackRef).libraryId,
      'db-track:opaque/CURSOR==',
    );
    expect(weekly.artist, 'Исполнитель');
    expect(weekly.album, 'Альбом недели');
    expect(weekly.recommendationGenerationId, 'opaque-generation');
    expect(playlist.artist, 'Вложенный артист');
    expect(search.title, 'Найденная песня');
    expect(home.duration, const Duration(milliseconds: 180125));
    expect(search.duration, const Duration(milliseconds: 201750));
  });

  test('server file and transient lease never become a device file', () {
    final dto = fixture('liked')
      ..['streamPath'] = '/api/music-sources/leases/secret/stream';
    final track = const LikedTrackMapper().map(dto);
    expect(track.ref, isA<LibraryTrackRef>());
    expect(track.ref.identityKey, 'library:db-track:opaque/CURSOR==');
    expect(track.loudnessLufs, -16.5);
    expect(track.albumTruePeakDb, -0.8);
    expect(track.artwork, Uri.parse('/api/library/albums/album-id/cover'));
  });

  test('native recording is an immutable sanitized public snapshot', () {
    final dto = fixture('home');
    final recordingDto = object(dto['musicSourceRecording'])
      ..['streamUrl'] = 'https://secret.test/private?token=private';
    dto['musicSourceRecording'] = recordingDto;
    final track = const HomeTrackMapper().map(dto);
    final recording = (track.ref as NativeTrackRef).recording;
    (recordingDto['artists'] as List)[0] = 'Mutated';
    expect(recording.artists, ['Первый', 'Второй']);
    expect(() => recording.artists.add('No'), throwsUnsupportedError);
    expect(recording.toJson().containsKey('streamUrl'), false);
    expect(recording.isrc, 'RUABC2600001');
    expect(track.explicit, true);
  });

  for (final field in ['source', 'streamSource', 'id', 'title', 'duration']) {
    test('native tuple rejects conflicting $field without legacy fallback', () {
      final dto = fixture('home');
      dto[field] = field == 'duration' ? 199 : 'youtube';
      expect(
        () => const HomeTrackMapper().map(dto),
        throwsA(isA<MappingFailure>()),
      );
    });
  }
  for (final change in <Map<String, Object?>>[
    {'providerTrackId': 'different'},
    {'source': 'youtube'},
    {'youtubeVideoId': 'incidental'},
    {'tidalTrackId': 1},
  ]) {
    test('native provider authority rejects $change', () {
      final dto = fixture('home');
      dto['provider'] = {...object(dto['provider']), ...change};
      expect(
        () => const HomeTrackMapper().map(dto),
        throwsA(isA<MappingFailure>()),
      );
    });
  }
  for (final change in <Map<String, Object?>>[
    {'id': '1_bad'},
    {'artists': []},
    {'title': ' '},
    {'duration': 0},
    {'duration': 3601},
    {'preview': true},
    {'contentVersion': 'live'},
    {'isrc': 'not-isrc'},
    {'isrc': null},
  ]) {
    test('catalog recording rejects malformed $change', () {
      final recording = {
        ...object(fixture('home')['musicSourceRecording']),
        ...change,
      };
      expect(
        () => const SearchTrackMapper().mapCatalog(recording),
        throwsA(isA<MappingFailure>()),
      );
    });
  }

  test(
    'catalog permits server schema boundaries without weekly admission cuts',
    () {
      final recording = object(fixture('home')['musicSourceRecording'])
        ..['id'] = '-00000000000000000001_00000000000000000002'
        ..['duration'] = 1.25;
      final track = const SearchTrackMapper().mapCatalog(recording);
      expect(track.duration, const Duration(milliseconds: 1250));
      expect(
        track.ref.identityKey,
        'vk:-00000000000000000001_00000000000000000002',
      );
    },
  );

  test(
    'retired Tidal stays unavailable but local backing keeps DB identity',
    () {
      final dto = fixture('liked')
        ..['source'] = 'tidal'
        ..['id'] = 'tidal:123'
        ..['filePath'] = null
        ..['provider'] = {'tidalTrackId': 123, 'youtubeVideoId': null};
      final retired = const LikedTrackMapper().map(dto);
      expect(retired.playable, false);
      expect(retired.ref.identityKey, 'tidal:123');
      expect(retired.unavailableReason, 'retired_provider');
      dto['source'] = 'local';
      dto['id'] = 'real-library-id';
      dto['filePath'] = '/server/music.flac';
      expect(
        const LikedTrackMapper().map(dto).ref,
        const LibraryTrackRef('real-library-id'),
      );
    },
  );

  test(
    'incidental YouTube metadata cannot revive retired or unknown source',
    () {
      final dto = fixture('liked')
        ..['source'] = 'tidal'
        ..['id'] = 'tidal:123'
        ..['filePath'] = null
        ..['provider'] = {'tidalTrackId': 123, 'youtubeVideoId': 'incidental'};
      expect(const LikedTrackMapper().map(dto).playable, false);
      dto['source'] = 'unsupported-provider';
      dto['id'] = 'unsupported:123';
      dto['provider'] = {'youtubeVideoId': 'incidental'};
      expect(const LikedTrackMapper().map(dto).playable, false);
    },
  );

  test(
    'unknown discovery ids are unavailable rather than invented YouTube ids',
    () {
      final track = const SearchTrackMapper().map({
        'type': 'track',
        'name': 'Unresolved',
        'id': 'lastfm:opaque',
        'artist': 'Artist',
      });
      expect(track.playable, false);
      expect(track.ref, isA<UnavailableTrackRef>());
    },
  );

  test(
    'active YouTube authority wins incidental historical Tidal metadata',
    () {
      final dto = fixture('liked')
        ..['source'] = 'youtube'
        ..['id'] = 'yt:exact-video'
        ..['filePath'] = null
        ..['provider'] = {'tidalTrackId': 123, 'youtubeVideoId': 'exact-video'};
      final track = const LikedTrackMapper().map(dto);
      expect(track.ref, const YoutubeTrackRef('exact-video'));
      expect(track.playable, true);
    },
  );

  test('discovery only accepts track rows and requires name shape', () {
    expect(
      () => const SearchTrackMapper().map({'type': 'album', 'name': 'Album'}),
      throwsA(isA<MappingFailure>()),
    );
    final dto = fixture('search')..remove('name');
    expect(
      () => const SearchTrackMapper().map(dto),
      throwsA(isA<MappingFailure>()),
    );
  });

  test('playlist item identity and playback fence survive mapping', () {
    final dto = fixture('playlist');
    dto['playback'] = {
      'isPlayable': false,
      'reason': 'peer_offline',
      'message': 'Peer offline',
    };
    final track = const PlaylistTrackMapper().map(dto);
    expect(track.ref.identityKey, 'library:db-playlist-track');
    expect(track.playable, false);
    expect(track.unavailableReason, 'peer_offline');
    expect(
      () =>
          const PlaylistTrackMapper().map({'type': 'pending', 'id': 'pending'}),
      throwsA(isA<MappingFailure>()),
    );
  });

  test(
    'missing playlist track remains unavailable instead of an invented track',
    () {
      final track = const PlaylistTrackMapper().map({
        'type': 'track',
        'id': 'item',
        'track': null,
        'playback': {'isPlayable': false, 'reason': 'missing_provider_track'},
      });
      expect(track.playable, false);
      expect(track.ref, isA<UnavailableTrackRef>());
    },
  );

  test(
    'queue entry IDs distinguish duplicate track references and retain context',
    () {
      final track = const HomeTrackMapper().map(fixture('home'));
      const context = PlayContext(
        surface: PlaySurface.wave,
        waveMode: WaveMode.familiar,
        recommendationGenerationId: 'generation',
        recommendationSessionId: 'session',
      );
      final first = QueueEntry(
        entryId: 'entry-1',
        track: track,
        context: context,
      );
      final second = QueueEntry(
        entryId: 'entry-2',
        track: track,
        context: context,
      );
      expect(first.entryId, isNot(second.entryId));
      expect(first.track.ref, second.track.ref);
      expect(first.context, same(context));
    },
  );

  test(
    'owner equality normalizes HTTPS origin and preserves opaque user id',
    () {
      final first = OwnerKey(
        serverOrigin: Uri.parse('https://EXAMPLE.test:443/'),
        userId: 'opaque/User==',
      );
      final second = OwnerKey(
        serverOrigin: Uri.parse('https://example.test'),
        userId: 'opaque/User==',
      );
      expect(first, second);
      expect(first.hashCode, second.hashCode);
      expect(first.serverOrigin, Uri.parse('https://example.test'));
      expect(
        first,
        isNot(
          OwnerKey(
            serverOrigin: Uri.parse('https://example.test:444'),
            userId: first.userId,
          ),
        ),
      );
      expect(
        first,
        isNot(OwnerKey(serverOrigin: first.serverOrigin, userId: 'other')),
      );
      expect(
        first,
        isNot(
          OwnerKey(
            serverOrigin: Uri.parse('https://sub.example.test'),
            userId: first.userId,
          ),
        ),
      );
      expect(
        SessionFence(owner: first, epoch: 1),
        SessionFence(owner: second, epoch: 1),
      );
      expect(
        SessionFence(owner: first, epoch: 1),
        isNot(SessionFence(owner: first, epoch: 2)),
      );
    },
  );

  test('owner rejects ambiguous or insecure origins', () {
    for (final origin in [
      'http://example.test',
      'https://user:pass@example.test',
      'https://example.test/api',
      'https://example.test?q=secret',
      'https://example.test/#fragment',
    ]) {
      expect(
        () => OwnerKey(serverOrigin: Uri.parse(origin), userId: 'id'),
        throwsArgumentError,
      );
    }
  });

  test('missing/wrong typed shapes always produce typed mapping failures', () {
    for (final dto in <Map<String, Object?>>[
      {},
      {'id': 42},
      {'id': 'opaque', 'title': 'Title', 'artist': []},
    ]) {
      expect(
        () => const HomeTrackMapper().map(dto),
        throwsA(isA<MappingFailure>()),
      );
    }
    final dto = fixture('liked')..['loudnessLufs'] = double.nan;
    expect(
      () => const LikedTrackMapper().map(dto),
      throwsA(isA<MappingFailure>()),
    );
    final overflow = fixture('liked')..['duration'] = double.maxFinite;
    expect(
      () => const LikedTrackMapper().map(overflow),
      throwsA(isA<MappingFailure>()),
    );
  });
}
