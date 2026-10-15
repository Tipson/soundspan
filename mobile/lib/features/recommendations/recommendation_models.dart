import '../../core/model/track.dart';
import '../../core/model/track_ref.dart';

/// A server-owned feed page. Cursor and lineage are never manufactured locally.
final class RecommendationPage {
  RecommendationPage({
    required Iterable<Track> tracks,
    this.nextCursor,
    this.generationId,
    this.reason,
    this.languagePending = false,
  }) : tracks = List.unmodifiable(tracks);
  final List<Track> tracks;
  final int? nextCursor;
  final String? generationId;
  final String? reason;
  final bool languagePending;
  bool get temporaryFailure =>
      reason == 'provider_partial_failure' ||
      reason == 'provider_unavailable' ||
      languagePending;
}

String? continuationIdentity(TrackRef ref) => switch (ref) {
  YoutubeTrackRef(:final videoId) => videoId,
  LibraryTrackRef(:final libraryId) => libraryId,
  NativeTrackRef() => ref.identityKey,
  UnavailableTrackRef() => null,
};

Map<String, Object?>? impressionIdentity(TrackRef ref) => switch (ref) {
  YoutubeTrackRef(:final videoId) => {
    'provider': 'youtube',
    'providerTrackId': videoId,
  },
  LibraryTrackRef(:final libraryId) => {
    'provider': 'library',
    'providerTrackId': libraryId,
  },
  NativeTrackRef(:final recording) => {
    'provider': recording.provider.name,
    'providerTrackId': recording.id,
  },
  UnavailableTrackRef() => null,
};
