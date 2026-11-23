import '../model/track_ref.dart';
import '../../playback/resolved_media.dart';

/// Routes are generated from durable identities, then rechecked before *every*
/// credential grant, including a remembered lease and every redirect hop.
final class RedirectPolicy {
  static final leasePattern = RegExp(
    r'^/api/music-sources/leases/[a-f0-9]{48}/stream$',
  );
  static String recordingPath(NativeTrackRef ref) =>
      '/api/music-sources/recordings/${ref.recording.provider.name}/${ref.recording.id}/stream';
  static String identityPath(TrackRef ref) => switch (ref) {
    NativeTrackRef() => recordingPath(ref),
    LibraryTrackRef() => '/api/library/tracks/${_id(ref.libraryId)}/stream',
    YoutubeTrackRef() =>
      '/api/${ref.youtubeKind == YoutubeKind.music ? 'ytmusic' : 'youtube'}/stream/${_videoId(ref.videoId)}',
    _ => throw invalidMedia,
  };
  static String _id(String id) {
    if (id.isEmpty ||
        id.length > 256 ||
        !RegExp(r'^[a-zA-Z0-9_-]+$').hasMatch(id)) {
      throw invalidMedia;
    }
    return id;
  }

  static String _videoId(String id) {
    if (!RegExp(r'^[a-zA-Z0-9_-]{11}$').hasMatch(id)) throw invalidMedia;
    return id;
  }

  static void validate(Uri uri, ResolvedMedia media) {
    final origin = media.fence.owner.serverOrigin;
    final raw = uri.toString();
    if (raw.length > 2048 ||
        RegExp(r'[\\\x00-\x20\x7f@%]').hasMatch(raw) ||
        uri.scheme != 'https' ||
        uri.host != origin.host ||
        uri.port != origin.port ||
        uri.userInfo.isNotEmpty ||
        uri.hasFragment ||
        uri.host.endsWith('.')) {
      throw invalidMedia;
    }
    if (leasePattern.hasMatch(uri.path)) {
      if (uri.hasQuery) throw invalidMedia;
      return;
    }
    if (uri.path != identityPath(media.ref)) throw invalidMedia;
    final allowed = switch (media.ref) {
      LibraryTrackRef() => {'quality'},
      YoutubeTrackRef(youtubeKind: YoutubeKind.music) => {
        'quality',
        'purpose',
        'playbackSession',
      },
      YoutubeTrackRef() => {'quality'},
      _ => <String>{},
    };
    for (final entry in uri.queryParametersAll.entries) {
      if (!allowed.contains(entry.key) || entry.value.length != 1) {
        throw invalidMedia;
      }
      final value = entry.value.single;
      if (entry.key == 'quality' &&
          !const {
            'original',
            'low',
            'medium',
            'high',
            'lossless',
            'LOW',
            'MEDIUM',
            'HIGH',
            'LOSSLESS',
          }.contains(value)) {
        throw invalidMedia;
      }
      if (entry.key == 'purpose' && value != 'preload') throw invalidMedia;
      if (entry.key == 'playbackSession' &&
          !RegExp(r'^[a-zA-Z0-9_-]{16,128}$').hasMatch(value)) {
        throw invalidMedia;
      }
    }
  }

  static Uri redirect(Uri current, String location, ResolvedMedia media) {
    if (location.length > 2048 ||
        location.contains(RegExp(r'[\\\x00-\x20\x7f@%]'))) {
      throw invalidMedia;
    }
    final next = current.resolve(location);
    validate(next, media);
    if (!leasePattern.hasMatch(next.path)) throw invalidMedia;
    return next;
  }
}
