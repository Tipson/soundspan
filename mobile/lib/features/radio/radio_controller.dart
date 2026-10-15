import '../../playback/playback_controller.dart';
import '../../core/model/app_failure.dart';
import '../lyrics/lyrics_controller.dart';
import 'radio_repository.dart';

class RadioController extends ExtrasController {
  RadioController({
    required RadioRepository repository,
    required PlaybackController playback,
  }) : super(repository, playback);
  RadioSeed? _seed;
  RadioStation? _station;
  RadioSeed? get seed => isCurrent ? _seed : null;
  RadioStation? get station => isCurrent ? _station : null;
  bool uncertain = false;
  String? _pendingId;
  bool get canMutate =>
      isCurrent &&
      !busy &&
      !uncertain &&
      repository.networkPolicy.networkAllowed;
  bool get canReconcile =>
      isCurrent && !busy && (_pendingId ?? station?.playlistId) != null;
  void select(RadioSeed seed) {
    if (_seed?.identity == seed.identity) return;
    cancel();
    _seed = seed;
    _station = null;
    _pendingId = null;
    uncertain = false;
    changed();
  }

  Future<void> generate() async {
    final seed = this.seed;
    if (seed == null || !canMutate) return;
    await _mutation(
      (repo, valid) => repo.start(seed, current: valid),
      persisted: seed.persisted,
    );
  }

  Future<void> append() async {
    final id = station?.playlistId;
    if (id == null || !canMutate) return;
    await _mutation((repo, valid) => repo.append(id, current: valid));
  }

  Future<void> regenerate() async {
    final id = station?.playlistId;
    if (id == null || !canMutate) return;
    await _mutation((repo, valid) => repo.regenerate(id, current: valid));
  }

  Future<void> _mutation(
    Future<RadioStation> Function(RadioRepository, bool Function()) action, {
    bool persisted = true,
  }) async {
    await work((value) async {
      try {
        final result = await action(
          repository as RadioRepository,
          () => current(value),
        );
        if (current(value)) {
          _station = result;
          _pendingId = result.playlistId;
        }
      } catch (e) {
        if (current(value) && e is RadioReadbackFailure) {
          _pendingId = e.playlistId;
        }
        final failure = e is AppFailure ? e : null;
        if (current(value) &&
            persisted &&
            failure?.code != 'offline_mode' &&
            failure?.code != 'stale_session' &&
            (failure?.statusCode == null || failure!.statusCode! >= 500)) {
          uncertain = true;
        }
        rethrow;
      }
    });
  }

  Future<void> reconcile() async {
    final id = _pendingId ?? station?.playlistId;
    if (id == null) return;
    await work((value) async {
      final result = await (repository as RadioRepository).reconcile(
        id,
        current: () => current(value),
      );
      if (current(value)) {
        _station = result;
        uncertain = false;
      }
    });
  }

  Future<void> more() async {
    final seed = this.seed, cursor = station?.nextCursor;
    if (seed == null || cursor == null || seed.persisted) return;
    await work((value) async {
      final result = await (repository as RadioRepository).readSeed(
        seed,
        cursor: cursor,
        current: () => current(value),
      );
      if (current(value)) {
        _station = RadioStation(
          tracks: [...?_station?.tracks, ...result.tracks],
          nextCursor: result.nextCursor,
          generationId: result.generationId,
          degradedSources: result.degradedSources,
        );
      }
    });
  }

  Future<void> play([int? index]) => playTracks(
    station?.tracks ?? [],
    index ?? (station?.tracks.indexWhere((track) => track.playable) ?? -1),
    context: PlayContext(
      surface: PlaySurface.library,
      recommendationGenerationId: station?.generationId,
    ),
  );
  Future<void> enqueue() => enqueueTracks(
    station?.tracks ?? [],
    context: PlayContext(
      surface: PlaySurface.library,
      recommendationGenerationId: station?.generationId,
    ),
  );
}
