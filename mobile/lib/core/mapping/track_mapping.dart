import '../model/app_failure.dart';
import '../model/track.dart';
import '../model/track_ref.dart';

/// Shared scalar/identity validation only. Endpoint mappers select their own
/// display fields before calling [buildTrack].
final class TrackFields {
  const TrackFields(this.endpoint);
  final String endpoint;

  Never fail(String path) =>
      throw MappingFailure(endpoint: endpoint, path: path);

  Map<String, Object?> object(Object? value, String path) {
    if (value is! Map || value.keys.any((key) => key is! String)) fail(path);
    return value.cast<String, Object?>();
  }

  String string(Object? value, String path, {bool nonempty = false}) {
    if (value is! String || (nonempty && value.trim().isEmpty)) fail(path);
    return value;
  }

  String? optionalString(Object? value, String path) =>
      value == null ? null : string(value, path);

  double? number(Object? value, String path) {
    if (value == null) return null;
    if (value is! num || !value.isFinite) fail(path);
    return value.toDouble();
  }

  bool? boolean(Object? value, String path) {
    if (value == null) return null;
    if (value is! bool) fail(path);
    return value;
  }

  int? integer(Object? value, String path) {
    if (value == null) return null;
    if (value is! int) fail(path);
    return value;
  }

  Duration? duration(Object? value) {
    final seconds = number(value, 'duration');
    if (seconds == null) return null;
    final microseconds = seconds * Duration.microsecondsPerSecond;
    // Duration stores a signed 64-bit count. This is a representation check,
    // not a provider admission or song-length policy.
    if (seconds < 0 ||
        !microseconds.isFinite ||
        microseconds >= 9223372036854775807.toDouble()) {
      fail('duration');
    }
    return Duration(microseconds: microseconds.round());
  }

  Uri? artwork(Object? value, String path) {
    final text = optionalString(value, path);
    if (text == null || text.isEmpty) return null;
    final parsed = Uri.tryParse(text);
    if (parsed == null) fail(path);
    return parsed;
  }

  MusicRecording recording(Object? value) {
    final row = object(value, 'musicSourceRecording');
    if (row['preview'] != false) fail('musicSourceRecording.preview');
    if (row.containsKey('isrc') && row['isrc'] == null) {
      fail('musicSourceRecording.isrc');
    }
    final artists = row['artists'];
    if (artists is! List || artists.any((artist) => artist is! String)) {
      fail('musicSourceRecording.artists');
    }
    final provider = switch (row['provider']) {
      'vk' => NativeMusicProvider.vk,
      'yandex' => NativeMusicProvider.yandex,
      _ => fail('musicSourceRecording.provider'),
    };
    final version = switch (row['contentVersion']) {
      'explicit' => MusicContentVersion.explicit,
      'clean' => MusicContentVersion.clean,
      'unknown' => MusicContentVersion.unknown,
      _ => fail('musicSourceRecording.contentVersion'),
    };
    final seconds = number(row['duration'], 'musicSourceRecording.duration');
    if (seconds == null) fail('musicSourceRecording.duration');
    try {
      return MusicRecording(
        provider: provider,
        id: string(row['id'], 'musicSourceRecording.id', nonempty: true),
        title: string(
          row['title'],
          'musicSourceRecording.title',
          nonempty: true,
        ),
        artists: artists.cast<String>(),
        durationSeconds: seconds,
        contentVersion: version,
        isrc: optionalString(row['isrc'], 'musicSourceRecording.isrc'),
      );
    } on ArgumentError {
      fail('musicSourceRecording');
    }
  }

  /// Validate reserved native claims before any local/legacy fallback, mirroring
  /// readNativeRecommendationRecording/readMusicSourcePlaybackTrack.
  TrackRef reference(Map<String, Object?> row, String title, String artist) {
    final id = string(row['id'], 'id', nonempty: true);
    final provider = row['provider'] == null
        ? <String, Object?>{}
        : object(row['provider'], 'provider');
    final sources = [
      row['source'],
      row['streamSource'],
      row['mediaSource'],
      provider['source'],
    ];
    for (final source in sources) {
      if (source != null && source is! String) fail('source');
    }
    final native =
        sources.any((source) => source == 'vk' || source == 'yandex') ||
        row['musicSourceRecording'] != null ||
        RegExp(r'^(vk|yandex):').hasMatch(id);
    if (native) {
      final exact = recording(row['musicSourceRecording']);
      final source = exact.provider.name;
      if (row['source'] != source ||
          row['streamSource'] != source ||
          (row['mediaSource'] != null && row['mediaSource'] != source) ||
          provider['source'] != source ||
          provider['providerTrackId'] != exact.id ||
          id != exact.identityKey ||
          provider['youtubeVideoId'] != null ||
          provider['tidalTrackId'] != null ||
          row['youtubeVideoId'] != null ||
          row['tidalTrackId'] != null ||
          title != exact.title ||
          artist != exact.artists.join(', ') ||
          row['duration'] != exact.durationSeconds) {
        fail('musicSourceRecording.identity');
      }
      return NativeTrackRef(exact);
    }

    final source =
        provider['source'] ??
        row['mediaSource'] ??
        row['streamSource'] ??
        row['source'];
    final filePath = optionalString(row['filePath'], 'filePath');
    if (row['source'] == 'library' ||
        row['source'] == 'local' ||
        row['source'] == 'federated' ||
        source == 'local' ||
        source == 'library' ||
        source == 'federated' ||
        row['hasLocalFile'] == true ||
        (filePath != null && filePath.trim().isNotEmpty)) {
      return LibraryTrackRef(id);
    }

    final videoId = optionalString(
      provider['youtubeVideoId'] ?? row['youtubeVideoId'],
      'youtubeVideoId',
    )?.trim();
    final prefixedVideo = id.startsWith('yt:') ? id.substring(3) : null;
    final explicitYoutube = source == 'youtube' || source == 'youtube-direct';
    final activeYoutube =
        explicitYoutube &&
        ((videoId != null && videoId.isNotEmpty) ||
            (prefixedVideo != null &&
                prefixedVideo.isNotEmpty &&
                !prefixedVideo.startsWith('missing:')));
    if (!activeYoutube &&
        (source == 'tidal' ||
            row['source'] == 'tidal' ||
            id.startsWith('tidal:') ||
            provider['tidalTrackId'] != null ||
            row['tidalTrackId'] != null)) {
      return UnavailableTrackRef(id, reason: 'retired_provider');
    }
    if (source != null && !explicitYoutube) {
      return UnavailableTrackRef(id, reason: 'unsupported_source');
    }
    if (source == 'youtube' ||
        source == 'youtube-direct' ||
        (videoId != null && videoId.isNotEmpty) ||
        prefixedVideo != null) {
      final video = videoId?.isNotEmpty == true ? videoId! : prefixedVideo;
      if (video == null || video.isEmpty || video.startsWith('missing:')) {
        return UnavailableTrackRef(id, reason: 'missing_youtube_video_id');
      }
      return YoutubeTrackRef(
        video,
        youtubeKind: source == 'youtube-direct'
            ? YoutubeKind.regular
            : YoutubeKind.music,
      );
    }
    return LibraryTrackRef(id);
  }

  Track buildTrack(
    Map<String, Object?> row, {
    required String title,
    required String artist,
    String? artistId,
    String? album,
    String? albumId,
    Uri? cover,
    double? albumLoudnessLufs,
    double? albumTruePeakDb,
    bool playbackAllowed = true,
    String? unavailableReason,
  }) {
    final ref = reference(row, title, artist);
    final trackDuration = duration(row['duration']);
    final peer = row['peer'] == null ? null : object(row['peer'], 'peer');
    // /library/liked omits peer even for ACTIVE peers. Only an explicit
    // offline capability can block playback; absence is not offline evidence.
    final peerOffline =
        row['source'] == 'federated' && peer?['online'] == false;
    final reason =
        unavailableReason ??
        (ref is UnavailableTrackRef ? ref.reason : null) ??
        (peerOffline ? 'peer_offline' : null);
    final content = ref is NativeTrackRef ? ref.recording.contentVersion : null;
    return Track(
      ref: ref,
      title: title,
      artist: artist,
      artistId: artistId,
      album: album,
      albumId: albumId,
      artwork: cover,
      duration: trackDuration,
      explicit: content == MusicContentVersion.explicit
          ? true
          : content == MusicContentVersion.clean
          ? false
          : boolean(row['explicit'], 'explicit'),
      trackNo: integer(row['trackNo'], 'trackNo'),
      loudnessLufs: number(row['loudnessLufs'], 'loudnessLufs'),
      truePeakDb: number(row['truePeakDb'], 'truePeakDb'),
      albumLoudnessLufs: albumLoudnessLufs,
      albumTruePeakDb: albumTruePeakDb,
      recommendationGenerationId: optionalString(
        row['recommendationGenerationId'],
        'recommendationGenerationId',
      ),
      playbackAllowed: playbackAllowed && !peerOffline,
      unavailableReason: reason,
    );
  }
}
