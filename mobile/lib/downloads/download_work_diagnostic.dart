import 'dart:async';
import 'dart:io';

import 'package:flutter/services.dart';

import '../core/model/app_failure.dart';

enum DownloadWorkerPhase {
  attach,
  storage,
  network,
  refresh,
  file,
  manifest,
  drain,
}

/// Closed, non-identifying worker evidence. Never serialize exception messages,
/// runtimeType, request metadata or arbitrary persisted error strings.
abstract final class DownloadWorkDiagnostic {
  static const codes = {
    'none',
    'unknown',
    'app_failure_other',
    'format',
    'type',
    'state',
    'platform',
    'io',
    'timeout',
    'permission',
    'cancelled',
    'invalid_work_request',
    'worker_protocol',
    'worker_channel_error',
    'worker_unimplemented',
    'engine_startup_timeout',
    'legacy_upgrade',
    'broker_unavailable',
    'broker_protocol',
    'stale_session',
    'session_revoked',
    'session_unavailable',
    'offline_mode',
    'invalid_media',
    'media_cancelled',
    'network_cancelled',
    'network_timeout',
    'network_unavailable',
    'media_network_error',
    'media_idle_timeout',
    'tls_failed',
    'download_network_restricted',
    'download_consent_stale',
    'download_storage_full',
    'download_storage_error',
    'offline_mix_quota_exceeded',
    'offline_mix_refresh_waiting',
    'offline_mix_refresh_stale',
    'offline_mix_refresh_holdoff',
    'offline_mix_refresh_source_unavailable',
    'offline_mix_not_saved',
    'offline_mix_manual_pending',
    'offline_mix_source_incomplete',
    'offline_mix_file_unavailable',
    'download_failed',
    'download_corrupt',
    'download_cancelled',
    'offline_mix_refresh_disabled',
    'media_busy',
    'recording_unavailable',
    'invalid_track_shape',
    'invalid_api_target',
    'api_redirect_rejected',
    'invalid_http_response',
    'invalid_json',
    'invalid_json_type',
    'response_too_large',
    'http_error',
    'unauthorized',
    'http_400',
    'http_401',
    'http_403',
    'http_404',
    'http_408',
    'http_409',
    'http_413',
    'http_416',
    'http_425',
    'http_429',
    'http_500',
    'http_502',
    'http_503',
    'http_504',
  };
  static const jobStates = {
    'queued',
    'downloading',
    'paused',
    'verifying',
    'ready',
    'failed',
    'removing',
  };
  static const refreshStates = {
    'idle',
    'waiting',
    'complete',
    'manual_pending',
    'quota',
    'storage',
    'failed',
    'paused',
    'holdoff',
    'source_unavailable',
    'conditions',
  };

  static String safeCode(String? value) => value == null
      ? 'none'
      : codes.contains(value)
      ? value
      : 'app_failure_other';
  static String safeState(String? value) {
    if (value == null) return 'unknown';
    if (value.isEmpty) return 'idle';
    if (value == 'unknown' ||
        jobStates.contains(value) ||
        refreshStates.contains(value)) {
      return value;
    }
    final pair = value.split('/');
    return pair.length == 2 &&
            refreshStates.contains(pair[0]) &&
            jobStates.contains(pair[1])
        ? value
        : 'unknown';
  }

  static String errorCode(Object error) {
    if (error is AppFailure) {
      final http = 'http_${error.statusCode}';
      return error.code == 'http_error' && codes.contains(http)
          ? http
          : safeCode(error.code);
    }
    return switch (error) {
      FormatException() => 'format',
      TypeError() => 'type',
      StateError() => 'state',
      PlatformException() => 'platform',
      TimeoutException() => 'timeout',
      FileSystemException() => 'io',
      _ => 'unknown',
    };
  }

  static Map<String, Object?> capture({
    required DownloadWorkerPhase phase,
    Object? error,
    String? code,
    String? state,
  }) => {
    'phase': phase.name,
    'code': error == null ? safeCode(code) : errorCode(error),
    'state': safeState(state),
  };

  /// Optional evidence must never replace the settled core worker result.
  static Future<Map<String, Object?>> inspect({
    required DownloadWorkerPhase phase,
    required Future<({String? code, String? state})> Function() read,
  }) async {
    try {
      final value = await read();
      return capture(phase: phase, code: value.code, state: value.state);
    } catch (error) {
      return capture(phase: phase, error: error);
    }
  }
}
