import '../../core/mapping/home_track_mapper.dart';
import '../../core/model/app_failure.dart';
import '../../core/model/owner_key.dart';
import '../../core/model/queue_entry.dart';
import '../../core/model/track.dart';
import '../../core/model/track_ref.dart';
import '../../core/network/api_transport.dart';
import '../../core/network/network_policy.dart';
import '../../playback/playback_event_models.dart';
import '../../playback/play_create_protocol.dart';
import '../../core/network/request_cancellation.dart';
import '../../playback/wave_selection.dart';
import 'recommendation_models.dart';
export 'recommendation_models.dart';

/// Recommendation and listening endpoints share the admitted ApiTransport.
class RecommendationRepository {
  const RecommendationRepository({
    required this.transport,
    this.networkPolicy = const NetworkPolicy.online(),
  });
  final ApiTransport transport;
  final NetworkPolicy networkPolicy;
  Future<RecommendationPage> wave(
    WaveSelection selection,
    SessionFence fence, {
    int? cursor,
    Iterable<TrackRef> exclusions = const [],
    required String sessionId,
    DateTime? now,
  }) async {
    final time = now ?? DateTime.now();
    final excluded = exclusions
        .map(continuationIdentity)
        .whereType<String>()
        .toSet()
        .toList();
    networkPolicy.requireNetwork();
    final response = await transport.send(
      ApiRequest(
        origin: fence.owner.serverOrigin,
        method: ApiMethod.get,
        path: '/api/personalized/home',
        query: {
          'limit': '25',
          'surface': 'wave',
          'mode': waveModeWire(selection.mode),
          'sessionId': sessionId,
          'deviceClass': 'mobile',
          'localHour': '${time.hour}',
          'timezoneOffsetMinutes': '${time.timeZoneOffset.inMinutes}',
          if (cursor != null) 'cursor': '$cursor',
          if (selection.mood != null) 'mood': selection.mood!.name,
          if (selection.language != WaveLanguage.any)
            'language': selection.language.name,
          if (excluded.isNotEmpty)
            'exclude': excluded
                .skip(excluded.length > 80 ? excluded.length - 80 : 0)
                .join(','),
        },
      ),
      fence: fence,
    );
    response.requireSuccess();
    final data = _object(response.data);
    final shelves = _object(data['shelves']);
    List<Track> lane(String name) {
      final rows = shelves[name];
      if (rows is! List) throw _shape;
      return rows
          .map((row) => const HomeTrackMapper().map(_object(row)))
          .toList();
    }

    final discovery = lane('discovery'),
        quick = lane('quickPicks'),
        recent = lane('listenAgain');
    List<Track> unique(Iterable<Track> tracks) {
      final ids = <String>{};
      return tracks.where((t) => ids.add(t.ref.identityKey)).toList();
    }

    late final List<Track> selected;
    switch (selection.mode) {
      case WaveMode.newMusic:
        selected = unique(discovery);
      case WaveMode.familiar:
        selected = unique(recent.isNotEmpty ? recent : quick);
      case WaveMode.forYou:
        if (discovery.isEmpty) {
          selected = unique(quick.isNotEmpty ? quick : recent);
          break;
        }
        final fresh = unique(discovery),
            saved = unique(quick)
                .where((t) => !fresh.any((f) => f.ref == t.ref))
                .iterator;
        final interleaved = <Track>[];
        for (var i = 0; i < fresh.length; i++) {
          interleaved.add(fresh[i]);
          if ((i + 1) % 4 == 0 && saved.moveNext()) {
            interleaved.add(saved.current);
          }
        }
        final replay = unique(recent)
            .where((t) => !interleaved.any((f) => f.ref == t.ref))
            .iterator;
        selected = [];
        for (var i = 0; i < interleaved.length; i++) {
          selected.add(interleaved[i]);
          if ((i + 1) % 15 == 0 && replay.moveNext()) {
            selected.add(replay.current);
          }
        }
    }
    final next = data['nextCursor'];
    if (next != null && (next is! int || next < 0 || next > 1000000)) {
      throw _shape;
    }
    final generation = data['generationId'];
    if (generation != null &&
        (generation is! String ||
            generation.isEmpty ||
            generation.length > 128)) {
      throw _shape;
    }
    return RecommendationPage(
      tracks: selected,
      nextCursor: next as int?,
      generationId: generation as String?,
      reason: data['reason'] as String?,
      languagePending:
          data['languageStatus'] is Map &&
          (data['languageStatus'] as Map)['pending'] == true,
    );
  }

  /// Call only with the exact ordered cards actually exposed by the UI.
  /// Fetching a page or preparing background audio never calls this method.
  Future<void> reportVisible(
    String generationId,
    Iterable<Track> orderedVisible,
    SessionFence fence,
  ) async {
    final identities = orderedVisible
        .map((t) => impressionIdentity(t.ref))
        .whereType<Map<String, Object?>>()
        .toList();
    if (identities.isEmpty) return;
    if (identities.length > 100 ||
        generationId.isEmpty ||
        generationId.length > 128) {
      throw ArgumentError('Invalid visible impression batch');
    }
    networkPolicy.requireNetwork();
    final response = await transport.send(
      ApiRequest(
        origin: fence.owner.serverOrigin,
        method: ApiMethod.post,
        path: '/api/personalized/impressions',
        body: {'generationId': generationId, 'tracks': identities},
      ),
      fence: fence,
    );
    response.requireSuccess();
  }

  Future<String> startPlay(
    QueueEntry entry,
    SessionFence fence, {
    String? playbackRunId,
  }) async {
    networkPolicy.requireNetwork();
    final response = await transport.send(
      ApiRequest(
        origin: fence.owner.serverOrigin,
        method: ApiMethod.post,
        path: '/api/plays',
        playbackRunId: playbackRunId,
        body: playStartBody(entry),
      ),
      fence: fence,
    );
    response.requireSuccess();
    final id = _object(response.data)['id'];
    if (id is! String || id.trim().isEmpty || id.length > 512) throw _shape;
    return id;
  }

  /// Only the create journal calls this versioned, same-key operation.
  Future<PlayCreateAck> createKeyedPlay(
    FrozenPlayCreate payload,
    PlayCreateKey key,
    SessionFence fence, {
    String? playbackRunId,
    RequestCancellation? cancellation,
  }) async {
    networkPolicy.requireNetwork();
    cancellation?.check();
    final response = await transport.send(
      ApiRequest(
        origin: fence.owner.serverOrigin,
        method: ApiMethod.post,
        path: '/api/plays/idempotent',
        body: {...payload.body, 'clientPlaybackId': key.value},
        playbackRunId: playbackRunId,
        cancellation: cancellation,
      ),
      fence: fence,
    );
    cancellation?.check();
    response.requireSuccess();
    if (response.statusCode != 200) {
      throw const FormatException('Invalid create status');
    }
    return PlayCreateAck.decode(response.data, key);
  }

  Future<void> updatePlay(
    String playId,
    PlayEngagement engagement,
    SessionFence fence, {
    String? playbackRunId,
  }) async {
    networkPolicy.requireNetwork();
    final response = await transport.send(
      ApiRequest(
        origin: fence.owner.serverOrigin,
        method: ApiMethod.patch,
        path: '/api/plays/${Uri.encodeComponent(playId)}/engagement',
        playbackRunId: playbackRunId,
        body: engagement.toJson(),
      ),
      fence: fence,
    );
    response.requireSuccess();
  }

  static const _shape = AppFailure(
    code: 'invalid_recommendation_response',
    message: 'Некорректный ответ рекомендаций',
  );
  static Map<String, Object?> _object(Object? value) {
    if (value is! Map<String, Object?>) throw _shape;
    return value;
  }
}
