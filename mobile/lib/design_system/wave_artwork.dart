import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'tokens.dart';

/// Decorative Wave identity. It never represents buffering or audio levels.
/// A single transition follows Play/Pause; there is no perpetual idle ticker.
class WaveArtwork extends StatelessWidget {
  const WaveArtwork({super.key, this.active = false});
  final bool active;

  @override
  Widget build(BuildContext context) => ExcludeSemantics(
    child: TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: active ? 1 : 0),
      duration: MusicMotion.duration(context, MusicMotion.player),
      curve: MusicMotion.curve,
      builder: (_, phase, _) => CustomPaint(
        painter: _WavePainter(phase),
        child: const SizedBox.expand(),
      ),
    ),
  );
}

class _WavePainter extends CustomPainter {
  const _WavePainter(this.phase);
  final double phase;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round;
    for (var line = 0; line < 7; line++) {
      final path = Path();
      for (var step = 0; step <= 64; step++) {
        final t = step / 64;
        final envelope = math.pow(math.sin(t * math.pi), 1.4);
        final wave = math.sin(t * math.pi * 2.5 + line * .24 + phase * .8);
        final x = size.width * t;
        final y =
            size.height * .5 +
            wave * envelope * size.height * (.22 + phase * .06) +
            (line - 3) * size.height * .065;
        if (step == 0) {
          path.moveTo(x, y);
        } else {
          path.lineTo(x, y);
        }
      }
      paint
        ..strokeWidth = line == 3 ? 2.6 : 1.3
        ..color = MusicColors.primary.withValues(
          alpha: line == 3 ? .95 : .23 + (3 - (line - 3).abs()) * .12,
        );
      canvas.drawPath(path, paint);
    }
  }

  @override
  bool shouldRepaint(_WavePainter oldDelegate) => phase != oldDelegate.phase;
}
