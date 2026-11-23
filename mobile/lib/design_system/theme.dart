import 'package:flutter/material.dart';

import 'tokens.dart';

abstract final class SoundspanTheme {
  static ThemeData dark() {
    const scheme = ColorScheme.dark(
      primary: MusicColors.primary,
      onPrimary: MusicColors.onPrimary,
      primaryContainer: MusicColors.primaryContainer,
      onPrimaryContainer: MusicColors.onPrimaryContainer,
      secondary: MusicColors.primary,
      onSecondary: MusicColors.onPrimary,
      secondaryContainer: MusicColors.primaryContainer,
      onSecondaryContainer: MusicColors.onPrimaryContainer,
      tertiary: MusicColors.success,
      surface: MusicColors.canvas,
      onSurface: MusicColors.text,
      onSurfaceVariant: MusicColors.textSecondary,
      surfaceContainerLowest: MusicColors.canvas,
      surfaceContainerLow: MusicColors.surface1,
      surfaceContainer: MusicColors.surface2,
      surfaceContainerHigh: MusicColors.surface3,
      surfaceContainerHighest: MusicColors.surface3,
      inverseSurface: MusicColors.text,
      onInverseSurface: MusicColors.canvas,
      error: MusicColors.error,
      onError: MusicColors.canvas,
      errorContainer: MusicColors.errorContainer,
      onErrorContainer: MusicColors.error,
      outline: MusicColors.outlineStrong,
      outlineVariant: MusicColors.outline,
      scrim: Colors.black,
      surfaceTint: Colors.transparent,
    );
    TextStyle type(
      double size,
      double line,
      FontWeight weight, [
      double spacing = 0,
    ]) => TextStyle(
      fontSize: size,
      height: line / size,
      fontWeight: weight,
      letterSpacing: spacing,
      color: MusicColors.text,
    );
    final typography = TextTheme(
      displaySmall: type(36, 40, FontWeight.w700, -0.6),
      headlineMedium: type(28, 34, FontWeight.w700, -0.4),
      headlineSmall: type(24, 30, FontWeight.w700, -0.2),
      titleLarge: type(20, 26, FontWeight.w600, -0.1),
      titleMedium: type(16, 22, FontWeight.w600),
      bodyLarge: type(16, 24, FontWeight.w400),
      bodyMedium: type(14, 20, FontWeight.w400),
      bodySmall: type(12, 16, FontWeight.w400),
      labelLarge: type(14, 20, FontWeight.w600, 0.1),
      labelMedium: type(12, 16, FontWeight.w600, 0.1),
      labelSmall: type(11, 14, FontWeight.w500),
    );
    final focusSide = WidgetStateProperty.resolveWith<BorderSide?>(
      (states) => states.contains(WidgetState.focused)
          ? const BorderSide(color: MusicColors.primary, width: 2)
          : null,
    );
    final buttonStyle = ButtonStyle(
      minimumSize: const WidgetStatePropertyAll(Size(48, 52)),
      padding: const WidgetStatePropertyAll(
        EdgeInsets.symmetric(horizontal: 20, vertical: 14),
      ),
      side: focusSide,
      shape: WidgetStatePropertyAll(
        RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      ),
    );
    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      colorScheme: scheme,
      scaffoldBackgroundColor: MusicColors.canvas,
      canvasColor: MusicColors.canvas,
      textTheme: typography,
      primaryTextTheme: typography,
      focusColor: MusicColors.selection,
      hoverColor: MusicColors.primary.withValues(alpha: 0.08),
      highlightColor: MusicColors.primary.withValues(alpha: 0.08),
      splashColor: MusicColors.primary.withValues(alpha: 0.12),
      materialTapTargetSize: MaterialTapTargetSize.padded,
      visualDensity: VisualDensity.standard,
      appBarTheme: const AppBarTheme(
        backgroundColor: MusicColors.canvas,
        foregroundColor: MusicColors.text,
        elevation: 0,
        scrolledUnderElevation: 0,
        surfaceTintColor: Colors.transparent,
        toolbarHeight: 56,
        titleSpacing: 20,
        titleTextStyle: TextStyle(
          color: MusicColors.text,
          fontSize: 22,
          height: 1.2,
          fontWeight: FontWeight.w700,
          letterSpacing: -0.3,
        ),
      ),
      textSelectionTheme: const TextSelectionThemeData(
        cursorColor: MusicColors.primary,
        selectionColor: MusicColors.selection,
        selectionHandleColor: MusicColors.primary,
      ),
      filledButtonTheme: FilledButtonThemeData(style: buttonStyle),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: buttonStyle.copyWith(
          side: WidgetStateProperty.resolveWith(
            (states) => BorderSide(
              color: states.contains(WidgetState.focused)
                  ? MusicColors.primary
                  : MusicColors.outlineStrong,
              width: states.contains(WidgetState.focused) ? 2 : 1,
            ),
          ),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: buttonStyle.copyWith(
          minimumSize: const WidgetStatePropertyAll(Size(48, 48)),
          padding: const WidgetStatePropertyAll(
            EdgeInsets.symmetric(horizontal: 12, vertical: 12),
          ),
        ),
      ),
      iconButtonTheme: IconButtonThemeData(
        style: ButtonStyle(
          minimumSize: const WidgetStatePropertyAll(Size.square(48)),
          side: focusSide,
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: MusicColors.surface1,
        contentPadding: const EdgeInsets.all(16),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: MusicColors.outlineStrong),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: MusicColors.outlineStrong),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: MusicColors.primary, width: 2),
        ),
        errorMaxLines: 4,
      ),
      bottomSheetTheme: const BottomSheetThemeData(
        backgroundColor: MusicColors.surface3,
        surfaceTintColor: Colors.transparent,
        modalBarrierColor: MusicColors.scrim,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
        ),
      ),
      dividerTheme: const DividerThemeData(
        color: MusicColors.outline,
        thickness: 1,
        space: 1,
      ),
      listTileTheme: ListTileThemeData(
        iconColor: MusicColors.textSecondary,
        textColor: MusicColors.text,
        titleTextStyle: typography.titleMedium,
        subtitleTextStyle: typography.bodyMedium?.copyWith(
          color: MusicColors.textSecondary,
        ),
        minVerticalPadding: 12,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
      chipTheme: ChipThemeData(
        backgroundColor: MusicColors.surface1,
        selectedColor: MusicColors.primaryContainer,
        labelStyle: typography.labelLarge,
        side: const BorderSide(color: MusicColors.outline),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
      navigationRailTheme: const NavigationRailThemeData(
        backgroundColor: MusicColors.canvas,
        indicatorColor: MusicColors.primaryContainer,
        selectedIconTheme: IconThemeData(color: MusicColors.primary),
        unselectedIconTheme: IconThemeData(color: MusicColors.textSecondary),
      ),
      snackBarTheme: const SnackBarThemeData(
        backgroundColor: MusicColors.surface3,
        contentTextStyle: TextStyle(color: MusicColors.text),
        actionTextColor: MusicColors.primary,
        behavior: SnackBarBehavior.floating,
      ),
      progressIndicatorTheme: const ProgressIndicatorThemeData(
        color: MusicColors.primary,
      ),
    );
  }
}
