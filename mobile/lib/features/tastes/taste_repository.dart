import '../../core/model/app_failure.dart';
import '../../core/network/api_transport.dart';
import '../library/library_models.dart';
import '../lyrics/lyrics_repository.dart';

const tasteGenres = [
  'Рок',
  'Альтернативный рок',
  'Метал',
  'Поп',
  'Хип-хоп',
  'Электроника',
  'Инди',
  'Классика',
  'Джаз',
  'Саундтреки',
  'Русская поп-музыка',
  'Русский рок',
  'Русский рэп',
  'R&B',
  'Соул',
  'K-pop',
  'J-pop',
  'Панк',
  'Постпанк',
  'Танцевальная',
  'Хаус',
  'Техно',
  'Drum and bass',
  'Трип-хоп',
  'Эмбиент',
  'Блюз',
  'Фанк',
  'Неоклассика',
  'Фолк',
  'Кантри',
  'Регги',
  'Латино',
  'Шансон',
  'Авторская песня',
];

List<String> normalizeTasteLabels(Iterable<String> values) {
  final seen = <String>{};
  final result = <String>[];
  for (final value in values) {
    final label = value.trim();
    if (label.isEmpty) continue;
    if (label.length > 80 || RegExp(r'[\x00-\x1f\x7f]').hasMatch(label)) {
      throw const AppFailure(
        code: 'invalid_taste',
        message:
            'Название должно содержать до 80 символов без управляющих знаков.',
      );
    }
    if (seen.add(label.toLowerCase())) result.add(label);
  }
  return List.unmodifiable(result);
}

class TasteProfileState {
  TasteProfileState({
    required this.needsOnboarding,
    Iterable<String> genres = const [],
    Iterable<String> artists = const [],
  }) : genres = normalizeTasteLabels(genres),
       artists = normalizeTasteLabels(artists);
  final bool needsOnboarding;
  final List<String> genres, artists;
  factory TasteProfileState.fromJson(Object? raw) {
    final dto = collectionObject(raw),
        profile = dto['profile'] == null
            ? <String, Object?>{}
            : collectionObject(dto['profile']);
    if (dto['needsOnboarding'] is! bool) {
      throw collectionFailure(StateError('taste state'));
    }
    return TasteProfileState(
      needsOnboarding: dto['needsOnboarding'] as bool,
      genres: (profile['genres'] as List? ?? []).cast<String>(),
      artists: (profile['artists'] as List? ?? []).cast<String>(),
    );
  }
}

class TasteArtistPage {
  TasteArtistPage(this.artists, this.nextPage);
  final List<String> artists;
  final int? nextPage;
}

class TasteRepository extends ExtrasRepository {
  TasteRepository({
    required super.transport,
    required super.authority,
    required super.fence,
    required super.networkPolicy,
  });
  Future<TasteProfileState> load({bool Function()? current}) async =>
      TasteProfileState.fromJson(
        await request('/api/taste-profile', current: current),
      );
  Future<TasteProfileState> save({
    required Iterable<String> genres,
    required Iterable<String> artists,
    required bool replace,
    bool Function()? current,
  }) {
    final body = {
      'genres': normalizeTasteLabels(genres),
      'artists': normalizeTasteLabels(artists),
    };
    return _write(body, replace, current);
  }

  Future<TasteProfileState> skip({
    required bool replace,
    bool Function()? current,
  }) => _write({'skip': true}, replace, current);
  Future<TasteProfileState> _write(
    Map<String, Object?> body,
    bool replace,
    bool Function()? current,
  ) async => TasteProfileState.fromJson(
    await request(
      '/api/taste-profile',
      method: replace ? ApiMethod.put : ApiMethod.post,
      body: body,
      current: current,
    ),
  );
  Future<TasteArtistPage> catalog({
    String genre = 'all',
    int page = 1,
    bool Function()? current,
  }) async {
    if (page < 1 || genre != 'all' && !tasteGenres.contains(genre)) {
      throw ArgumentError('Invalid catalog query');
    }
    final dto = collectionObject(
      await request(
        '/api/taste-profile/artists',
        query: {'genre': genre, 'page': '$page'},
        current: current,
      ),
    );
    final next = dto['nextPage'];
    if (next != null && (next is! int || next <= page)) {
      throw collectionFailure(StateError('catalog cursor'));
    }
    return TasteArtistPage(
      normalizeTasteLabels((dto['artists'] as List).cast<String>()),
      next as int?,
    );
  }

  Future<List<String>> search(String query, {bool Function()? current}) async {
    if (query.trim().length < 2) return [];
    final dto = collectionObject(
      await request(
        '/api/enrichment/search/musicbrainz/artists',
        query: {'q': query.trim()},
        current: current,
      ),
    );
    return normalizeTasteLabels(
      collectionList(dto['artists'])
          .map((a) => collectionString(collectionObject(a)['name'])),
    );
  }
}
