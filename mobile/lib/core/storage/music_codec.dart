import '../model/queue_entry.dart';
import '../model/track.dart';
import '../model/track_ref.dart';

/// Portable public music metadata for owner records, independent of API DTOs.
/// Decoders reject unknown fields/sources instead of guessing replacement IDs.
/// Artwork is deliberately omitted: the shared artwork repository rehydrates
/// by TrackRef. No URL, lease, token or device path belongs in this format.
abstract final class MusicCodec {
  static const maxTextLength = 1024;
  static const maxDurationUs = 7 * 24 * 60 * 60 * 1000000;

  /// Encodes an exact source identity, including an unavailable retained row.
  static Map<String, Object?> encodeTrackRef(TrackRef ref) =>
      _checked(switch (ref) {
        LibraryTrackRef() => {'kind': 'library', 'libraryId': ref.libraryId},
        YoutubeTrackRef() => {
          'kind': 'youtube',
          'videoId': ref.videoId,
          'youtubeKind': ref.youtubeKind.name,
        },
        NativeTrackRef() => {
          'kind': 'native',
          'recording': encodeRecording(ref.recording),
        },
        UnavailableTrackRef() => {
          'kind': 'unavailable',
          'identityKey': ref.identityKey,
          'reason': ref.reason,
        },
      }, decodeTrackRef);

  /// Throws FormatException for an invalid or unknown identity; never resolves.
  static TrackRef decodeTrackRef(Object? value) {
    final row = _object(value, {
      'kind',
      'libraryId',
      'videoId',
      'youtubeKind',
      'recording',
      'identityKey',
      'reason',
    });
    switch (row['kind']) {
      case 'library':
        _object(row, {'kind', 'libraryId'});
        return LibraryTrackRef(_identity(row['libraryId']));
      case 'youtube':
        _object(row, {'kind', 'videoId', 'youtubeKind'});
        final id = _text(row['videoId'], max: 128);
        if (!RegExp(r'^[A-Za-z0-9_-]+$').hasMatch(id)) _fail();
        return YoutubeTrackRef(
          id,
          youtubeKind: _enum(row['youtubeKind'], YoutubeKind.values),
        );
      case 'native':
        _object(row, {'kind', 'recording'});
        return NativeTrackRef(decodeRecording(row['recording']));
      case 'unavailable':
        _object(row, {'kind', 'identityKey', 'reason'});
        return UnavailableTrackRef(
          _identity(row['identityKey']),
          reason: _text(row['reason']),
        );
      default:
        _fail();
    }
  }

  /// Includes every public exact-candidate field, without endpoint transport DTOs.
  static Map<String, Object?> encodeRecording(MusicRecording recording) =>
      _checked({
        'provider': recording.provider.name,
        'id': recording.id,
        'title': recording.title,
        'artists': recording.artists.toList(),
        'durationSeconds': recording.durationSeconds,
        'contentVersion': recording.contentVersion.name,
        'isrc': recording.isrc,
      }, decodeRecording);

  static MusicRecording decodeRecording(Object? value) {
    final row = _object(value, {
      'provider',
      'id',
      'title',
      'artists',
      'durationSeconds',
      'contentVersion',
      'isrc',
    });
    final artists = row['artists'];
    if (artists is! List || artists.isEmpty || artists.length > 10) _fail();
    final title = _text(row['title'], max: 200);
    final names = artists.map((item) => _text(item, max: 100)).toList();
    // Persisted exact metadata must already be canonical; decoding must not
    // silently normalize its title/artists through the endpoint constructor.
    if (title.trim() != title || names.any((name) => name.trim() != name)) {
      _fail();
    }
    try {
      return MusicRecording(
        provider: _enum(row['provider'], NativeMusicProvider.values),
        id: _text(row['id'], max: 42),
        title: title,
        artists: names,
        durationSeconds: _number(row['durationSeconds']),
        contentVersion: _enum(
          row['contentVersion'],
          MusicContentVersion.values,
        ),
        isrc: _optionalText(row['isrc'], max: 12),
      );
    } on ArgumentError {
      _fail();
    }
  }

  /// Encodes display, replay-gain and availability metadata; excludes artwork.
  static Map<String, Object?> encodeTrack(Track track) => _checked({
    'ref': encodeTrackRef(track.ref),
    'title': track.title,
    'artist': track.artist,
    'album': track.album,
    'durationUs': track.duration?.inMicroseconds,
    'explicit': track.explicit,
    'artistId': track.artistId,
    'albumId': track.albumId,
    'trackNo': track.trackNo,
    'loudnessLufs': track.loudnessLufs,
    'truePeakDb': track.truePeakDb,
    'albumLoudnessLufs': track.albumLoudnessLufs,
    'albumTruePeakDb': track.albumTruePeakDb,
    'recommendationGenerationId': track.recommendationGenerationId,
    'playbackAllowed': track.playbackAllowed,
    'unavailableReason': track.unavailableReason,
  }, decodeTrack);

  static Track decodeTrack(Object? value) {
    final row = _object(value, {
      'ref',
      'title',
      'artist',
      'album',
      'durationUs',
      'explicit',
      'artistId',
      'albumId',
      'trackNo',
      'loudnessLufs',
      'truePeakDb',
      'albumLoudnessLufs',
      'albumTruePeakDb',
      'recommendationGenerationId',
      'playbackAllowed',
      'unavailableReason',
    });
    return Track(
      ref: decodeTrackRef(row['ref']),
      title: _text(row['title']),
      artist: _text(row['artist']),
      album: row['album'] == null
          ? null
          : _text(row['album'], allowEmpty: true),
      duration: row['durationUs'] == null
          ? null
          : Duration(
              microseconds: _integer(row['durationUs'], max: maxDurationUs),
            ),
      explicit: row['explicit'] == null ? null : _boolean(row['explicit']),
      artistId: _optionalIdentity(row['artistId']),
      albumId: _optionalIdentity(row['albumId']),
      trackNo: row['trackNo'] == null
          ? null
          : _integer(row['trackNo'], max: 1000000),
      loudnessLufs: _optionalNumber(row['loudnessLufs']),
      truePeakDb: _optionalNumber(row['truePeakDb']),
      albumLoudnessLufs: _optionalNumber(row['albumLoudnessLufs']),
      albumTruePeakDb: _optionalNumber(row['albumTruePeakDb']),
      recommendationGenerationId: _optionalIdentity(
        row['recommendationGenerationId'],
      ),
      playbackAllowed: _boolean(row['playbackAllowed']),
      unavailableReason: _optionalText(row['unavailableReason']),
    );
  }

  static Map<String, Object?> encodePlayContext(PlayContext context) =>
      _checked({
        'surface': context.surface.name,
        'waveMode': context.waveMode?.name,
        'recommendationGenerationId': context.recommendationGenerationId,
        'recommendationSessionId': context.recommendationSessionId,
        if (context.offlineMixGeneration != null)
          'offlineMixGeneration': context.offlineMixGeneration,
        if (context.fromDownloads) 'fromDownloads': true,
      }, decodePlayContext);

  static PlayContext decodePlayContext(Object? value) {
    final row = _object(value, {
      'surface',
      'waveMode',
      'recommendationGenerationId',
      'recommendationSessionId',
      'offlineMixGeneration',
      'fromDownloads',
    });
    final fromDownloads = row['fromDownloads'];
    if (fromDownloads != null && fromDownloads is! bool) _fail();
    int? offlineGeneration;
    final offline = row['offlineMixGeneration'];
    if (offline != null) {
      if (offline is! int ||
          offline < 1 ||
          offline > 9007199254740991 ||
          row['surface'] != PlaySurface.library.name) {
        _fail();
      }
      offlineGeneration = offline;
    }
    return PlayContext(
      surface: _enum(row['surface'], PlaySurface.values),
      waveMode: row['waveMode'] == null
          ? null
          : _enum(row['waveMode'], WaveMode.values),
      recommendationGenerationId: _optionalIdentity(
        row['recommendationGenerationId'],
      ),
      recommendationSessionId: _optionalIdentity(
        row['recommendationSessionId'],
      ),
      offlineMixGeneration: offlineGeneration,
      fromDownloads: fromDownloads == true,
    );
  }

  static Map<String, Object?> encodeQueueEntry(QueueEntry entry) => _checked({
    'entryId': entry.entryId,
    'track': encodeTrack(entry.track),
    'context': encodePlayContext(entry.context),
    if (entry.standardAudio) 'standardAudio': true,
  }, decodeQueueEntry);

  static QueueEntry decodeQueueEntry(Object? value) {
    final row = _object(value, {
      'entryId',
      'track',
      'context',
      'standardAudio',
    });
    final standardAudio = row['standardAudio'];
    if (standardAudio != null && standardAudio is! bool) _fail();
    return QueueEntry(
      entryId: _text(row['entryId'], max: 256),
      track: decodeTrack(row['track']),
      context: decodePlayContext(row['context']),
      standardAudio: standardAudio == true,
    );
  }

  static Map<String, Object?> _checked(
    Map<String, Object?> value,
    Object Function(Object?) decode,
  ) {
    decode(value);
    return value;
  }

  static Never _fail() =>
      throw const FormatException('Invalid persisted music metadata');
  static Map<String, Object?> _object(Object? value, Set<String> keys) {
    if (value is! Map ||
        value.keys.any((key) => key is! String || !keys.contains(key))) {
      _fail();
    }
    return value.cast<String, Object?>();
  }

  static String _text(
    Object? value, {
    int max = maxTextLength,
    bool allowEmpty = false,
  }) {
    if (value is! String ||
        (!allowEmpty && value.trim().isEmpty) ||
        value.length > max ||
        RegExp(r'[\x00-\x1f\x7f]').hasMatch(value)) {
      _fail();
    }
    return value;
  }

  static String? _optionalText(Object? value, {int max = maxTextLength}) =>
      value == null ? null : _text(value, max: max);
  static String _identity(Object? value) {
    final id = _text(value, max: 512);
    if (id.trim() != id ||
        id.contains('/') ||
        id.contains('\\') ||
        id.contains('?') ||
        id.contains('#')) {
      _fail();
    }
    return id;
  }

  static String? _optionalIdentity(Object? value) =>
      value == null ? null : _identity(value);
  static double _number(Object? value) {
    if (value is! num || !value.isFinite) _fail();
    return value.toDouble();
  }

  static double? _optionalNumber(Object? value) =>
      value == null ? null : _number(value);
  static int _integer(Object? value, {required int max}) {
    if (value is! int || value < 0 || value > max) _fail();
    return value;
  }

  static bool _boolean(Object? value) {
    if (value is! bool) _fail();
    return value;
  }

  static T _enum<T extends Enum>(Object? value, List<T> values) {
    for (final candidate in values) {
      if (candidate.name == value) return candidate;
    }
    _fail();
  }
}
