import 'dart:async';

import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/session/session_authority.dart';
import 'package:soundspan/playback/playback_controller.dart';

final collectionOrigin = Uri.parse('https://music.example');
final collectionOwner = OwnerKey(serverOrigin: collectionOrigin, userId: 'a');
final collectionFence = SessionFence(owner: collectionOwner, epoch: 1);

class CollectionAuthority implements SessionAuthority {
  SessionFence? active = collectionFence;
  bool locallyRestored = false;
  final updates = StreamController<SessionState>.broadcast(sync: true);
  @override
  SessionState get state => active == null
      ? const SessionState.signedOut()
      : SessionState(
          status: locallyRestored
              ? SessionStatus.offlineValidated
              : SessionStatus.authenticated,
          fence: active,
        );
  void restoreLocally() {
    locallyRestored = true;
    updates.add(state);
  }

  void switchOwner() {
    active = SessionFence(
      owner: OwnerKey(serverOrigin: collectionOrigin, userId: 'b'),
      epoch: 2,
    );
    updates.add(state);
  }

  @override
  Stream<SessionState> get changes => updates.stream;
  @override
  SessionFence requireFence() =>
      active ??
      (throw const AppFailure(
        code: 'stale_session',
        message: 'Сеанс завершён',
      ));
  @override
  bool isCurrent(SessionFence fence) => active == fence;
  @override
  Future<void> assertCurrent(SessionFence fence) async {
    if (!isCurrent(fence)) {
      throw const AppFailure(code: 'stale_session', message: 'Сеанс завершён');
    }
  }

  @override
  Future<void> invalidate() async {
    active = null;
    updates.add(state);
  }

  @override
  Future<AccessGrant> grantAccess(SessionFence fence, Uri exactOrigin) =>
      throw UnimplementedError();
  @override
  Future<AuthStamp> after401(AuthStamp rejected) => throw UnimplementedError();
}

class CollectionTransport implements ApiTransport {
  CollectionTransport(this.handler);
  final FutureOr<ApiResponse> Function(ApiRequest, SessionFence?) handler;
  final requests = <ApiRequest>[];
  final fences = <SessionFence?>[];
  @override
  Future<ApiResponse> send(ApiRequest request, {SessionFence? fence}) async {
    requests.add(request);
    fences.add(fence);
    return await handler(request, fence);
  }
}

Map<String, Object?> likedDto(int index) => {
  'id': 'local-$index',
  'title': 'Песня $index',
  'duration': 180,
  'filePath': 'server/music/$index.flac',
  'artist': {'id': 'artist', 'name': 'Исполнитель'},
  'album': {'id': 'album', 'title': 'Альбом', 'coverArt': null},
};

ApiResponse likedResponse(
  List<Map<String, Object?>> tracks, {
  int? total,
  Map<String, Object?>? cursor,
}) => ApiResponse(200, {
  'playlist': {'id': 'my-liked', 'name': 'Любимое'},
  'tracks': tracks,
  'total': total ?? tracks.length,
  'pagination': {'limit': 100, 'hasMore': cursor != null, 'nextCursor': cursor},
});

ApiResponse preferenceResponse(String id, String signal) => ApiResponse(200, {
  'trackId': id,
  'signal': signal,
  'state': signal == 'thumbs_up'
      ? 'liked'
      : signal == 'thumbs_down'
      ? 'disliked'
      : 'neutral',
  'score': signal == 'thumbs_up'
      ? 1
      : signal == 'thumbs_down'
      ? -1
      : 0,
  'likedAt': null,
  'dislikedAt': null,
  'updatedAt': null,
});

Track collectionTrack(int index, {bool playable = true}) => Track(
  ref: playable
      ? LibraryTrackRef('local-$index')
      : UnavailableTrackRef('tidal:$index', reason: 'retired_provider'),
  title:
      'Очень длинное русское название музыкального произведения номер $index для проверки доступности и свободного переноса текста',
  artist: 'Очень длинное имя исполнителя и музыкального коллектива',
);

class CollectionPlayback implements PlaybackController {
  CollectionPlayback(this.value);
  QueueSnapshot value;
  final commands = <PlaybackCommand>[];
  bool moveOnNext = true;
  @override
  QueueSnapshot get snapshot => value;
  @override
  Stream<QueueSnapshot> get snapshots => const Stream.empty();
  @override
  Stream<PlaybackEvent> get events => const Stream.empty();
  @override
  List<QueueEntry> createEntries(Iterable<Track> tracks, PlayContext context) =>
      [
        for (final (index, track) in tracks.indexed)
          QueueEntry(entryId: 'entry-$index', track: track, context: context),
      ];
  @override
  Future<void> dispatch(PlaybackCommand command) async {
    commands.add(command);
    if (command is Next && moveOnNext) {
      value = QueueSnapshot(fence: collectionFence);
    }
  }

  @override
  Future<void> dispose() async {}
}
