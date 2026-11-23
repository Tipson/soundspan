import '../../core/model/app_failure.dart';
import '../../core/model/owner_key.dart';
import '../../core/model/track.dart';
import '../../core/model/track_ref.dart';

/// Cursor bytes are opaque: never derive them from a displayed TrackRef.
final class LikedCursor {
  const LikedCursor({required this.likedAt, required this.trackId});
  final String likedAt;
  final String trackId;
  @override
  bool operator ==(Object other) =>
      other is LikedCursor &&
      likedAt == other.likedAt &&
      trackId == other.trackId;
  @override
  int get hashCode => Object.hash(likedAt, trackId);
}

final class LikedPage {
  LikedPage({
    required Iterable<Track> tracks,
    required this.total,
    required this.hasMore,
    this.nextCursor,
  }) : tracks = List.unmodifiable(tracks);
  final List<Track> tracks;
  final int total;
  final bool hasMore;
  final LikedCursor? nextCursor;
}

enum PreferenceSignal { like, dislike, clear }

/// A server-confirmed mutation for the original account, never optimistic UI.
final class PreferenceChange {
  const PreferenceChange({
    required this.ref,
    required this.signal,
    required this.fence,
  });
  final TrackRef ref;
  final PreferenceSignal signal;
  final SessionFence fence;
}

extension PreferenceSignalWire on PreferenceSignal {
  String get wire => switch (this) {
    PreferenceSignal.like => 'thumbs_up',
    PreferenceSignal.dislike => 'thumbs_down',
    PreferenceSignal.clear => 'clear',
  };
}

/// Null signal means unknown, rather than falsely claiming a neutral server.
final class PreferenceState {
  const PreferenceState({this.signal, this.pending = false, this.failure});
  final PreferenceSignal? signal;
  final bool pending;
  final AppFailure? failure;
}

final class LikesState {
  LikesState({
    Iterable<Track> tracks = const [],
    this.total = 0,
    this.loading = false,
    this.loadingMore = false,
    this.hasMore = false,
    this.failure,
    this.stale = false,
  }) : tracks = List.unmodifiable(tracks);
  final List<Track> tracks;
  final int total;
  final bool loading;
  final bool loadingMore;
  final bool hasMore;
  final AppFailure? failure;
  final bool stale;
}
