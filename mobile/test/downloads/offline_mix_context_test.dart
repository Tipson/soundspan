import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/play_context.dart';
import 'package:soundspan/core/storage/music_codec.dart';

void main() {
  test(
    'offline mix queue context retains its exact file generation after restore',
    () {
      final restored = MusicCodec.decodePlayContext(
        MusicCodec.encodePlayContext(
          const PlayContext(
            surface: PlaySurface.library,
            offlineMixGeneration: 17,
          ),
        ),
      );
      expect(restored.offlineMixGeneration, 17);
      expect(restored.surface, PlaySurface.library);
    },
  );

  test('ordinary legacy queue payload stays unchanged and accepts missing new metadata', () {
    final value = MusicCodec.encodePlayContext(
      const PlayContext(surface: PlaySurface.library),
    );
    expect(value.containsKey('offlineMixGeneration'), isFalse);
    expect(MusicCodec.decodePlayContext(value).offlineMixGeneration, isNull);
  });

  test(
    'malformed or automatic offline context is rejected without fallback',
    () {
      final legacy = MusicCodec.encodePlayContext(
        const PlayContext(surface: PlaySurface.library),
      );
      for (final invalid in [0, -1, true, '17', 1.0, 9007199254740992]) {
        expect(
          () => MusicCodec.decodePlayContext({
            ...legacy,
            'offlineMixGeneration': invalid,
          }),
          throwsFormatException,
        );
      }
      expect(
        () => MusicCodec.encodePlayContext(
          const PlayContext(
            surface: PlaySurface.wave,
            offlineMixGeneration: 17,
          ),
        ),
        throwsFormatException,
      );
    },
  );
}
