import '../../core/model/app_failure.dart';
import '../../core/model/owner_key.dart';
import '../../core/model/play_context.dart';
import '../../core/model/track.dart';

enum SavedEntityKind { album, artist }

/// Exact saved collection identity. Saving never likes or downloads tracks.
final class SavedEntityRef {
  const SavedEntityRef({
    required this.kind,
    required this.source,
    required this.entityId,
    required this.title,
    this.subtitle,
    this.image,
  });
  final SavedEntityKind kind;
  final String source;
  final String entityId;
  final String title;
  final String? subtitle;
  final Uri? image;
  String get identityKey => '${kind.name}:$source:$entityId';
  Map<String, String> get identity => {
    'type': kind.name,
    'source': source,
    'entityId': entityId,
  };
  Map<String, Object?> get payload => {
    ...identity,
    'title': title,
    if (subtitle != null) 'subtitle': subtitle,
    if (image != null) 'imageUrl': image.toString(),
  };
}

final class LibraryPlaylist {
  const LibraryPlaylist({
    required this.id,
    required this.name,
    required this.trackCount,
    this.isOwner = false,
  });
  final String id;
  final String name;
  final int trackCount;
  final bool isOwner;
}

final class SavedEntityPage {
  SavedEntityPage({
    required Iterable<SavedEntityRef> items,
    required this.total,
    required this.offset,
  }) : items = List.unmodifiable(items);
  final List<SavedEntityRef> items;
  final int total;
  final int offset;
  bool get hasMore => offset + items.length < total;
}

/// Sections can fail independently without disguising missing data as empty.
final class LibraryCollection {
  LibraryCollection({
    Iterable<SavedEntityRef> saved = const [],
    Iterable<LibraryPlaylist> playlists = const [],
    this.totalSaved = 0,
    this.savedFailure,
    this.playlistsFailure,
    this.hasMoreSaved = false,
  }) : saved = List.unmodifiable(saved),
       playlists = List.unmodifiable(playlists);
  final List<SavedEntityRef> saved;
  final List<LibraryPlaylist> playlists;
  final int totalSaved;
  final bool hasMoreSaved;
  final AppFailure? savedFailure;
  final AppFailure? playlistsFailure;
  bool get degraded => savedFailure != null || playlistsFailure != null;
}

/// Composition admits this exact displayed order using its captured fence.
final class CollectionPlaybackRequest {
  CollectionPlaybackRequest({
    required Iterable<Track> tracks,
    required this.startIndex,
    required this.fence,
    this.shuffle = false,
    this.context = const PlayContext(surface: PlaySurface.library),
  }) : tracks = List.unmodifiable(tracks) {
    if (this.tracks.isEmpty ||
        startIndex < 0 ||
        startIndex >= this.tracks.length ||
        this.tracks.any((t) => !t.playable)) {
      throw ArgumentError('Invalid collection playback');
    }
  }
  final List<Track> tracks;
  final int startIndex;
  final SessionFence fence;
  final bool shuffle;
  final PlayContext context;
}

/// Never expose raw exceptions or server body text in feature UI.
AppFailure collectionFailure(Object error) => error is AppFailure
    ? error
    : const AppFailure(
        code: 'collection_failed',
        message: 'Не удалось загрузить музыку. Проверьте подключение и повторите попытку.',
        retryable: true,
      );

const collectionStaleSession = AppFailure(
  code: 'stale_session',
  message: 'Аккаунт изменился. Откройте раздел снова.',
);

/// Strict response helpers shared by the collection endpoint adapters.
Map<String, Object?> collectionObject(Object? value) {
  if (value is! Map || value.keys.any((key) => key is! String)) {
    throw const AppFailure(
      code: 'invalid_collection',
      message: 'Сервер вернул некорректные данные коллекции.',
    );
  }
  return value.cast<String, Object?>();
}

String collectionString(Object? value) {
  if (value is! String || value.isEmpty) {
    throw const AppFailure(
      code: 'invalid_collection',
      message: 'Сервер вернул некорректные данные коллекции.',
    );
  }
  return value;
}

int collectionCount(Object? value) {
  if (value is! int || value < 0) {
    throw const AppFailure(
      code: 'invalid_collection',
      message: 'Сервер вернул некорректное число записей.',
    );
  }
  return value;
}

List<Object?> collectionList(Object? value) {
  if (value is! List) {
    throw const AppFailure(
      code: 'invalid_collection',
      message: 'Сервер вернул некорректный список.',
    );
  }
  return value;
}
