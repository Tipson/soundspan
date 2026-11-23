import '../../playback/playback_controller.dart';
import '../../core/model/track.dart';
import '../lyrics/lyrics_controller.dart';
import 'related_repository.dart';

class RelatedController extends ExtrasController {
  RelatedController({
    required RelatedRepository repository,
    required PlaybackController playback,
  }) : super(repository, playback);
  Track? _seed;
  RelatedFeed? _feed;
  Track? get seed => isCurrent ? _seed : null;
  RelatedFeed? get feed => isCurrent ? _feed : null;
  Future<void> open(Track track) async {
    cancel();
    _seed = track;
    _feed = null;
    await work((value) async {
      final result = await (repository as RelatedRepository).get(track);
      if (current(value)) _feed = result;
    });
  }

  Future<void> retry() async {
    final seed = _seed;
    if (seed != null) await open(seed);
  }

  Future<void> play(int index) => playTracks(
    feed?.tracks ?? [],
    index,
    context: PlayContext(
      surface: PlaySurface.library,
      recommendationGenerationId: feed?.generationId,
    ),
  );
  Future<void> enqueue(int index) async {
    final rows = feed?.tracks ?? [];
    if (index >= 0 && index < rows.length) await enqueueTracks([rows[index]]);
  }
}
