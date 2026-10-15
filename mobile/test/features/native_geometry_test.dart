import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';

import '../../integration_test/support/native_geometry.dart';

void main() {
  const viewport = Rect.fromLTWH(0, 0, 320, 844);
  test('entire viewport is contained including its boundary', () {
    expect(containsControlRect(viewport, viewport), isTrue);
  });
  test('right edge control remains fully inside', () {
    expect(
      containsControlRect(viewport, const Rect.fromLTWH(272, 24, 48, 48)),
      isTrue,
    );
  });
  test('bottom edge control remains fully inside', () {
    expect(
      containsControlRect(viewport, const Rect.fromLTWH(24, 796, 48, 48)),
      isTrue,
    );
  });
  test('partial overlap on any side is rejected', () {
    for (final rect in [
      const Rect.fromLTWH(-1, 24, 48, 48),
      const Rect.fromLTWH(24, -1, 48, 48),
      const Rect.fromLTWH(273, 24, 48, 48),
      const Rect.fromLTWH(24, 797, 48, 48),
    ]) {
      expect(containsControlRect(viewport, rect), isFalse);
    }
  });
  test('ordinary inset control remains contained', () {
    expect(
      containsControlRect(viewport, const Rect.fromLTWH(224, 24, 48, 48)),
      isTrue,
    );
  });
}
