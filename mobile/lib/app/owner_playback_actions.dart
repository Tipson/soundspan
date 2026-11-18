import 'dart:async';

import '../core/model/owner_key.dart';
import '../core/model/app_failure.dart';
import '../core/model/track.dart';
import '../core/session/session_authority.dart';
import '../features/library/library_models.dart';
import '../playback/playback_controller.dart';

/// Collection order and occurrence selection flow unchanged into the service.
final class OwnerPlaybackActions {
  OwnerPlaybackActions({
    required this.authority,
    required this.fence,
    required this.playback,
    required this.isCurrent,
    required this.prefetch,
    this.beforeIntent,
  });
  final SessionAuthority authority;
  final SessionFence fence;
  final PlaybackController playback;
  final bool Function() isCurrent;
  final Future<void> Function(Iterable<Track>) prefetch;
  final void Function()? beforeIntent;
  Future<void> guard() async {
    if (!isCurrent()) throw collectionStaleSession;
    try {
      await authority.assertCurrent(fence).timeout(const Duration(seconds: 10));
    } on TimeoutException {
      if (!isCurrent()) throw collectionStaleSession;
      throw const AppFailure(
        code: 'playback_admission_timeout',
        message: 'Не удалось начать воспроизведение. Повторите попытку',
        retryable: true,
      );
    }
    if (!isCurrent()) throw collectionStaleSession;
  }

  void _prefetch(Iterable<Track> tracks) {
    unawaited(
      Future<void>.sync(() => prefetch(tracks)).catchError((Object _) {
        // Cover availability must not delay or reject an audio command.
      }),
    );
  }

  Future<void> play(CollectionPlaybackRequest request) async {
    if (request.fence != fence) throw collectionStaleSession;
    if (!isCurrent()) throw collectionStaleSession;
    beforeIntent?.call();
    final lineage = playback.snapshot.lineage;
    await guard();
    _prefetch(request.tracks.skip(request.startIndex).take(6));
    await guard();
    if (playback.snapshot.lineage != lineage) throw collectionStaleSession;
    final entries = playback.createEntries(request.tracks, request.context);
    await playback.dispatch(
      ReplaceQueue(
        entries,
        fence: fence,
        expectedLineage: lineage,
        initialEntryId: entries[request.startIndex].entryId,
      ),
    );
    await guard();
    // A different admitted replacement must not inherit this collection's mode.
    final snapshot = playback.snapshot;
    final entryIds = entries.map((e) => e.entryId).toSet();
    if (snapshot.entries.length == entries.length &&
        snapshot.entries.every((e) => entryIds.contains(e.entryId))) {
      await playback.dispatch(SetShuffle(request.shuffle));
    }
  }

  Future<void> enqueue(List<Track> tracks, SessionFence original) async {
    if (original != fence) throw collectionStaleSession;
    if (!isCurrent()) throw collectionStaleSession;
    beforeIntent?.call();
    final lineage = playback.snapshot.lineage;
    await guard();
    _prefetch(tracks.take(6));
    await guard();
    await playback.dispatch(
      Enqueue(
        playback.createEntries(
          tracks,
          const PlayContext(surface: PlaySurface.library),
        ),
        fence: fence,
        expectedLineage: lineage,
      ),
    );
  }
}
