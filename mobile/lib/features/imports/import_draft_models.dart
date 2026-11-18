import 'dart:convert';

import 'import_models.dart';

enum ImportDraftCategory {
  playlists('Плейлисты'),
  likes('Любимые треки'),
  albums('Альбомы'),
  artists('Исполнители'),
  dislikes('Не нравится');

  const ImportDraftCategory(this.label);
  final String label;
  static ImportDraftCategory decode(Object? value) => values.firstWhere(
    (item) => item.name == value,
    orElse: () => throw invalidImport,
  );
}

String _text(Object? value, [int maximum = 300]) {
  final text = importString(value);
  if (text.length > maximum || text.contains(RegExp(r'[\x00-\x1f\x7f]'))) {
    throw invalidImport;
  }
  return text;
}

int _revision(Object? value) {
  final number = importCount(value);
  if (number < 1 || number > 2147483646) throw invalidImport;
  return number;
}

String _digest(Object? value) {
  final digest = _text(value, 64);
  if (!RegExp(r'^[a-f0-9]{64}$').hasMatch(digest)) throw invalidImport;
  return digest;
}

final class ImportDraftEntry {
  ImportDraftEntry.fromJson(Object? value) {
    final raw = importObject(value);
    id = _text(raw['id'], 32);
    category = ImportDraftCategory.decode(raw['category']);
    title = _text(raw['title']);
    artist = importString(raw['artist'], empty: true);
    if (artist.length > 300) throw invalidImport;
    position = importCount(raw['position']);
    groupId = raw['groupId'] == null ? null : _text(raw['groupId'], 32);
  }
  late final String id, title, artist;
  late final String? groupId;
  late final int position;
  late final ImportDraftCategory category;
}

final class ImportDraftPreviewRow {
  ImportDraftPreviewRow.fromJson(Object? value) {
    final raw = importObject(value);
    entryId = _text(raw['entryId'], 32);
    final score = raw['confidence'];
    if (score is! num || !score.isFinite || score < 0 || score > 100) {
      throw invalidImport;
    }
    confidence = score.toDouble();
    reason = raw['unresolvedReason'] == null
        ? null
        : _text(raw['unresolvedReason'], 64);
    final match = raw['match'];
    if (match == null) {
      source = 'reference';
      return;
    }
    final data = importObject(match);
    source = _text(data['source'], 32);
    if (!const {'local', 'youtube', 'unresolved'}.contains(source)) {
      throw invalidImport;
    }
    matchedTitle = data['title'] == null ? null : _text(data['title']);
    matchedArtist = data['artist'] == null ? null : _text(data['artist']);
  }
  late final String entryId, source;
  late final double confidence;
  String? reason, matchedTitle, matchedArtist;
  bool get unresolved => reason != null || source == 'unresolved';
}

final class ImportDraftPreview {
  ImportDraftPreview.fromJson(
    Object? value,
    int expectedRevision,
    List<ImportDraftEntry> entries,
  ) {
    final raw = importObject(value);
    revision = _revision(raw['revision']);
    previewRevision = _revision(raw['previewRevision']);
    mappingDigest = _digest(raw['mappingDigest']);
    final values = raw['rows'];
    if (revision != expectedRevision ||
        values is! List ||
        values.length != entries.length) {
      throw invalidImport;
    }
    rows = List.unmodifiable(values.map(ImportDraftPreviewRow.fromJson));
    for (var i = 0; i < entries.length; i++) {
      if (rows[i].entryId != entries[i].id) throw invalidImport;
    }
  }
  late final int revision, previewRevision;
  late final String mappingDigest;
  late final List<ImportDraftPreviewRow> rows;
}

final class ImportDraftResult {
  ImportDraftResult.fromJson(Object? value) {
    final raw = importObject(value);
    final ids = raw['playlistIds'],
        unknown = raw['unresolved'],
        skipped = raw['skipped'];
    if (raw['version'] != 1 ||
        ids is! List ||
        ids.length > 100 ||
        unknown is! List ||
        unknown.length > 1000 ||
        skipped is! List ||
        skipped.length > 1000) {
      throw invalidImport;
    }
    playlistIds = List.unmodifiable(ids.map((id) => _text(id, 128)));
    unresolved = unknown.length;
    preservedPreferences = skipped.length;
    counts = Map.unmodifiable({
      for (final category in ImportDraftCategory.values.where(
        (c) => c != ImportDraftCategory.playlists,
      ))
        category: importCount(raw[category.name]),
    });
    if (counts.values.any((n) => n > 1000)) throw invalidImport;
  }
  late final List<String> playlistIds;
  late final int unresolved, preservedPreferences;
  late final Map<ImportDraftCategory, int> counts;
}

/// Private display snapshot. Matching identities are never returned to confirm.
final class ImportDraftJob {
  ImportDraftJob.fromJson(Object? value) {
    final raw = importObject(jsonDecode(jsonEncode(value)));
    id = _text(raw['id'], 128);
    userId = _text(raw['userId'], 128);
    revision = _revision(raw['draftRevision']);
    status = _text(raw['status'], 32);
    if (!const {
      'draft',
      'previewing',
      'awaiting_confirmation',
      'pending',
      'creating_playlist',
      'cancelling',
      'completed',
      'failed',
      'cancelled',
    }.contains(status)) {
      throw invalidImport;
    }
    progress = importCount(raw['progress']);
    if (progress > 100) throw invalidImport;
    final data = importObject(raw['draftData']);
    final normalized = importObject(data['normalized']);
    if (data['version'] != 1 || normalized['version'] != 1) throw invalidImport;
    format = _text(normalized['format'], 32);
    if (!const {'text', 'spotify-json'}.contains(format)) throw invalidImport;
    name = _text(normalized['name'], 200);
    sourceHash = _digest(normalized['sourceHash']);
    final sourceEntries = normalized['entries'];
    if (sourceEntries is! List ||
        sourceEntries.isEmpty ||
        sourceEntries.length > 1000) {
      throw invalidImport;
    }
    entries = List.unmodifiable(sourceEntries.map(ImportDraftEntry.fromJson));
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].id != 'e$i') throw invalidImport;
    }
    preview = data['preview'] == null
        ? null
        : ImportDraftPreview.fromJson(data['preview'], revision, entries);
    confirmed = raw['confirmedSnapshot'] != null;
    if (confirmed) {
      final confirmation = importObject(raw['confirmedSnapshot']);
      final categories = confirmation['categories'];
      if (confirmation['version'] != 1 ||
          confirmation['revision'] != revision ||
          confirmation['sourceHash'] != sourceHash ||
          preview == null ||
          confirmation['previewRevision'] != preview!.previewRevision ||
          confirmation['mappingDigest'] != preview!.mappingDigest ||
          categories is! List ||
          categories.isEmpty ||
          categories.length > 5) {
        throw invalidImport;
      }
      confirmedCategories = Set.unmodifiable(
        categories.map(ImportDraftCategory.decode),
      );
      if (confirmedCategories.length != categories.length) throw invalidImport;
    } else {
      confirmedCategories = const {};
    }
    result = raw['draftResult'] == null
        ? null
        : ImportDraftResult.fromJson(raw['draftResult']);
    if (status == 'awaiting_confirmation' && preview == null) {
      throw invalidImport;
    }
  }
  late final String id, userId, name, status, format, sourceHash;
  late final int revision, progress;
  late final bool confirmed;
  late final Set<ImportDraftCategory> confirmedCategories;
  late final List<ImportDraftEntry> entries;
  late final ImportDraftPreview? preview;
  late final ImportDraftResult? result;
  bool get editable =>
      !confirmed &&
      const {
        'draft',
        'previewing',
        'awaiting_confirmation',
        'failed',
      }.contains(status);
  bool get working => const {
    'previewing',
    'pending',
    'creating_playlist',
    'cancelling',
  }.contains(status);
  bool get cancellable => const {
    'draft',
    'previewing',
    'awaiting_confirmation',
    'pending',
    'creating_playlist',
  }.contains(status);
  bool get canConfirm =>
      status == 'awaiting_confirmation' && preview != null && !confirmed;
  bool get canRetryConfirmed =>
      status == 'failed' && confirmed && preview != null;
  int count(ImportDraftCategory category) =>
      entries.where((e) => e.category == category).length;
  String get statusLabel => switch (status) {
    'draft' => 'Черновик',
    'previewing' => 'Ищем совпадения',
    'awaiting_confirmation' => 'Проверьте состав',
    'pending' => 'В очереди',
    'creating_playlist' => 'Сохраняем выбранное',
    'cancelling' => 'Отменяем',
    'completed' => 'Импорт завершён',
    'cancelled' => 'Отменено',
    _ => 'Импорт не завершён',
  };
}
