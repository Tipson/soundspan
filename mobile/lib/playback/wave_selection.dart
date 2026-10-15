import '../core/model/play_context.dart';
export '../core/model/play_context.dart' show WaveMode;

enum WaveMood { calm, energetic, focus, workout, favorites, forgotten }

enum WaveLanguage { any, ru, foreign }

String waveModeWire(WaveMode mode) => switch (mode) {
  WaveMode.forYou => 'for-you',
  WaveMode.newMusic => 'new',
  WaveMode.familiar => 'familiar',
};

/// Existing server-supported choices; closing a sheet does not apply a choice.
final class WaveSelection {
  const WaveSelection({
    this.mode = WaveMode.forYou,
    this.mood,
    this.language = WaveLanguage.any,
  });
  final WaveMode mode;
  final WaveMood? mood;
  final WaveLanguage language;
  @override
  bool operator ==(Object other) =>
      other is WaveSelection &&
      other.mode == mode &&
      other.mood == mood &&
      other.language == language;
  @override
  int get hashCode => Object.hash(mode, mood, language);
}
