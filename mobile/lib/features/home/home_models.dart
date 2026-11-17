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

/// Server composition metadata. Invalid metadata never invalidates its tracks.
final class MixSnapshot {
  MixSnapshot._({
    required this.generatedAt,
    required this.compositionDay,
    required this.weekStart,
    required this.weekEnd,
    required this.refreshAfter,
    required this.requestedCount,
    required this.snapshotCount,
    required this.availableCount,
    required Iterable<String> reasons,
  }) : reasons = List.unmodifiable(reasons);

  final DateTime? generatedAt, weekStart, weekEnd;
  final String? compositionDay;
  final DateTime refreshAfter;
  final int requestedCount, snapshotCount, availableCount;
  final List<String> reasons;

  static const _reasonLabels = {
    'provider_degraded': 'Часть музыки временно недоступна',
    'feedback_filtered': 'С учётом ваших оценок',
    'pool_limited': 'Пока меньше подходящих треков',
  };
  static const _months = [
    'января',
    'февраля',
    'марта',
    'апреля',
    'мая',
    'июня',
    'июля',
    'августа',
    'сентября',
    'октября',
    'ноября',
    'декабря',
  ];

  /// Dates are rendered in the same UTC day used by daily composition policy.
  List<String> get labels => [
    if (generatedAt case final date?)
      'Составлен ${date.day} ${_months[date.month - 1]} ${date.year}',
    for (final reason in reasons) ?_reasonLabels[reason],
  ];

  static MixSnapshot? tryParse(Object? value) {
    if (value is! Map) return null;
    final refreshAfter = _instant(value['refreshAfter']);
    if (refreshAfter == null) return null;
    for (final field in ['requestedCount', 'snapshotCount', 'availableCount']) {
      if (value[field] is! int || (value[field] as int) < 0) return null;
    }
    final reasons = value['reasons'];
    if (reasons is! List || reasons.any((reason) => reason is! String)) {
      return null;
    }
    for (final field in ['generatedAt', 'weekStart', 'weekEnd']) {
      if (value[field] != null && _instant(value[field]) == null) return null;
    }
    final day = value['compositionDay'];
    if (day != null &&
        (day is! String ||
            !RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(day) ||
            _instant('${day}T00:00:00Z') == null)) {
      return null;
    }
    return MixSnapshot._(
      generatedAt: _instant(value['generatedAt']),
      compositionDay: day as String?,
      weekStart: _instant(value['weekStart']),
      weekEnd: _instant(value['weekEnd']),
      refreshAfter: refreshAfter,
      requestedCount: value['requestedCount'] as int,
      snapshotCount: value['snapshotCount'] as int,
      availableCount: value['availableCount'] as int,
      reasons: reasons.cast<String>(),
    );
  }

  static DateTime? _instant(Object? value) {
    if (value is! String ||
        !RegExp(
          r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$',
        ).hasMatch(value)) {
      return null;
    }
    // DateTime.tryParse normalizes invalid calendar values such as February 30.
    final local = DateTime.tryParse('${value.substring(0, 19)}Z');
    if (local == null ||
        local.toIso8601String().substring(0, 19) != value.substring(0, 19)) {
      return null;
    }
    return DateTime.tryParse(value)?.toUtc();
  }
}

/// An empty daily direction is informational and cannot become a play target.
final class HomeMixStatus {
  const HomeMixStatus({
    required this.id,
    required this.title,
    required this.snapshot,
  });
  final String id, title;
  final MixSnapshot snapshot;
}

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
    this.snapshot,
  }) : tracks = List.unmodifiable(tracks),
       trackCount = trackCount ?? tracks.length;
  final String id, title, description;
  final MusicMixKind kind;
  final List<Track> tracks;
  final int trackCount;
  final Uri? artwork;
  final String? generationId, reason, weekStart, weekEnd;
  final bool languagePending, loaded;
  final MixSnapshot? snapshot;
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
    Iterable<HomeMixStatus> mixStatuses = const [],
    Map<String, AppFailure> failures = const {},
    this.reason,
    this.generationId,
    this.languagePending = false,
    this.serverDegraded = false,
  }) : shelves = List.unmodifiable(shelves),
       mixes = List.unmodifiable(mixes),
       mixStatuses = List.unmodifiable(mixStatuses),
       failures = Map.unmodifiable(failures);
  final List<HomeShelf> shelves;
  final List<MusicMix> mixes;
  final List<HomeMixStatus> mixStatuses;
  final Map<String, AppFailure> failures;
  final String? reason, generationId;
  final bool languagePending, serverDegraded;
  bool get degraded => serverDegraded || failures.isNotEmpty || languagePending;
  bool get insufficientTaste =>
      reason == 'insufficient_signals' && !languagePending;
  bool get empty =>
      shelves.every((s) => s.tracks.isEmpty) &&
      mixes.isEmpty &&
      mixStatuses.isEmpty;
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
