import 'dart:async';

import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/storage/owner_store.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/playback_engine.dart';

class ControlledTransport implements ApiTransport {
  final requests = <ApiRequest>[];
  final fences = <SessionFence?>[];
  Future<ApiResponse> Function(ApiRequest)? respond;
  @override
  Future<ApiResponse> send(ApiRequest request, {SessionFence? fence}) async {
    requests.add(request);
    fences.add(fence);
    return await respond?.call(request) ??
        const ApiResponse(200, {'id': 'play-1'});
  }
}

class ReportingStore implements OwnerStore {
  final records = <String, Map<String, Map<String, Object?>>>{};
  Future<void> _tail = Future.value();
  @override
  Future<T> transaction<T>(
    SessionFence fence,
    Future<T> Function(OwnerTransaction) operation,
  ) {
    final result = _tail.then(
      (_) => operation(
        _Tx(
          records.putIfAbsent(
            '${fence.owner.serverOrigin}:${fence.owner.userId}',
            () => {},
          ),
        ),
      ),
    );
    _tail = result.then<void>((_) {}, onError: (Object _) {});
    return result;
  }
}

class _Tx implements OwnerTransaction {
  _Tx(this.rows);
  final Map<String, Map<String, Object?>> rows;
  @override
  Future<Map<String, Object?>?> read(String namespace, String key) async =>
      rows['$namespace/$key'];
  @override
  Future<void> write(
    String namespace,
    String key,
    Map<String, Object?> value,
  ) async {
    rows['$namespace/$key'] = Map.of(value);
  }

  @override
  Future<void> remove(String namespace, String key) async {
    rows.remove('$namespace/$key');
  }

  @override
  Future<List<OwnerRecord>> list(
    String namespace, {
    String? afterKey,
    int limit = 100,
  }) async {
    final prefix = '$namespace/';
    final keys =
        rows.keys
            .where((k) => k.startsWith(prefix))
            .map((k) => k.substring(prefix.length))
            .where((k) => afterKey == null || k.compareTo(afterKey) > 0)
            .toList()
          ..sort();
    return keys
        .take(limit)
        .map((k) => OwnerRecord(key: k, value: rows['$prefix$k']!))
        .toList();
  }
}

Track waveTrack(String id) => Track(
  ref: YoutubeTrackRef(id),
  title: id,
  artist: 'Artist',
  album: 'Album',
  duration: const Duration(seconds: 200),
);
Map<String, Object?> waveDto(String id) => {
  'id': 'yt:$id',
  'source': 'youtube',
  'streamSource': 'youtube',
  'provider': {'youtubeVideoId': id},
  'title': id,
  'artist': {'name': 'Artist', 'id': null},
  'album': {'title': 'Album', 'id': null, 'coverArt': null},
  'duration': 200,
  'trackNo': null,
};
Map<String, Object?> waveFeed(
  List<String> ids, {
  int? cursor,
  String generation = 'generation-1',
  String? reason,
}) => {
  'shelves': {
    'listenAgain': [],
    'quickPicks': [],
    'discovery': ids.map(waveDto).toList(),
  },
  'nextCursor': cursor,
  'generationId': generation,
  'degraded': reason != null,
  'reason': reason,
  'seedCount': 1,
};

class ReportingController implements PlaybackController {
  Completer<void>? replaceGate;
  final states = StreamController<QueueSnapshot>.broadcast(sync: true);
  final eventController = StreamController<PlaybackEvent>.broadcast(sync: true);
  QueueSnapshot value = QueueSnapshot();
  final commands = <PlaybackCommand>[];
  int sequence = 0;
  @override
  QueueSnapshot get snapshot => value;
  @override
  Stream<QueueSnapshot> get snapshots => states.stream;
  @override
  Stream<PlaybackEvent> get events => eventController.stream;
  @override
  List<QueueEntry> createEntries(Iterable<Track> tracks, PlayContext context) =>
      tracks
          .map(
            (t) => QueueEntry(
              entryId: 'entry-${++sequence}',
              track: t,
              context: context,
            ),
          )
          .toList();
  void emit(
    QueueSnapshot snapshot, {
    PlaybackEventKind kind = PlaybackEventKind.position,
    int seconds = 0,
    String? previousEntryId,
  }) {
    value = snapshot;
    states.add(snapshot);
    eventController.add(
      PlaybackEvent(
        kind: kind,
        snapshot: snapshot,
        elapsed: Duration(seconds: seconds),
        previousEntryId: previousEntryId,
      ),
    );
  }

  @override
  Future<void> dispatch(PlaybackCommand command) async {
    final gate = command is ReplaceQueue ? replaceGate : null;
    if (command is ReplaceQueue) replaceGate = null;
    commands.add(command);
    if (command is ReplaceQueue) {
      if (command.expectedLineage != null &&
          command.expectedLineage != value.lineage) {
        return;
      }
      value = QueueSnapshot(
        entries: command.entries,
        effectiveOrder: command.entries.map((e) => e.entryId),
        currentEntryId:
            command.initialEntryId ?? command.entries.firstOrNull?.entryId,
        fence: command.fence,
        generation: value.generation + 1,
        playingIntent: command.play,
        lineage: value.lineage + 1,
      );
    } else if (command is Enqueue) {
      if (command.expectedLineage != null &&
          command.expectedLineage != value.lineage) {
        return;
      }
      final entries = [...value.entries, ...command.entries];
      value = QueueSnapshot(
        entries: entries,
        effectiveOrder: entries.map((e) => e.entryId),
        currentEntryId: value.currentEntryId,
        fence: command.fence,
        generation: value.generation,
        position: value.position,
        playingIntent: value.playingIntent,
        lineage: value.lineage + (command.expectedLineage == null ? 1 : 0),
      );
    }
    states.add(value);
    await gate?.future;
  }

  @override
  Future<void> dispose() async {
    await states.close();
    await eventController.close();
  }
}

QueueSnapshot reportSnapshot(
  SessionFence fence, {
  String id = 'entry',
  int position = 0,
  bool audible = true,
  PlaybackProcessing processing = PlaybackProcessing.ready,
  int generation = 1,
}) {
  final entry = QueueEntry(
    entryId: id,
    track: waveTrack('video-$id'),
    context: const PlayContext(
      surface: PlaySurface.wave,
      waveMode: WaveMode.forYou,
      recommendationGenerationId: 'generation-1',
      recommendationSessionId: 'session-1',
    ),
  );
  return QueueSnapshot(
    entries: [entry],
    effectiveOrder: [id],
    currentEntryId: id,
    fence: fence,
    position: Duration(seconds: position),
    duration: const Duration(seconds: 200),
    audible: audible,
    playingIntent: audible,
    processing: processing,
    generation: generation,
  );
}

Future<void> settle() async {
  for (var i = 0; i < 20; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

/// No decoder: service integration exercises the real occurrence coordinator.
class ReportingEngine implements PlaybackEngine {
  final controller = StreamController<EngineEvent>.broadcast();
  @override
  Stream<EngineEvent> get events => controller.stream;
  @override
  Future<void> load(Uri uri, int generation) async {}
  @override
  Future<void> play() async {}
  @override
  Future<void> pause() async {}
  @override
  Future<void> stop() async {}
  @override
  Future<void> seek(Duration position) async {}
  @override
  Future<void> setVolume(double volume) async {}
  @override
  Future<void> dispose() => controller.close();
}
