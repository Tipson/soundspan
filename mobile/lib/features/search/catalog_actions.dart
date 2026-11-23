import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/model/track.dart';
import '../../core/model/owner_key.dart';
import '../../design_system/design_system.dart';
import '../likes/preference_controller.dart';
import '../likes/likes_models.dart';
import '../library/library_controller.dart';
import 'catalog_models.dart';

typedef CatalogTrackAction = FutureOr<void> Function(
  List<Track> tracks,
  SessionFence fence,
);
typedef CatalogRadioAction = FutureOr<void> Function(
  Track track,
  SessionFence fence,
);
typedef CatalogShareAction = FutureOr<void> Function(
  CatalogEntityRef entity,
  SessionFence fence,
);

/// Only completed capabilities are supplied by composition. Null hides the row.
final class CatalogActions {
  const CatalogActions({
    this.enqueueNext,
    this.enqueueEnd,
    this.addToPlaylist,
    this.download,
    this.radio,
    this.share,
    this.preferences,
    this.library,
  });
  final CatalogTrackAction? enqueueNext, enqueueEnd, addToPlaylist, download;
  final CatalogRadioAction? radio;
  final CatalogShareAction? share;
  final PreferenceController? preferences;
  final LibraryController? library;
  bool get hasTrackActions =>
      enqueueNext != null ||
      enqueueEnd != null ||
      addToPlaylist != null ||
      download != null ||
      radio != null ||
      preferences != null;
}

/// Unknown preference is read through the shared authority before labelling the
/// toggle. The caller's owner/entity guard is checked again after that await.
Future<void> showCatalogTrackSheet(
  BuildContext context, {
  required CatalogActions actions,
  required Track track,
  required SessionFence fence,
  required bool Function() isCurrent,
  required Future<void> Function(FutureOr<void> Function()) run,
}) async {
  if (!isCurrent() || !context.mounted) return;
  final preferences = actions.preferences;
  if (preferences != null &&
      preferences.fence == fence &&
      preferences.canMutate &&
      preferences.current(track.ref).signal == null) {
    try {
      await preferences.load(track.ref);
    } catch (error) {
      if (isCurrent()) await run(() async => throw error);
    }
  }
  if (!isCurrent() || !context.mounted) return;
  await MusicActionSheet.show(
    context,
    catalogTrackActions(actions: actions, track: track, fence: fence, run: run),
    title: track.title,
  );
}

List<MusicAction> catalogTrackActions({
  required CatalogActions actions,
  required Track track,
  required SessionFence fence,
  required Future<void> Function(FutureOr<void> Function()) run,
}) => [
  if (track.playable) ...[
    if (actions.preferences case final preferences?
        when preferences.fence == fence && preferences.isCurrent) ...[
      MusicAction(
        id: 'like',
        label: preferences.current(track.ref).signal == PreferenceSignal.like
            ? 'Убрать из любимого'
            : 'Нравится',
        icon: Icons.favorite_outline,
        onSelected: () => run(() async {
          if (!preferences.isCurrent || preferences.fence != fence) return;
          await preferences.set(
            track.ref,
            preferences.current(track.ref).signal == PreferenceSignal.like
                ? PreferenceSignal.clear
                : PreferenceSignal.like,
          );
        }),
      ),
    ],
    if (actions.enqueueNext case final action?)
      MusicAction(
        id: 'next',
        label: 'Слушать следующим',
        icon: Icons.playlist_play,
        onSelected: () => run(() => action([track], fence)),
      ),
    if (actions.enqueueEnd case final action?)
      MusicAction(
        id: 'queue',
        label: 'В конец очереди',
        icon: Icons.queue_music,
        onSelected: () => run(() => action([track], fence)),
      ),
    if (actions.addToPlaylist case final action?)
      MusicAction(
        id: 'playlist',
        label: 'Добавить в плейлист',
        icon: Icons.playlist_add,
        onSelected: () => run(() => action([track], fence)),
      ),
    if (actions.download case final action?)
      MusicAction(
        id: 'download',
        label: 'Скачать на устройство',
        icon: Icons.download_outlined,
        onSelected: () => run(() => action([track], fence)),
      ),
    if (actions.radio case final action?)
      MusicAction(
        id: 'radio',
        label: 'Радио по треку',
        icon: Icons.radio_outlined,
        onSelected: () => run(() => action(track, fence)),
      ),
  ],
];
