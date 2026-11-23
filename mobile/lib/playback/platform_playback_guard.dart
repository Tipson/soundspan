import 'dart:async';

import 'package:flutter/services.dart';

import 'queue_coordinator.dart';

/// Observes a native service refusal without guessing which owner caused it.
final class PlatformPlaybackGuard {
  PlatformPlaybackGuard({
    required QueueCoordinator coordinator,
    required Stream<Object> errors,
    required Future<bool?> Function() foreground,
    Future<void> Function()? settle,
  }) {
    _subscription = errors.listen((error) {
      if (error is! PlatformException) return;
      final message = '${error.code} ${error.message ?? ''}'.toLowerCase();
      if (!(message.contains('foregroundservicestartnotallowedexception') ||
          message.contains('startforegroundservice') &&
              message.contains('not allowed'))) {
        return;
      }
      final captured = coordinator.snapshot,
          revision = coordinator.intentRevision;
      if (!captured.playing || captured.fence == null) return;
      bool current() {
        final now = coordinator.snapshot;
        return !_disposed &&
            now.playing &&
            now.fence == captured.fence &&
            now.lineage == captured.lineage &&
            now.generation == captured.generation &&
            now.currentEntryId == captured.currentEntryId &&
            coordinator.intentRevision == revision;
      }

      unawaited(() async {
        // A late refusal can arrive while another admitted start is in flight.
        // Check the service invariant after grace, never infer its owner from the
        // global error stream or stop a newly starting service immediately.
        await (settle?.call() ??
            Future<void>.delayed(const Duration(seconds: 5)));
        if (!current()) return;
        bool? active;
        try {
          active = await foreground();
        } catch (_) {
          // Unknown native state is not evidence that foreground is absent.
          return;
        }
        if (current() && active == false) {
          await coordinator.reportPlatformFailure(captured, revision);
        }
      }());
    });
  }
  late final StreamSubscription<Object> _subscription;
  bool _disposed = false;
  static Future<bool?> readAndroidForeground() =>
      const MethodChannel('soundspan/playback_service')
          .invokeMethod<bool>('foreground');
  Future<void> dispose() {
    _disposed = true;
    return _subscription.cancel();
  }
}
