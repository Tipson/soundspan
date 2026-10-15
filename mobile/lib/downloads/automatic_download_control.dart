/// Shared durable policy for UI admission and headless device workers.
/// A future or malformed row cannot silently turn background downloading on.
abstract final class AutomaticDownloadControl {
  static const namespace = 'likedDownloadAutomation.v1';
  static const key = 'control';

  static bool paused(Map<String, Object?>? row) =>
      row != null &&
      (row['version'] is! int ||
          row['version'] != 1 ||
          row['paused'] is! bool ||
          row['paused'] == true);

  static Map<String, Object?> encode(bool paused) => {
    'version': 1,
    'paused': paused,
  };
}
