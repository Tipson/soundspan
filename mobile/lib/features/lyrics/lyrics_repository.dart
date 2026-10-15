import 'dart:async';

import '../../core/model/track.dart';
import '../../core/model/track_ref.dart';
import '../../core/model/owner_key.dart';
import '../../core/network/api_transport.dart';
import '../../core/network/network_policy.dart';
import '../../core/session/session_authority.dart';
import '../library/library_models.dart';

/// Owner-bound boundary shared by player extras. No mutation retry or replay.
abstract class ExtrasRepository {
  ExtrasRepository({
    required this.transport,
    required this.authority,
    required this.fence,
    required this.networkPolicy,
  }) {
    _session = authority.changes.listen((_) {
      if (!authority.isCurrent(fence)) _revoked = true;
    });
  }
  final ApiTransport transport;
  final SessionAuthority authority;
  final SessionFence fence;
  final NetworkPolicy networkPolicy;
  late final StreamSubscription<SessionState> _session;
  bool _revoked = false;
  bool get isCurrent {
    if (!authority.isCurrent(fence)) _revoked = true;
    return !_revoked;
  }

  Future<void> guard([bool Function()? current]) async {
    if (!isCurrent || current?.call() == false) throw collectionStaleSession;
    await authority.assertCurrent(fence);
    if (!isCurrent || current?.call() == false) throw collectionStaleSession;
  }

  Future<Object?> request(
    String path, {
    ApiMethod method = ApiMethod.get,
    Map<String, String> query = const {},
    Map<String, Object?>? body,
    bool Function()? current,
  }) async {
    networkPolicy.requireNetwork();
    await guard(current);
    networkPolicy.requireNetwork();
    final response = await transport.send(
      ApiRequest(
        origin: fence.owner.serverOrigin,
        method: method,
        path: path,
        query: query,
        body: body,
      ),
      fence: fence,
    );
    await guard(current);
    response.requireSuccess();
    return response.data;
  }

  void dispose() {
    _revoked = true;
    unawaited(_session.cancel());
  }
}

/// Original identity used for metadata lookup, never an audio replacement.
String extrasTrackId(Track track) => switch (track.ref) {
  LibraryTrackRef(:final libraryId) => libraryId,
  YoutubeTrackRef(:final videoId) => 'yt:$videoId',
  _ => track.ref.identityKey,
};

class LyricsLine {
  const LyricsLine(this.position, this.text);
  final Duration position;
  final String text;
}

class LyricsDocument {
  const LyricsDocument({this.plain, this.synced, this.source = 'none'});
  final String? plain, synced;
  final String source;
  List<LyricsLine> get lines {
    final result = <LyricsLine>[];
    final stamp = RegExp(r'\[(\d+):(\d{2})(?:[.:](\d{1,3}))?\]');
    for (final line in (synced ?? '').split('\n')) {
      final matches = stamp.allMatches(line).toList();
      final text = line.replaceAll(stamp, '').trim();
      for (final match in matches) {
        final seconds = int.parse(match[2]!);
        if (seconds >= 60) continue;
        final millis = int.parse((match[3] ?? '0').padRight(3, '0'));
        final minutes = int.tryParse(match[1]!);
        final remainder = seconds * Duration.millisecondsPerSecond + millis;
        // Dart's native Duration stores signed64 microseconds. Check before
        // multiplication, so an untrusted provider stamp cannot wrap negative.
        const maxMillis =
            0x7fffffffffffffff ~/ Duration.microsecondsPerMillisecond;
        if (minutes == null ||
            minutes < 0 ||
            minutes >
                (maxMillis - remainder) ~/ Duration.millisecondsPerMinute) {
          continue;
        }
        result.add(
          LyricsLine(
            Duration(
              milliseconds:
                  minutes * Duration.millisecondsPerMinute + remainder,
            ),
            text,
          ),
        );
      }
    }
    result.sort((a, b) => a.position.compareTo(b.position));
    return List.unmodifiable(result);
  }

  bool get isEmpty => lines.isEmpty && (plain?.trim().isEmpty ?? true);
}

class LyricsRepository extends ExtrasRepository {
  LyricsRepository({
    required super.transport,
    required super.authority,
    required super.fence,
    required super.networkPolicy,
  });
  Future<LyricsDocument> get(Track track) => lookup(track);
  Future<LyricsDocument> lookup(Track track) async {
    final dto = collectionObject(
      await request(
        '/api/lyrics/${Uri.encodeComponent(extrasTrackId(track))}',
        query: {
          'artist': track.artist,
          'title': track.title,
          if (track.album != null) 'album': track.album!,
          if (track.duration != null && track.duration! > Duration.zero)
            'duration': '${track.duration!.inSeconds}',
        },
      ),
    );
    if (dto['synced'] is! bool ||
        dto['source'] is! String ||
        (dto['plainLyrics'] != null && dto['plainLyrics'] is! String) ||
        (dto['syncedLyrics'] != null && dto['syncedLyrics'] is! String)) {
      throw collectionFailure(StateError('lyrics shape'));
    }
    return LyricsDocument(
      plain: dto['plainLyrics'] as String?,
      synced: dto['synced'] == true ? dto['syncedLyrics'] as String? : null,
      source: dto['source'] as String,
    );
  }
}
