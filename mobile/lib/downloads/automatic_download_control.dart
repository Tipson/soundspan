/// Shared durable policy for UI admission and headless device workers.
/// Version 2 retains the choice while legacy version-1 readers pause automation.
/// Future or malformed rows cannot silently turn background downloading on.
abstract final class AutomaticDownloadControl {
  static const namespace = 'likedDownloadAutomation.v1';
  static const key = 'control';

  static bool paused(Map<String, Object?>? row) =>
      row != null &&
      (row['version'] is! int ||
          (row['version'] != 1 && row['version'] != 2) ||
          row['paused'] is! bool ||
          row['paused'] == true);

  static Map<String, Object?> encode(bool paused) => {
    'version': 2,
    'paused': paused,
  };
}
