import 'dart:convert';

import '../../core/model/app_failure.dart';

const invalidImport = AppFailure(
  code: 'invalid_import',
  message: 'Сервер вернул некорректные данные импорта.',
);
Map<String, Object?> importObject(Object? value) =>
    value is Map<String, Object?> ? value : throw invalidImport;
String importString(Object? value, {bool empty = false}) =>
    value is String && (empty || value.isNotEmpty)
    ? value
    : throw invalidImport;
int importCount(Object? value) =>
    value is int && value >= 0 ? value : throw invalidImport;
String? _optional(Object? value) => value == null ? null : importString(value);

/// Provider identifiers are opaque; display names never substitute identities.
final class ImportSource {
  const ImportSource._(this.provider, this.id, this.url);
  final String provider, id;
  final Uri url;
  String get identity => '$provider:$id';
  String get label => providerLabel(provider);
  static ImportSource parse(String input) {
    const bad = AppFailure(
      code: 'invalid_import_url',
      message: 'Укажите публичный плейлист Яндекс Музыки, Spotify, Deezer или YouTube.',
    );
    var text = input.trim();
    if (!text.contains('://')) text = 'https://$text';
    final uri = Uri.tryParse(text);
    final rawAuthority = RegExp(r'^[^:]+://([^/?#]+)').firstMatch(text)?[1];
    if (uri == null ||
        !['https', 'http'].contains(uri.scheme) ||
        uri.userInfo.isNotEmpty ||
        rawAuthority == null ||
        rawAuthority.contains(':') ||
        uri.hasPort ||
        uri.hasFragment ||
        text.contains(RegExp(r'[\\\x00-\x20\x7f]')) ||
        uri.path.contains('%')) {
      throw bad;
    }
    final host = uri.host.toLowerCase();
    final path = uri.path;
    String? provider, id, canonicalPath;
    Map<String, String>? query;
    if (const {
      'music.yandex.ru',
      'music.yandex.com',
      'music.yandex.kz',
      'music.yandex.by',
      'music.yandex.uz',
    }.contains(host)) {
      final legacy = RegExp(
        r'^/users/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})/playlists/(\d{1,20})/?$',
      ).firstMatch(path);
      final modern = RegExp(
        r'^/playlists/((?:[a-zA-Z]{1,16}\.)?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/?$',
      ).firstMatch(path);
      if (legacy != null) {
        final owner = legacy[1]!.toLowerCase();
        final kind = BigInt.parse(legacy[2]!).toString();
        id = '$owner:$kind';
        canonicalPath = '/users/$owner/playlists/$kind';
      }
      if (modern != null) {
        id = modern[1]!.toLowerCase();
        canonicalPath = '/playlists/$id';
      }
      provider = 'yandex';
    } else if (host == 'open.spotify.com') {
      final match = RegExp(
        r'^/(?:intl-[a-z]{2}(?:-[a-z]{2})?/)?playlist/([A-Za-z0-9]+)/?$',
      ).firstMatch(path);
      id = match?[1];
      provider = 'spotify';
      canonicalPath = '/playlist/$id';
    } else if (host == 'deezer.com' || host == 'www.deezer.com') {
      id = RegExp(r'^/(?:[a-z]{2}/)?playlist/(\d+)/?$').firstMatch(path)?[1];
      provider = 'deezer';
      canonicalPath = '/playlist/$id';
    } else if (const {
          'youtube.com',
          'www.youtube.com',
          'm.youtube.com',
          'music.youtube.com',
        }.contains(host) &&
        RegExp(r'^/playlist/?$').hasMatch(path)) {
      final values = uri.queryParametersAll['list'];
      if (values?.length == 1 &&
          RegExp(r'^[A-Za-z0-9_-]+$').hasMatch(values!.single)) {
        id = values.single;
        query = {'list': id};
      }
      provider = 'youtube';
      canonicalPath = '/playlist';
    }
    if (provider == null || id == null) throw bad;
    return ImportSource._(
      provider,
      id,
      Uri(
        scheme: 'https',
        host: host,
        path: canonicalPath,
        queryParameters: query,
      ),
    );
  }
}

String providerLabel(String source) => switch (source) {
  'yandex' => 'Яндекс Музыка',
  'spotify' => 'Spotify',
  'deezer' => 'Deezer',
  'youtube' => 'YouTube',
  'local' => 'Библиотека',
  'tidal' => 'Tidal — недоступен',
  _ => 'Не найдено',
};

final class ImportSummary {
  ImportSummary.fromJson(Object? raw) {
    final dto = importObject(raw);
    total = importCount(dto['total']);
    local = importCount(dto['local']);
    youtube = importCount(dto['youtube']);
    tidal = importCount(dto['tidal']);
    unresolved = importCount(dto['unresolved']);
    if (local + youtube + tidal + unresolved > total) throw invalidImport;
  }
  late final int total, local, youtube, tidal, unresolved;
  int get importable => local + youtube;
  String get description =>
      'Всего: $total · в библиотеке: $local · YouTube: $youtube · не найдено: $unresolved${tidal > 0 ? ' · недоступно Tidal: $tidal' : ''}';
}

final class ImportResolvedTrack {
  ImportResolvedTrack.fromJson(Object? raw)
    : json = Map.unmodifiable(importObject(raw)) {
    index = importCount(json['index']);
    artist = importString(json['artist'], empty: true);
    title = importString(json['title'], empty: true);
    source = importString(json['source']);
    if (!const {'local', 'youtube', 'tidal', 'unresolved'}.contains(source)) {
      throw invalidImport;
    }
    final key = switch (source) {
      'local' => 'trackId',
      'youtube' => 'trackYtMusicId',
      'tidal' => 'trackTidalId',
      _ => null,
    };
    if (key != null) importString(json[key]);
    final confidence = json['confidence'];
    if (confidence is! num ||
        !confidence.isFinite ||
        confidence < 0 ||
        confidence > 1) {
      throw invalidImport;
    }
  }
  final Map<String, Object?> json;
  late final int index;
  late final String artist, title, source;
  bool get importable => source == 'local' || source == 'youtube';
}

final class ImportPreview {
  ImportPreview.fromJson(Object? raw) {
    // Detached deep snapshot prevents changing IDs between preview and execute.
    _json = importObject(jsonDecode(jsonEncode(raw)));
    name = importString(json['playlistName'], empty: true);
    summary = ImportSummary.fromJson(json['summary']);
    final rows = json['resolved'];
    if (rows is! List || rows.length > 10000) throw invalidImport;
    tracks = List.unmodifiable(rows.map(ImportResolvedTrack.fromJson));
    if (tracks.length != summary.total ||
        tracks.map((t) => t.index).toSet().length != tracks.length) {
      throw invalidImport;
    }
    for (final source in ['local', 'youtube', 'tidal', 'unresolved']) {
      if (tracks.where((t) => t.source == source).length !=
          importCount(importObject(json['summary'])[source])) {
        throw invalidImport;
      }
    }
  }
  late final Map<String, Object?> _json;
  Map<String, Object?> get json => importObject(jsonDecode(jsonEncode(_json)));
  late final String name;
  late final ImportSummary summary;
  late final List<ImportResolvedTrack> tracks;
}

final class ImportOutcome {
  ImportOutcome.fromJson(Object? raw) {
    final dto = importObject(raw);
    playlistId = importString(dto['playlistId']);
    summary = ImportSummary.fromJson(dto['summary']);
  }
  late final String playlistId;
  late final ImportSummary summary;
}

final class ImportJob {
  ImportJob.fromJson(Object? raw) {
    final dto = importObject(raw);
    id = importString(dto['id']);
    userId = importString(dto['userId']);
    sourceType = importString(dto['sourceType']);
    sourceId = importString(dto['sourceId']);
    normalizedSource = importString(dto['normalizedSource']);
    if (normalizedSource != '$sourceType:$sourceId') throw invalidImport;
    name = importString(dto['playlistName'], empty: true);
    status = importString(dto['status']);
    if (!const {
      'pending',
      'resolving',
      'creating_playlist',
      'cancelling',
      'completed',
      'failed',
      'cancelled',
    }.contains(status)) {
      throw invalidImport;
    }
    progress = importCount(dto['progress']);
    if (progress > 100) throw invalidImport;
    summary = ImportSummary.fromJson(dto['summary']);
    playlistId = _optional(dto['createdPlaylistId']);
    processed = importCount(dto['resolutionProcessed']);
    attempt = importCount(dto['resolutionAttempt']);
    remainingSeconds = dto['estimatedRemainingSeconds'] == null
        ? null
        : importCount(dto['estimatedRemainingSeconds']);
    // Raw upstream errors may include URLs or credentials; do not render them.
    failed = dto['error'] != null;
  }
  late final String id,
      userId,
      sourceType,
      sourceId,
      normalizedSource,
      name,
      status;
  late final int progress, processed, attempt;
  late final int? remainingSeconds;
  late final String? playlistId;
  late final ImportSummary summary;
  late final bool failed;
  bool get active => const {
    'pending',
    'resolving',
    'creating_playlist',
    'cancelling',
  }.contains(status);
  bool get canCancel => active && status != 'cancelling';
  bool get canRetry => !active && playlistId != null && summary.unresolved > 0;
  String get statusLabel => switch (status) {
    'pending' => 'В очереди',
    'resolving' => 'Поиск записей',
    'creating_playlist' => 'Создание плейлиста',
    'cancelling' => 'Отменяем',
    'completed' =>
      summary.unresolved > 0 ? 'Готово, часть записей не найдена' : 'Готово',
    'cancelled' => 'Отменено',
    _ => 'Импорт не завершён',
  };
}
