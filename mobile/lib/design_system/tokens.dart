import 'package:flutter/material.dart';

/// Soundspan's fixed palette. Wallpaper accents never replace music controls.
abstract final class MusicColors {
  static const canvas = Color(0xFF121114);
  static const surface1 = Color(0xFF1C1A20);
  static const surface2 = Color(0xFF28252E);
  static const surface3 = Color(0xFF322E38);
  static const text = Color(0xFFF6F2F7);
  static const textSecondary = Color(0xFFC2BBC9);
  static const textMuted = Color(0xFFA79FAD);
  static const primary = Color(0xFFC5A6EF);
  static const onPrimary = Color(0xFF21172E);
  static const primaryContainer = Color(0xFF362A45);
  static const onPrimaryContainer = Color(0xFFEBDDFC);
  static const error = Color(0xFFFFB4AB);
  static const errorContainer = Color(0xFF512B28);
  static const success = Color(0xFFB8D1B0);
  static const warning = Color(0xFFE8C48D);
  static const outline = Color(0xFF48424F);
  static const outlineStrong = Color(0xFF918697);
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
