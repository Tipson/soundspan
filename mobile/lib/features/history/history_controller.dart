import '../../playback/playback_controller.dart';
import '../../core/model/app_failure.dart';
import '../library/library_models.dart';
import '../lyrics/lyrics_controller.dart';
import 'history_repository.dart';

class HistoryController extends ExtrasController {
  HistoryController({
    required HistoryRepository repository,
    required PlaybackController playback,
  }) : super(repository, playback);
  HistoryPage? _page;
  HistorySummary? _summary;
  HistoryPage? get page => isCurrent ? _page : null;
  HistorySummary? get summary => isCurrent ? _summary : null;
  bool uncertain = false;
  String? message;
  Future<void> load() async {
    await work((value) async {
      final repo = repository as HistoryRepository;
      final result = await repo.page();
      if (current(value)) _page = result;
      final totals = await repo.summary();
      if (current(value)) {
        _summary = totals;
        uncertain = false;
        message = null;
      }
    }, newRevision: true);
  }

  Future<void> more() async {
    final cursor = page?.nextCursor;
    if (cursor == null) return;
    await work((value) async {
      final result = await (repository as HistoryRepository).page(cursor);
      if (current(value)) _page = result;
    });
  }

  Future<void> clear(
    HistoryRange range, {
    required int confirmationRevision,
  }) async {
    if (!current(confirmationRevision) || uncertain) return;
    await work((value) async {
      int? acknowledgedCount;
      try {
        final count = await (repository as HistoryRepository).clear(
          range,
          current: () => current(value),
        );
        if (!current(value)) return;
        acknowledgedCount = count;
        _page = null;
        _summary = null;
        message = 'Удалено записей: $count';
        final result = await (repository as HistoryRepository).page();
        if (current(value)) _page = result;
        final totals = await (repository as HistoryRepository).summary();
        if (current(value)) _summary = totals;
      } catch (e) {
        if (current(value)) {
          final failure = e is AppFailure ? e : null;
          final refused =
              failure?.code == 'offline_mode' ||
              failure?.code == 'stale_session' ||
              (failure?.statusCode != null && failure!.statusCode! < 500);
          uncertain = acknowledgedCount != null || !refused;
          message = acknowledgedCount != null
              ? 'Удалено записей: $acknowledgedCount. Не удалось обновить список; обновите историю.'
              : uncertain
              ? 'Результат очистки неизвестен. Обновите историю перед новым действием.'
              : null;
        }
        rethrow;
      }
    });
  }

  Future<void> play(int index) => playTracks([
    for (final row in page?.entries ?? <HistoryEntry>[]) row.track,
  ], index);
  Future<void> enqueue(int index) async {
    final rows = page?.entries ?? [];
    if (index >= 0 && index < rows.length) {
      await enqueueTracks([rows[index].track]);
    }
  }

  Future<void> admitConfirmation(int value) async {
    await guard(value);
    if (busy || uncertain) throw collectionStaleSession;
  }
}
