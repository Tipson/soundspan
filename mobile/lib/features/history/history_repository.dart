import '../../core/mapping/track_mapping.dart';
import '../../core/model/track.dart';
import '../../core/model/track_ref.dart';
import '../../core/network/api_transport.dart';
import '../library/library_models.dart';
import '../lyrics/lyrics_repository.dart';

enum HistoryRange {
  days7('7d', 'За 7 дней'),
  days30('30d', 'За 30 дней'),
  days365('365d', 'За год'),
  all('all', 'За всё время');

  const HistoryRange(this.wire, this.label);
  final String wire, label;
}

/// Server has no cursor/offset. Each next read widens the recent snapshot.
class HistoryCursor {
  const HistoryCursor(this.limit);
  final int limit;
}

class HistoryEntry {
  const HistoryEntry({
    required this.id,
    required this.playedAt,
    required this.track,
  });
  final String id;
  final DateTime playedAt;
  final Track track;
}

class HistoryPage {
  HistoryPage(Iterable<HistoryEntry> entries, this.requestedLimit)
    : entries = List.unmodifiable(entries);
  final List<HistoryEntry> entries;
  final int requestedLimit;
  // /plays filters unresolved rows after take(limit). The returned DTO count
  // cannot prove exhaustion of the raw window, even when it is empty.
  HistoryCursor? get nextCursor => requestedLimit < 200
      ? HistoryCursor(requestedLimit <= 150 ? requestedLimit + 50 : 200)
      : null;
  bool get reachedServerLimit => requestedLimit == 200;
}

class HistorySummary {
  const HistorySummary(
    this.allTime,
    this.last7Days,
    this.last30Days,
    this.last365Days,
  );
  final int allTime, last7Days, last30Days, last365Days;
}

class HistoryRepository extends ExtrasRepository {
  HistoryRepository({
    required super.transport,
    required super.authority,
    required super.fence,
    required super.networkPolicy,
  });
  Future<HistoryPage> page([HistoryCursor? cursor]) async {
    final limit = cursor?.limit ?? 50;
    if (limit < 1 || limit > 200) throw ArgumentError.value(limit);
    final rows = collectionList(
      await request('/api/plays', query: {'limit': '$limit'}),
    );
    return HistoryPage([
      for (final raw in rows) _entry(collectionObject(raw)),
    ], limit);
  }

  HistoryEntry _entry(Map<String, Object?> dto) {
    const fields = TrackFields('/api/plays');
    final id = collectionString(dto['id']);
    final date = DateTime.tryParse(collectionString(dto['playedAt']));
    if (date == null) throw collectionFailure(StateError('history date'));
    final raw = dto['track'];
    Track track;
    if (raw == null) {
      track = Track(
        ref: UnavailableTrackRef('history:$id', reason: 'missing_track'),
        title: 'Недоступный трек',
        artist: '',
        unavailableReason: 'missing_track',
      );
    } else {
      final row = collectionObject(raw),
          artist = collectionObject(row['artist']),
          album = collectionObject(row['album']);
      final playback = row['playback'] == null
          ? <String, Object?>{}
          : collectionObject(row['playback']);
      track = fields.buildTrack(
        row,
        title: collectionString(row['title']),
        artist: collectionString(artist['name']),
        artistId: artist['id'] as String?,
        album: album['title'] as String?,
        albumId: album['id'] as String?,
        cover: fields.artwork(album['coverArt'], 'album.coverArt'),
        playbackAllowed: playback['isPlayable'] != false,
        unavailableReason: playback['reason'] as String?,
      );
    }
    return HistoryEntry(id: id, playedAt: date, track: track);
  }

  Future<HistorySummary> summary() async {
    final dto = collectionObject(await request('/api/plays/summary'));
    return HistorySummary(
      collectionCount(dto['allTime']),
      collectionCount(dto['last7Days']),
      collectionCount(dto['last30Days']),
      collectionCount(dto['last365Days']),
    );
  }

  Future<int> clear(HistoryRange range, {bool Function()? current}) async {
    final dto = collectionObject(
      await request(
        '/api/plays/history',
        method: ApiMethod.delete,
        query: {'range': range.wire},
        current: current,
      ),
    );
    if (dto['success'] != true || dto['range'] != range.wire) {
      throw collectionFailure(StateError('history confirmation'));
    }
    return collectionCount(dto['deletedCount']);
  }
}
