import '../../core/model/app_failure.dart';
import '../../core/model/track.dart';
import '../library/library_models.dart';
import '../likes/likes_models.dart';
import '../likes/preference_controller.dart';
import 'catalog_detail_controller.dart';
import 'catalog_models.dart';

/// A client batch is an explicit selection of loaded, exact supported refs.
/// Unloaded entities never acquire an implied whole-collection mutation.
final class CatalogLikeSelection {
  CatalogLikeSelection(CatalogDetail detail, PreferenceController preferences)
    : loadedPositions = detail.tracks.length,
      tracks = List.unmodifiable(_supported(detail.tracks, preferences));
  static const maxBatch = 100;
  final int loadedPositions;
  final List<Track> tracks;
  static Iterable<Track> _supported(
    Iterable<Track> tracks,
    PreferenceController preferences,
  ) sync* {
    final seen = <String>{};
    for (final track in tracks) {
      if (track.playable &&
          preferences.supports(track.ref, PreferenceSignal.like) &&
          seen.add(track.ref.identityKey)) {
        yield track;
      }
    }
  }
}

final class CatalogLikeResult {
  const CatalogLikeResult({
    required this.requested,
    required this.succeeded,
    required this.failed,
  });
  final int requested, succeeded, failed;
  String get message =>
      'Добавлено в любимое: $succeeded из $requested.${failed == 0 ? '' : ' Не удалось: $failed.'}';
}

extension CatalogCollectionLikes on CatalogDetailController {
  /// The shared controller remains the sole preference authority. This layer
  /// supplies sequential bounded orchestration, never a fabricated bulk route.
  Future<CatalogLikeResult> likeLoaded({
    required CatalogDetail detail,
    required int expectedRevision,
    required PreferenceController preferences,
    required Iterable<Track> selected,
  }) async {
    final captured = List<Track>.unmodifiable(selected);
    bool current() =>
        isCurrent &&
        revision == expectedRevision &&
        identical(state.detail, detail) &&
        preferences.isCurrent &&
        preferences.fence == fence;
    Future<void> guard() async {
      if (!current()) throw collectionStaleSession;
      await repository.guard();
      if (!current()) throw collectionStaleSession;
    }

    await guard();
    repository.networkPolicy.requireNetwork();
    preferences.networkPolicy.requireNetwork();
    final allowed = {
      for (final track in CatalogLikeSelection(detail, preferences).tracks)
        track.ref.identityKey: track,
    };
    final seen = <String>{};
    final tracks = <Track>[];
    for (final track in captured) {
      final exact = allowed[track.ref.identityKey];
      if (exact == null || exact.ref != track.ref) {
        throw const AppFailure(
          code: 'invalid_like_selection',
          message: 'Выберите доступные загруженные треки.',
        );
      }
      if (seen.add(exact.ref.identityKey)) tracks.add(exact);
    }
    if (tracks.isEmpty || tracks.length > CatalogLikeSelection.maxBatch) {
      throw const AppFailure(
        code: 'invalid_like_selection',
        message: 'Выберите от 1 до 100 треков.',
      );
    }
    var succeeded = 0, failed = 0;
    for (final track in tracks) {
      await guard();
      try {
        await preferences.set(track.ref, PreferenceSignal.like);
        await guard();
        succeeded++;
      } catch (error) {
        if (!current()) throw collectionStaleSession;
        failed++;
      }
    }
    await guard();
    return CatalogLikeResult(
      requested: tracks.length,
      succeeded: succeeded,
      failed: failed,
    );
  }
}
