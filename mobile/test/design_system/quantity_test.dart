import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/design_system/design_system.dart';

void main() {
  test('music counts use Russian forms for one, few, teens and hundreds', () {
    for (final sample in <int, String>{
      0: '0 треков',
      1: '1 трек',
      2: '2 трека',
      5: '5 треков',
      11: '11 треков',
      12: '12 треков',
      21: '21 трек',
      24: '24 трека',
      101: '101 трек',
      111: '111 треков',
    }.entries) {
      expect(
        musicQuantity(sample.key, one: 'трек', few: 'трека', many: 'треков'),
        sample.value,
      );
    }
    expect(
      musicQuantity(2, one: 'подборка', few: 'подборки', many: 'подборок'),
      '2 подборки',
    );
  });
}
