import 'music_recording.dart';
export 'music_recording.dart';

/// Route choice for the same exact YouTube recording, never a replacement ID.
enum YoutubeKind { music, regular }

/// Durable music identity, separate from ephemeral media representations.
sealed class TrackRef {
  const TrackRef();

  String get identityKey;
  bool get playable => true;

  @override
  bool operator ==(Object other) =>
      other is TrackRef &&
      runtimeType == other.runtimeType &&
      identityKey == other.identityKey;

  @override
  int get hashCode => Object.hash(runtimeType, identityKey);
}

final class LibraryTrackRef extends TrackRef {
  const LibraryTrackRef(this.libraryId);
  final String libraryId;
  @override
  String get identityKey => 'library:$libraryId';
}

final class YoutubeTrackRef extends TrackRef {
  const YoutubeTrackRef(this.videoId, {this.youtubeKind = YoutubeKind.music});
  final String videoId;
  final YoutubeKind youtubeKind;
  @override
  String get identityKey => 'yt:$videoId';
}

final class NativeTrackRef extends TrackRef {
  const NativeTrackRef(this.recording);
  final MusicRecording recording;
  @override
  String get identityKey => recording.identityKey;
}

/// Retained, unresolved or unsupported row. Its identity cannot resolve media.
final class UnavailableTrackRef extends TrackRef {
  const UnavailableTrackRef(this.identityKey, {required this.reason});
  @override
  final String identityKey;
  final String reason;
  @override
  bool get playable => false;
}
