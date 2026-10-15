import '../../core/model/app_failure.dart';
import '../../core/model/owner_key.dart';
import '../../core/model/play_context.dart';
import '../../core/model/track.dart';
export '../../core/model/owner_key.dart' show SessionFence;

/// Capabilities come from server config; clock values come from the device.
final class HomeRequest {
  HomeRequest({
    required this.localHour,
    required this.timezoneOffsetMinutes,
    required this.autoPlaylists,
    required this.discovery,
    this.mode = WaveMode.forYou,
    this.mood,
  }) {
    if (localHour < 0 || localHour > 23 || timezoneOffsetMinutes.abs() > 840) {
      throw ArgumentError('Invalid local listening context');
    }
  }
  factory HomeRequest.at(
    DateTime now, {
    required bool autoPlaylists,
    required bool discovery,
  }) => HomeRequest(
    localHour: now.hour,
    timezoneOffsetMinutes: now.timeZoneOffset.inMinutes,
    autoPlaylists: autoPlaylists,
    discovery: discovery,
  );
  final int localHour, timezoneOffsetMinutes;
  final bool autoPlaylists, discovery;
  final WaveMode mode;
  final String? mood;
}

enum MusicMixKind { daily, dailyBlend, daypart, weekly, legacy }

/// A displayed composition, retaining endpoint kind and exact occurrence order.
final class MusicMix {
  MusicMix({
    required this.id,
    required this.title,
    required this.description,
    required this.kind,
    Iterable<Track> tracks = const [],
    this.generationId,
    int? trackCount,
    this.artwork,
    this.reason,
    this.languagePending = false,
    this.loaded = true,
    this.weekStart,
    this.weekEnd,
  }) : tracks = List.unmodifiable(tracks),
       trackCount = trackCount ?? tracks.length;
  final String id, title, description;
  final MusicMixKind kind;
  final List<Track> tracks;
  final int trackCount;
  final Uri? artwork;
  final String? generationId, reason, weekStart, weekEnd;
  final bool languagePending, loaded;
  int get playableCount => tracks.where((t) => t.playable).length;
  int get unavailableCount => (trackCount - playableCount).clamp(0, trackCount);
  Uri? get cover => artwork ?? (tracks.isEmpty ? null : tracks.first.artwork);
  String get identity => '${kind.name}:$id';
}

final class HomeShelf {
  HomeShelf({
    required this.id,
    required this.title,
    required Iterable<Track> tracks,
    this.generationId,
  }) : tracks = List.unmodifiable(tracks);
  final String id, title;
  final List<Track> tracks;
  final String? generationId;
}

final class HomeFeed {
  HomeFeed({
    Iterable<HomeShelf> shelves = const [],
    Iterable<MusicMix> mixes = const [],
    Map<String, AppFailure> failures = const {},
    this.reason,
    this.generationId,
    this.languagePending = false,
    this.serverDegraded = false,
  }) : shelves = List.unmodifiable(shelves),
       mixes = List.unmodifiable(mixes),
       failures = Map.unmodifiable(failures);
  final List<HomeShelf> shelves;
  final List<MusicMix> mixes;
  final Map<String, AppFailure> failures;
  final String? reason, generationId;
  final bool languagePending, serverDegraded;
  bool get degraded => serverDegraded || failures.isNotEmpty || languagePending;
  bool get insufficientTaste =>
      reason == 'insufficient_signals' && !languagePending;
  bool get empty => shelves.every((s) => s.tracks.isEmpty) && mixes.isEmpty;
}

enum MixSaveStatus { idle, saving, saved, uncertain }

final class MixSaveReceipt {
  const MixSaveReceipt({required this.playlistId, required this.message});
  final String playlistId, message;
}

/// Composition performs the explicit compatible-subset preview before create.
typedef SaveMusicMix = Future<MixSaveReceipt?> Function(
  MusicMix mix,
  SessionFence fence,
);
typedef ReconcileMusicMix = Future<MixSaveReceipt?> Function(
  MusicMix mix,
  SessionFence fence,
);

const homeStale = AppFailure(
  code: 'stale_session',
  message: 'Аккаунт изменился. Откройте раздел снова.',
);
AppFailure homeFailure(Object error) => error is AppFailure
    ? error
    : const AppFailure(
        code: 'home_failed',
        message: 'Не удалось загрузить музыку. Проверьте подключение и повторите попытку.',
        retryable: true,
      );

String daypartTitle(int hour) => hour < 6
    ? 'Ваша ночь'
    : hour < 12
    ? 'Ваше утро'
    : hour < 18
    ? 'Ваш день'
    : 'Ваш вечер';
