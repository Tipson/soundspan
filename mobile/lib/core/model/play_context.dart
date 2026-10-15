enum PlaySurface { wave, home, search, playlist, album, artist, library }

enum WaveMode { forYou, newMusic, familiar }

/// Attribution captured when an item enters the queue, independent of UI tabs.
final class PlayContext {
  const PlayContext({
    required this.surface,
    this.waveMode,
    this.recommendationGenerationId,
    this.recommendationSessionId,
  });

  final PlaySurface surface;
  final WaveMode? waveMode;
  final String? recommendationGenerationId;
  final String? recommendationSessionId;
}
