import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/downloads/automatic_download_control.dart';

void main() {
  test(
    'network-policy control is readable here and closes legacy automation',
    () {
      final enabled = AutomaticDownloadControl.encode(false);
      expect(enabled, {'version': 2, 'paused': false});
      expect(AutomaticDownloadControl.paused(enabled), isFalse);
      expect(
        AutomaticDownloadControl.paused({'version': 2, 'paused': true}),
        isTrue,
      );
    },
  );

  test('legacy choices survive; malformed and future controls stay paused', () {
    expect(AutomaticDownloadControl.paused(null), isFalse);
    expect(
      AutomaticDownloadControl.paused({'version': 1, 'paused': false}),
      isFalse,
    );
    expect(
      AutomaticDownloadControl.paused({'version': 1, 'paused': true}),
      isTrue,
    );
    for (final row in [
      {'version': 3, 'paused': false},
      {'version': '2', 'paused': false},
      {'version': 2, 'paused': 'false'},
      <String, Object?>{'paused': false},
    ]) {
      expect(AutomaticDownloadControl.paused(row), isTrue);
    }
  });
}
