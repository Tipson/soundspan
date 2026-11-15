import 'dart:convert';

import 'queue_snapshot.dart';

/// Bounded supplemental state for one owner-owned occurrence checkpoint.
/// Keeping it separate preserves the legacy snapshot's strict JSON shape.
final class RecommendationQueuePolicy {
  const RecommendationQueuePolicy._(this.exclusions, this.closedScopes);
  static const maxExclusions = 2000;
  static const maxScopes = 2000;
  static const maxBytes = 1024 * 1024;
  static const _empty = RecommendationQueuePolicy._({}, {});
  final Map<String, Set<String>> exclusions;
  final Set<String> closedScopes;

  /// Capture before storage awaits; absent state removes a previous guard row.
  static Map<String, Object?>? encode(QueueSnapshot state) {
    final scopes = _scopes(state.entries);
    final exclusions = {
      for (final entry in state.recommendationExclusions.entries)
        if (scopes.contains(entry.key) && entry.value.isNotEmpty)
          entry.key: entry.value.toList()..sort(),
    };
    final closed =
        state.closedRecommendationScopes.intersection(scopes).toList()..sort();
    if (exclusions.isEmpty && closed.isEmpty) return null;
    final row = <String, Object?>{
      'version': 1,
      'entryIds': state.entries.map((entry) => entry.entryId).toList()..sort(),
      'exclusions': exclusions,
      'closedScopes': closed,
    };
    _parse(row, state.entries);
    return row;
  }

  /// Unknown/corrupt policy keeps metadata and closes recommendation admission.
  /// A valid row tied to different occurrence IDs belongs to another queue.
  static RecommendationQueuePolicy decode(
    Object? row,
    List<QueueEntry> entries,
  ) {
    if (row == null) return _empty;
    try {
      return _parse(row, entries);
    } on FormatException {
      return RecommendationQueuePolicy._(const {}, _scopes(entries));
    }
  }

  static Set<String> _scopes(Iterable<QueueEntry> entries) => entries
      .map((entry) => entry.context.recommendationScopeKey)
      .whereType<String>()
      .toSet();

  static bool _text(Object? value) =>
      value is String &&
      value.isNotEmpty &&
      value.length <= 1024 &&
      !RegExp(r'[\x00-\x1f]').hasMatch(value);

  static RecommendationQueuePolicy _parse(
    Object? value,
    List<QueueEntry> entries,
  ) {
    if (value is! Map<String, Object?>) _invalid();
    final anchors = value['entryIds'];
    if (anchors is! List ||
        anchors.length > maxExclusions ||
        !anchors.every(_text)) {
      _invalid();
    }
    final expected = entries.map((entry) => entry.entryId).toList()..sort();
    final actual = anchors.cast<String>().toList()..sort();
    if (actual.toSet().length != actual.length) _invalid();
    if (actual.length != expected.length ||
        List.generate(
          actual.length,
          (i) => actual[i] != expected[i],
        ).any((different) => different)) {
      return _empty;
    }
    const keys = {'version', 'entryIds', 'exclusions', 'closedScopes'};
    if (value.length != keys.length ||
        value.keys.any((key) => !keys.contains(key)) ||
        value['version'] != 1) {
      _invalid();
    }
    final rawExclusions = value['exclusions'];
    final rawClosed = value['closedScopes'];
    if (rawExclusions is! Map ||
        rawExclusions.length > maxScopes ||
        rawClosed is! List ||
        rawClosed.length > maxScopes ||
        !rawClosed.every(_text)) {
      _invalid();
    }
    final scopes = _scopes(entries);
    final exclusions = <String, Set<String>>{};
    var count = 0;
    for (final entry in rawExclusions.entries) {
      if (!_text(entry.key) || entry.value is! List) _invalid();
      final refs = entry.value as List;
      count += refs.length;
      if (count > maxExclusions ||
          !refs.every(
            (ref) =>
                _text(ref) &&
                RegExp(r'^(library|yt|vk|yandex):').hasMatch(ref as String) &&
                !ref.contains('://'),
          )) {
        _invalid();
      }
      if (scopes.contains(entry.key)) {
        exclusions[entry.key as String] = refs.cast<String>().toSet();
      }
    }
    if (utf8.encode(jsonEncode(value)).length > maxBytes) _invalid();
    return RecommendationQueuePolicy._(
      exclusions,
      rawClosed.cast<String>().toSet().intersection(scopes),
    );
  }

  static Never _invalid() =>
      throw const FormatException('Invalid recommendation queue policy');
}
