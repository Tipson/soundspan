import 'dart:async';
import 'dart:io';

import '../core/model/app_failure.dart';
import '../core/model/owner_key.dart';
import '../core/model/track_ref.dart';
import '../core/model/track.dart';
import '../core/network/network_policy.dart';
import '../features/likes/likes_models.dart';
import '../features/likes/likes_repository.dart';
import 'download_models.dart';
import 'download_repository.dart';
import 'automatic_download_control.dart';

typedef ScheduleDeviceDownload = Future<String> Function(
  String id,
  SessionFence originalFence,
  int generation,
);
typedef CancelDeviceDownload = Future<void> Function(
  String id,
  SessionFence originalFence,
  int generation,
);

/// Admission of confirmed liked tracks into the existing durable download index.
/// This class never transfers bytes, requests permissions, or evicts ready files.
final class LikedDownloadAutomation {
  LikedDownloadAutomation({
    required this.downloads,
    required this.likes,
    required this.fence,
    required this.networkPolicy,
    required this.storageReady,
    required this.schedule,
    required this.cancelJob,
    this.quality = 'original',
  }) {
    if (likes.fence != fence) throw ArgumentError('Mismatched likes owner');
    _changes = downloads.changes.listen((id) {
      if (!_closed) unawaited(_track(() => _observe(id)));
    });
  }
  final DownloadRepository downloads;
  final LikesRepository likes;
  final SessionFence fence;
  final NetworkPolicy networkPolicy;
  final bool Function() storageReady;
  final ScheduleDeviceDownload schedule;
  final CancelDeviceDownload cancelJob;
  final String quality;
  static const namespace = AutomaticDownloadControl.namespace;
  final _signals = <String, PreferenceSignal>{};
  final _pending = <Future<void>>{};
  late final StreamSubscription<String> _changes;
  Future<void>? _reconciling;
  bool _scanAgain = false;
  Future<void>? _closing;
  bool _closed = false;
  bool _paused = false;
  int _revision = 0;
  String? notice;
  bool get paused => _paused;
  bool get isCurrent => !_closed && downloads.authority.isCurrent(fence);

  Future<void> _track(Future<void> Function() operation) {
    late final Future<void> result;
    result = operation()
        .catchError((Object error, StackTrace stack) {
          // A normal owner revocation/close drains admitted work without exposing
          // a cancellation as an unhandled stream-listener or root-close failure.
          if (isCurrent) Error.throwWithStackTrace(error, stack);
        })
        .whenComplete(() => _pending.remove(result));
    _pending.add(result);
    return result;
  }

  Future<bool> readPaused() async {
    final revision = _revision;
    final row = await downloads.store.transaction(
      fence,
      (tx) => tx.read(namespace, AutomaticDownloadControl.key),
    );
    if (revision == _revision) _paused = AutomaticDownloadControl.paused(row);
    return _paused;
  }

  bool _admitted(int revision) =>
      isCurrent &&
      !_paused &&
      revision == _revision &&
      storageReady() &&
      networkPolicy.networkAllowed;

  /// The fence supplied by the caller must be the one captured at construction.
  Future<void> reconcile(SessionFence originalFence) {
    if (originalFence != fence || !isCurrent) return Future.value();
    final running = _reconciling;
    if (running != null) {
      _scanAgain = true;
      return running;
    }
    return _reconciling = _track(() async {
      do {
        _scanAgain = false;
        await _reconcile();
      } while (_scanAgain && isCurrent && !_paused);
    }).whenComplete(() => _reconciling = null);
  }

  Future<void> _reconcile() async {
    final revision = _revision;
    try {
      await readPaused();
      if (!_admitted(revision)) return;
      LikedCursor? cursor;
      final cursors = <LikedCursor>{};
      final seen = <String>{};
      do {
        if (!_admitted(revision)) return;
        networkPolicy.requireNetwork();
        final page = await likes.page(cursor, limit: 500);
        if (!_admitted(revision)) return;
        for (final track in page.tracks) {
          if (!_admitted(revision)) return;
          if (seen.add(track.ref.identityKey)) {
            await _admitTrack(track, revision);
          }
        }
        if (!page.hasMore) break;
        cursor = page.nextCursor;
        if (cursor == null || !cursors.add(cursor)) {
          throw const AppFailure(
            code: 'invalid_likes_cursor',
            message:
                'Не удалось продолжить список Любимого. Повторите обновление.',
          );
        }
      } while (true);
    } catch (error) {
      if (isCurrent) {
        if (_storageException(error)) {
          await _storagePause();
        } else if (error is AppFailure) {
          notice = error.message;
        } else {
          notice =
              'Не удалось обновить автоматические загрузки. Повторите позже.';
        }
      }
    }
  }

  bool _stillLiked(TrackRef ref) =>
      _signals[ref.identityKey] == null ||
      _signals[ref.identityKey] == PreferenceSignal.like;

  Future<void> _admitTrack(Track track, int revision) async {
    if (!_admitted(revision) || !track.playable || !_stillLiked(track.ref)) {
      return;
    }
    try {
      await downloads.authority.assertCurrent(fence);
      if (!_admitted(revision) || !_stillLiked(track.ref)) return;
      networkPolicy.requireNetwork();
      var job = await downloads.enqueue(track, quality, fence, manual: false);
      if (!_admitted(revision) || !_stillLiked(track.ref)) {
        await _stopAuto(job);
        return;
      }
      if (job.state == DownloadState.ready || job.originalFence != fence) {
        return;
      }
      if (job.state == DownloadState.paused) {
        if (job.manual) return;
        final previousGeneration = job.generation;
        job = await downloads.resume(
          job.id,
          fence,
          expectedGeneration: previousGeneration,
        );
        if (job.generation != previousGeneration + 1 ||
            job.state != DownloadState.queued) {
          return;
        }
        if (!_admitted(revision) || !_stillLiked(track.ref)) {
          await _stopAuto(job);
          return;
        }
      }
      networkPolicy.requireNetwork();
      await schedule(job.id, job.originalFence, job.generation);
      if (!_admitted(revision) || !_stillLiked(track.ref)) await _stopAuto(job);
    } catch (error) {
      if (!isCurrent) return;
      if (_storageException(error)) {
        await _storagePause();
        return;
      }
      notice = 'Некоторые загрузки недоступны. Остальные продолжаются; повторите неудавшиеся в Загрузках.';
    }
  }

  /// Observes a visible screen snapshot, including commits by a headless engine.
  /// Workers persist the canonical control with each storage failure. Historical
  /// errors explain an existing pause but cannot undo an explicit re-enable.
  Future<void> observeSnapshot(Iterable<DeviceDownload> jobs) async {
    if (!isCurrent) return;
    await readPaused();
    if (isCurrent && _paused && jobs.any((j) => _storageError(j.errorCode))) {
      notice = _storageNotice;
    }
  }

  static bool _storageError(String? code) => const {
    'download_storage_error',
    'download_storage_full',
    'storage_full',
  }.contains(code);
  static bool _storageException(Object error) =>
      error is FileSystemException ||
      (error is AppFailure && _storageError(error.code));
  Future<void> _observe(String id) async {
    try {
      final job = await downloads.status(id, fence);
      if (isCurrent) await observeSnapshot([?job]);
    } catch (_) {
      /* Revocation closes admission; no fallback owner. */
    }
  }

  static const _storageNotice =
      'Автозагрузка приостановлена из-за ошибки хранилища. Проверьте свободное место и доступ к памяти, затем продолжите.';

  Future<void> _storagePause() async {
    notice = _storageNotice;
    if (!_paused && isCurrent) await setPaused(true, fence);
  }

  /// Pausing is owner durable, including a later login of the same owner.
  Future<void> setPaused(bool value, SessionFence originalFence) {
    if (originalFence != fence || !isCurrent) return Future.value();
    _paused = value;
    if (!value) notice = null;
    final revision = ++_revision;
    return _track(() async {
      await downloads.store.transaction(
        fence,
        (tx) => tx.write(
          namespace,
          AutomaticDownloadControl.key,
          AutomaticDownloadControl.encode(value),
        ),
      );
      if (value && revision == _revision) {
        for (final job in await downloads.list(fence)) {
          if (!isCurrent || revision != _revision) return;
          await _stopAuto(job);
        }
      }
    });
  }

  Future<void> _stopAuto(DeviceDownload job) async {
    if (!isCurrent ||
        job.manual ||
        job.state == DownloadState.ready ||
        job.originalFence != fence) {
      return;
    }
    final cancelled = await downloads.cancel(
      job.id,
      fence,
      expectedGeneration: job.generation,
      automaticOnly: true,
    );
    if (cancelled) await cancelJob(job.id, job.originalFence, job.generation);
  }

  /// Call only after the shared PreferenceController confirms the server write.
  Future<void> onPreferenceChanged(
    TrackRef ref,
    PreferenceSignal signal, {
    Track? knownTrack,
  }) {
    if (!isCurrent) return Future.value();
    if (knownTrack != null && knownTrack.ref != ref) {
      throw ArgumentError('Mismatched confirmed recording');
    }
    _signals[ref.identityKey] = signal;
    if (signal == PreferenceSignal.like) {
      if (knownTrack == null) return reconcile(fence);
      final revision = _revision;
      return _track(() async {
        await readPaused();
        if (!_admitted(revision)) return;
        await observeSnapshot(await downloads.list(fence));
        await _admitTrack(knownTrack, revision);
      });
    }
    return _track(() async {
      for (final job in await downloads.list(fence)) {
        if (!isCurrent) return;
        if (job.track.ref == ref) await _stopAuto(job);
      }
    });
  }

  /// Root drains this before admitting jobs for another session epoch.
  Future<void> close() => _closing ??= () async {
    _closed = true;
    _revision++;
    await _changes.cancel();
    while (_pending.isNotEmpty) {
      await Future.wait(List.of(_pending));
    }
  }();
  Future<void> dispose() => close();
}
