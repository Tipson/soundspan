import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/features/lyrics/lyrics_repository.dart';

void main() {
  test('malformed timestamp cannot discard valid lyrics or plain fallback', () {
    const document = LyricsDocument(
      plain: 'Обычный текст',
      synced:
          '[999999999999999999999999:00]invalid\n'
          '[9223372036854775807:01]overflow\n'
          '[00:99.000]seconds\n[00:02.50]valid',
    );
    expect(document.isEmpty, isFalse);
    expect(document.plain, 'Обычный текст');
    expect(document.lines.map((line) => line.text), ['valid']);
    expect(document.lines.single.position, const Duration(milliseconds: 2500));
  });

  test('timestamp arithmetic preserves the actual Duration bound', () {
    const document = LyricsDocument(
      synced:
          '[153722867280:54.775]last\n'
          '[153722867280:54.776]overflow\n'
          '[153722867281:00.000]overflow',
    );
    expect(document.lines.map((line) => line.text), ['last']);
    expect(document.lines.single.position.inMilliseconds, 9223372036854775);
    expect(document.lines.single.position >= Duration.zero, isTrue);
  });

  test(
    'multiple ordinary timestamps remain ordered and fractions retain units',
    () {
      const document = LyricsDocument(synced: '[01:00][00:01.2][00:02:03]line');
      expect(document.lines.map((line) => line.position.inMilliseconds), [
        1200,
        2030,
        60000,
      ]);
      expect(document.lines.map((line) => line.text), ['line', 'line', 'line']);
    },
  );
}
