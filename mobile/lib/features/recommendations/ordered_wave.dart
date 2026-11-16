import '../../core/model/track.dart';
import '../../core/model/track_ref.dart';
import '../../core/model/app_failure.dart';
import '../../playback/finite_queue_admission_api.dart';
import '../radio/radio_repository.dart' show radioTrack;

const invalidOrderedWave = AppFailure(
  code: 'invalid_ordered_wave',
  message: 'Некорректный порядок Волны',
);
const waveSequenceReset = AppFailure(
  code: 'wave_sequence_reset',
  message: 'Последовательность Волны нужно начать заново',
  retryable: true,
  statusCode: 409,
);

Map<String, Object?> _object(Object? value, [Set<String>? keys]) {
  if (value is! Map || value.keys.any((key) => key is! String)) {
    throw invalidOrderedWave;
  }
  final row = value.cast<String, Object?>();
  if (keys != null &&
      (row.length != keys.length || !row.keys.every(keys.contains))) {
    throw invalidOrderedWave;
  }
  return row;
}

int _position(Object? value) {
  if (value is! int || value < 0 || value > 2147483647) {
    throw invalidOrderedWave;
  }
  return value;
}

/// Exact public occurrence identity; artist credits remain server-only.
final class OrderedWaveReference {
  const OrderedWaveReference(this.source, this.id, this.position);
  final String source, id;
  final int position;
  Map<String, Object?> toJson() => {
    'source': source,
    'id': id,
    'position': position,
  };
  factory OrderedWaveReference.decode(Object? value) {
    final row = _object(value, {'source', 'id', 'position'});
    final source = row['source'], id = row['id'];
    if (source is! String ||
        id is! String ||
        !FiniteQueueAdmissionReference(source: source, id: id).valid) {
      throw invalidOrderedWave;
    }
    return OrderedWaveReference(source, id, _position(row['position']));
  }
  bool same(OrderedWaveReference other) =>
      source == other.source && id == other.id && position == other.position;
  static OrderedWaveReference fromTrack(
    Map<String, Object?> dto,
    Track track,
    int position,
  ) {
    final source = dto['source'];
    if (source is! String || dto['streamSource'] != source) {
      throw invalidOrderedWave;
    }
    final ref = track.ref;
    final String id;
    switch (ref) {
      case LibraryTrackRef(:final libraryId):
        if (source != 'library') throw invalidOrderedWave;
        final localProvider = dto['provider'] == null
            ? const <String, Object?>{}
            : _object(dto['provider']);
        if (localProvider['youtubeVideoId'] != null ||
            localProvider['tidalTrackId'] != null ||
            dto['youtubeVideoId'] != null ||
            dto['tidalTrackId'] != null) {
          throw invalidOrderedWave;
        }
        id = libraryId;
      case YoutubeTrackRef(:final videoId):
        if (source != 'youtube') throw invalidOrderedWave;
        id = videoId;
      case NativeTrackRef(:final recording):
        if (source != recording.provider.name) throw invalidOrderedWave;
        id = recording.id;
      case UnavailableTrackRef():
        // Preserve the exact retired source in the DTO; attachment fails closed.
        final provider = _object(dto['provider']);
        final tidal = provider['tidalTrackId'];
        if (source != 'tidal' || tidal is! int || dto['id'] != 'tidal:$tidal') {
          throw invalidOrderedWave;
        }
        id = '$tidal';
    }
    return OrderedWaveReference.decode({
      'source': source,
      'id': id,
      'position': position,
    });
  }
}

/// Validated authoritative Wave order, never reconstructed from shelves.
final class OrderedWavePage {
  OrderedWavePage({
    required this.sequenceId,
    required this.startPosition,
    required Iterable<Track> tracks,
    required this.nextCursor,
    required Iterable<OrderedWaveReference> references,
    required Iterable<OrderedWaveReference> tail,
  }) : tracks = List.unmodifiable(tracks),
       references = List.unmodifiable(references),
       tail = List.unmodifiable(tail);
  final String sequenceId, nextCursor;
  final int startPosition;
  final List<Track> tracks;
  final List<OrderedWaveReference> references, tail;
  int get nextPosition => startPosition + tracks.length;
  factory OrderedWavePage.decode(
    Object? raw, {
    String? generationId,
    OrderedWavePage? previous,
  }) {
    final row = _object(raw, {
      'version',
      'sequenceId',
      'startPosition',
      'items',
      'nextCursor',
      'tail',
    });
    final sequence = row['sequenceId'], cursor = row['nextCursor'];
    if (row['version'] is! int ||
        row['version'] != 1 ||
        sequence is! String ||
        !RegExp(
          r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
          caseSensitive: false,
        ).hasMatch(sequence) ||
        cursor is! String ||
        cursor.isEmpty ||
        cursor.length > 1024 ||
        !RegExp(r'^[A-Za-z0-9_-]+$').hasMatch(cursor)) {
      throw invalidOrderedWave;
    }
    final start = _position(row['startPosition']);
    final items = row['items'], rawTail = row['tail'];
    if (items is! List ||
        items.length > 75 ||
        rawTail is! List ||
        rawTail.length > 2 ||
        start + items.length > 2147483647) {
      throw invalidOrderedWave;
    }
    final tracks = <Track>[], references = <OrderedWaveReference>[];
    for (var i = 0; i < items.length; i++) {
      final item = _object(items[i], {'position', 'track'});
      if (_position(item['position']) != start + i) throw invalidOrderedWave;
      final dto = _object(item['track']);
      final track = radioTrack({
        ...dto,
        'recommendationGenerationId': ?generationId,
      });
      tracks.add(track);
      references.add(OrderedWaveReference.fromTrack(dto, track, start + i));
    }
    final next = start + items.length;
    final tail = rawTail.map(OrderedWaveReference.decode).toList();
    if (tail.length != (next < 2 ? next : 2)) throw invalidOrderedWave;
    for (var i = 0; i < tail.length; i++) {
      if (tail[i].position != next - tail.length + i) throw invalidOrderedWave;
    }
    if (previous != null &&
        (sequence != previous.sequenceId || start != previous.nextPosition)) {
      throw invalidOrderedWave;
    }
    final known = [...?previous?.tail, ...references];
    for (final ref in tail) {
      final match = known
          .where((item) => item.position == ref.position)
          .firstOrNull;
      if ((match != null && !match.same(ref)) ||
          (previous != null && match == null)) {
        throw invalidOrderedWave;
      }
    }
    return OrderedWavePage(
      sequenceId: sequence,
      startPosition: start,
      tracks: tracks,
      references: references,
      nextCursor: cursor,
      tail: tail,
    );
  }
}
