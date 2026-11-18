/// Local finite-session metadata, never a provider identity or server field.
final class SmartShuffleLineage {
  const SmartShuffleLineage({
    required this.sessionId,
    required this.playlistId,
    required this.snapshotId,
    required this.seed,
    required this.injected,
    required this.occurrenceId,
    required this.cursor,
    required this.enabled,
  });
  final String sessionId, playlistId, snapshotId, occurrenceId;
  final int seed, cursor;
  final bool injected, enabled;

  SmartShuffleLineage withEnabled(bool value) => SmartShuffleLineage(
    sessionId: sessionId,
    playlistId: playlistId,
    snapshotId: snapshotId,
    seed: seed,
    injected: injected,
    occurrenceId: occurrenceId,
    cursor: cursor,
    enabled: value,
  );

  Map<String, Object?> toJson() => {
    'v': 1,
    'sessionId': sessionId,
    'playlistId': playlistId,
    'snapshotId': snapshotId,
    'seed': seed,
    'kind': injected ? 'injected' : 'own',
    'occurrenceId': occurrenceId,
    'cursor': cursor,
    'enabled': enabled,
  };

  factory SmartShuffleLineage.fromJson(Object? value) {
    const keys = {
      'v',
      'sessionId',
      'playlistId',
      'snapshotId',
      'seed',
      'kind',
      'occurrenceId',
      'cursor',
      'enabled',
    };
    bool id(Object? v, int max) =>
        v is String &&
        v.isNotEmpty &&
        v.length <= max &&
        RegExp(r'^[A-Za-z0-9_:-]+$').hasMatch(v);
    if (value is! Map ||
        value.length != keys.length ||
        value.keys.any((key) => !keys.contains(key)) ||
        value['v'] is! int ||
        value['v'] != 1 ||
        !id(value['sessionId'], 96) ||
        !id(value['playlistId'], 128) ||
        !id(value['occurrenceId'], 256) ||
        value['snapshotId'] is! String ||
        !RegExp(r'^[a-f0-9]{8}$').hasMatch(value['snapshotId'] as String) ||
        value['seed'] is! int ||
        (value['seed'] as int) < 0 ||
        (value['seed'] as int) > 0xffffffff ||
        value['cursor'] is! int ||
        (value['cursor'] as int) < 0 ||
        (value['cursor'] as int) > 50 ||
        !{'own', 'injected'}.contains(value['kind']) ||
        value['enabled'] is! bool) {
      throw const FormatException('Invalid finite smart lineage');
    }
    return SmartShuffleLineage(
      sessionId: value['sessionId'] as String,
      playlistId: value['playlistId'] as String,
      snapshotId: value['snapshotId'] as String,
      seed: value['seed'] as int,
      injected: value['kind'] == 'injected',
      occurrenceId: value['occurrenceId'] as String,
      cursor: value['cursor'] as int,
      enabled: value['enabled'] as bool,
    );
  }
}
