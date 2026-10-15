import 'dart:math' as math;

enum LoudnessMode { off, track, album, auto }

class LoudnessDecision {
  const LoudnessDecision(this.gainDb, this.reason);
  final double gainDb;
  final String reason;
  double get gainFactor => math.pow(10, gainDb / 20).toDouble();
}

double? _finite(Object? value) =>
    value is num && value.isFinite ? value.toDouble() : null;

/// Mirrors frontend/lib/audio-engine/loudnessGainPolicy.ts, including album
/// fallback and denial of boosts when the selected scope has no peak measure.
LoudnessDecision resolveLoudnessGain({
  required Map<String, Object?>? track,
  LoudnessMode mode = LoudnessMode.auto,
  double targetLufs = -18,
  bool isAlbumContext = false,
}) {
  if (mode == LoudnessMode.off) return const LoudnessDecision(0, 'mode_off');
  if (track == null) return const LoudnessDecision(0, 'no_track');
  if (!targetLufs.isFinite) return const LoudnessDecision(0, 'invalid_target');
  var lufs = _finite(track['loudnessLufs']);
  var peak = _finite(track['truePeakDb']);
  final album = track['album'] is Map ? track['album'] as Map : const {};
  final albumLufs =
      _finite(track['albumLoudnessLufs']) ??
      _finite(album['albumLoudnessLufs']);
  if ((mode == LoudnessMode.album ||
          mode == LoudnessMode.auto && isAlbumContext) &&
      albumLufs != null) {
    lufs = albumLufs;
    peak =
        _finite(track['albumTruePeakDb']) ??
        _finite(album['albumTruePeakDb']) ??
        peak;
  }
  if (lufs == null) return const LoudnessDecision(0, 'unmeasured');
  final desired = targetLufs - lufs;
  if (desired <= 0) return LoudnessDecision(desired, 'leveled');
  if (peak == null) return const LoudnessDecision(0, 'boost_denied_no_peak');
  final granted = math.min(desired, math.min(3.0, math.max(0.0, -peak)));
  return LoudnessDecision(
    granted,
    granted < desired ? 'boost_clamped' : 'leveled',
  );
}

bool isAlbumOrderedQueue(List<String?> albumIds, bool shuffle) =>
    !shuffle &&
    albumIds.isNotEmpty &&
    albumIds.length <= 500 &&
    albumIds.first != null &&
    albumIds.first!.isNotEmpty &&
    albumIds.every((id) => id == albumIds.first);

const gainRampStepDuration = Duration(milliseconds: 25);
List<double> computeGainRampSteps(double from, double to, {double steps = 8}) {
  if (!from.isFinite || !to.isFinite) return [to];
  final count = steps.isFinite ? steps.round().clamp(1, 32) : 8;
  if (from == to || count <= 1) return [to];
  return [
    for (var i = 1; i <= count; i++)
      i == count ? to : from + (to - from) * i / count,
  ];
}
