import '../../core/model/app_failure.dart';
import '../../core/model/track.dart';
import '../../core/model/track_ref.dart';
import '../library/library_models.dart';

/// Server supports names and privacy; descriptions have no persisted contract.
final class PlaylistDraft {
  const PlaylistDraft({required this.name, this.isPublic = false});
  final String name;
  final bool isPublic;
  Map<String, Object?> get payload => {
    'name': playlistName(name),
    'isPublic': isPublic,
  };
}

final class PlaylistPatch {
  const PlaylistPatch({this.name, this.isPublic});
  final String? name;
  final bool? isPublic;
  Map<String, Object?> get payload => {
    if (name != null) 'name': playlistName(name!),
    if (isPublic != null) 'isPublic': isPublic,
  };
}

String playlistName(String value) {
  final name = value.trim();
  if (name.isEmpty || name.length > 200) {
    throw const AppFailure(
      code: 'invalid_playlist_name',
      message: 'Введите название длиной от 1 до 200 символов.',
    );
  }
  return name;
}

final class PlaylistSummary {
  const PlaylistSummary({
    required this.id,
    required this.name,
    required this.isOwner,
    required this.isPublic,
    required this.isHidden,
    required this.trackCount,
  });
  final String id, name;
  final bool isOwner, isPublic, isHidden;
  final int trackCount;
  factory PlaylistSummary.fromJson(Map<String, Object?> dto) => PlaylistSummary(
    id: collectionString(dto['id']),
    name: collectionString(dto['name']),
    isOwner: dto['isOwner'] == true,
    isPublic: dto['isPublic'] == true,
    isHidden: dto['isHidden'] == true,
    trackCount: dto['trackCount'] == null
        ? 0
        : collectionCount(dto['trackCount']),
  );
}

/// Item identity is independent of recording identity; pending rows stay ordered.
final class PlaylistItem {
  const PlaylistItem({
    required this.id,
    required this.sort,
    required this.track,
    this.pending = false,
  });
  final String id;
  final int sort;
  final Track track;
  final bool pending;
  String? get reason => pending
      ? 'Ожидает сопоставления и импорта на сервере'
      : track.playable
      ? null
      : switch (track.unavailableReason) {
          'retired_provider' =>
            'Этот музыкальный сервис больше не поддерживается',
          'track_removed' => 'Запись удалена из серверной библиотеки',
          _ => 'Запись сейчас недоступна для воспроизведения',
        };
}

final class PlaylistPage {
  PlaylistPage({
    required this.playlist,
    required Iterable<PlaylistItem> items,
    required this.total,
    required this.hasMore,
    required this.nextCursor,
  }) : items = List.unmodifiable(items);
  final PlaylistSummary playlist;
  final List<PlaylistItem> items;
  final int total;
  final bool hasMore;
  final String? nextCursor;
}

final class PlaylistDetail {
  PlaylistDetail({
    required this.playlist,
    required Iterable<PlaylistItem> items,
    required this.total,
    required this.hasMore,
    required this.nextCursor,
  }) : items = List.unmodifiable(items);
  final PlaylistSummary playlist;
  final List<PlaylistItem> items;
  final int total;
  final bool hasMore;
  final String? nextCursor;
  bool get complete => !hasMore && total == items.length;
  String? get reorderBlockedReason => !playlist.isOwner
      ? 'Менять порядок может только владелец.'
      : !complete
      ? 'Сначала загрузите весь плейлист.'
      : total > 1000
      ? 'Сервер поддерживает сортировку плейлистов до 1000 записей.'
      : items.any((e) => e.pending)
      ? 'Сервер не поддерживает общий порядок ожидающих и готовых записей.'
      : null;
  PlaylistDetail withItems(Iterable<PlaylistItem> value) => PlaylistDetail(
    playlist: playlist,
    items: value,
    total: total,
    hasMore: hasMore,
    nextCursor: nextCursor,
  );
}

const playlistBusy = AppFailure(
  code: 'playlist_busy',
  message: 'Дождитесь завершения предыдущего изменения.',
);
const playlistUncertain = AppFailure(
  code: 'playlist_uncertain',
  message: 'Ответ на изменение потерян. Проверьте состояние плейлиста; повторная отправка заблокирована.',
);
const playlistForbidden = AppFailure(
  code: 'playlist_forbidden',
  message: 'Менять плейлист может только владелец.',
  statusCode: 403,
);

/// Preflight all rows before the first mutation; no provider substitution.
Map<String, Object?> playlistAddPayload(Track track) {
  if (!track.playable) {
    throw const AppFailure(
      code: 'playlist_unavailable',
      message: 'Недоступную запись нельзя добавить в плейлист.',
    );
  }
  return switch (track.ref) {
    LibraryTrackRef(:final libraryId) => {'trackId': libraryId},
    NativeTrackRef(:final recording) => {
      'musicSourceRecording': recording.toJson(),
    },
    YoutubeTrackRef(:final videoId) => {
      'youtubeVideoId': videoId,
      'title': track.title,
      'artist': track.artist,
      'album': (track.album?.trim().isNotEmpty ?? false)
          ? track.album
          : 'Single',
      'duration': track.duration?.inSeconds ?? 0,
    },
    _ => throw const AppFailure(
      code: 'playlist_persistence_unsupported',
      message: 'Сервер пока не сохраняет записи этого музыкального сервиса в плейлисты.',
    ),
  };
}

/// Queue occurrences cannot be silently collapsed by the server add endpoint.
void validatePlaylistQueue(List<Track> tracks) {
  if (tracks.isEmpty) {
    throw const AppFailure(code: 'empty_queue', message: 'Очередь пуста.');
  }
  final keys = <String>{};
  for (final track in tracks) {
    playlistAddPayload(track);
    if (!keys.add(track.ref.identityKey)) {
      throw const AppFailure(
        code: 'playlist_duplicates_unsupported',
        message: 'Сервер объединяет повторные записи. Сохранение этой очереди без потери повторов пока недоступно.',
      );
    }
  }
}
