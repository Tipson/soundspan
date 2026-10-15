import 'package:flutter/material.dart';

/// Soundspan's fixed palette. Wallpaper accents never replace music controls.
abstract final class MusicColors {
  static const canvas = Color(0xFF151413);
  static const surface1 = Color(0xFF1D1B1A);
  static const surface2 = Color(0xFF282524);
  static const surface3 = Color(0xFF302C2B);
  static const text = Color(0xFFF5F1EB);
  static const textSecondary = Color(0xFFC6BFB9);
  static const textMuted = Color(0xFFA89F99);
  static const primary = Color(0xFFC9AAF2);
  static const onPrimary = Color(0xFF21172E);
  static const primaryContainer = Color(0xFF3D304A);
  static const onPrimaryContainer = Color(0xFFEBDDFC);
  static const error = Color(0xFFFFB4AB);
  static const errorContainer = Color(0xFF512B28);
  static const success = Color(0xFFB8D1B0);
  static const warning = Color(0xFFE8C48D);
  static const outline = Color(0xFF514A46);
  static const outlineStrong = Color(0xFF8F8581);
  static const scrim = Color(0xA3000000);
  static const selection = Color(0x52C9AAF2);
}

abstract final class MusicSpace {
  static const xxs = 2.0;
  static const xs = 4.0;
  static const sm = 8.0;
  static const md = 12.0;
  static const lg = 16.0;
  static const xl = 20.0;
  static const xxl = 24.0;
  static const section = 28.0;
  static const s32 = 32.0;
  static const s40 = 40.0;
  static const s48 = 48.0;
  static const s64 = 64.0;
  static double gutter(double width) =>
      width >= 600 ? 24 : (width >= 360 ? 20 : 16);
}

abstract final class MusicRadius {
  static const input = 12.0;
  static const artwork = 8.0;
  static const card = 16.0;
  static const hero = 20.0;
  static const sheet = 28.0;
  static const pill = 999.0;
}

abstract final class MusicMotion {
  static const fast = Duration(milliseconds: 120);
  static const standard = Duration(milliseconds: 220);
  static const navigation = Duration(milliseconds: 280);
  static const player = Duration(milliseconds: 360);
  static const image = Duration(milliseconds: 180);
  static const curve = Cubic(0.2, 0, 0, 1);
  static Duration duration(BuildContext context, Duration normal) =>
      MediaQuery.disableAnimationsOf(context) ? Duration.zero : normal;
}
