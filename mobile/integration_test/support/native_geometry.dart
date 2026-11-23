import 'dart:ui';

/// A control may touch the viewport edge without extending outside it.
bool containsControlRect(Rect viewport, Rect control) =>
    control.left >= viewport.left &&
    control.top >= viewport.top &&
    control.right <= viewport.right &&
    control.bottom <= viewport.bottom;
