import 'dart:async';
import 'dart:io';

import '../core/model/app_failure.dart';
import '../core/model/owner_key.dart';
import '../core/network/media_response_validator.dart';
import '../core/network/network_policy.dart';
import '../playback/playback_resolver.dart';
import '../playback/resolved_media.dart';
import 'download_checkpoint.dart';
import 'download_models.dart';
import 'download_repository.dart';
import 'protected_media_fetcher.dart';

final class DownloadCoordinator {
  DownloadCoordinator({
    required this.repository,
    required this.resolverForQuality,
    required this.fetcher,
    required this.networkPolicy,
    this.revalidateNetwork,
    this.beforeWrite,
    this.reserveWrite,
    this.onWriterDrained,
  });
  final DownloadRepository repository;
  final PlaybackResolver Function(String) resolverForQuality;
  final ProtectedMediaFetcher fetcher;
  final NetworkPolicy networkPolicy;

  /// Re-read durable rules and active-route facts for this exact claimed job.
  final Future<void> Function(DeviceDownload claim)? revalidateNetwork;

  /// Capacity admission before each bounded private-file write.
  final Future<void> Function(int bytes)? beforeWrite;

  /// Reserve this exact claim's resulting file length before its write.
  final Future<void> Function(DeviceDownload claim, int nextLength)?
  reserveWrite;

  /// Optional accounting after confirmed private-file and response drain.
  final Future<void> Function(DeviceDownload claim)? onWriterDrained;
  final Set<MediaCancellation> _active = {};
  final Set<MediaCancellation> _networkTransfers = {};
  final Set<MediaCancellation> _networkDeferrals = {};
  final Set<Future<void>> _pending = {};
  bool _closed = false;

  /// Foreground and headless workers call this same transfer pipeline. No
  /// credential or resolved URL is persisted in the job or checkpoint.
  Future<DownloadRunResult> run(
    String id,
    SessionFence originalFence,
    int generation,
  ) {
    if (_closed) return Future.value(DownloadRunResult.cancelled);
    final done = Completer<void>();
    _pending.add(done.future);
    return _run(id, originalFence, generation).whenComplete(() {
      _pending.remove(done.future);
      done.complete();
    });
  }

  Future<DownloadRunResult> _run(
    String id,
    SessionFence originalFence,
    int generation,
  ) async {
    if (_closed) return DownloadRunResult.cancelled;
    DeviceDownload? claimed;
    try {
      claimed = await repository.claim(id, originalFence, generation);
    } catch (error) {
      return !repository.authority.isCurrent(originalFence)
          ? DownloadRunResult.cancelled
          : error is FormatException
          ? DownloadRunResult.failed
          : DownloadRunResult.retry;
    }
    if (claimed == null) {
      try {
        final current = await repository.status(id, originalFence);
        if (current == null ||
            current.originalFence != originalFence ||
            current.generation != generation) {
          return DownloadRunResult.cancelled;
        }
        if (current.state == DownloadState.ready) {
          return DownloadRunResult.ready;
        }
        if (current.retryNotBefore > repository.now) {
          return DownloadRunResult.retry;
        }
        return current.writer != null
            ? DownloadRunResult.busy
            : DownloadRunResult.cancelled;
      } catch (_) {
        return DownloadRunResult.cancelled;
      }
    }
    final job = claimed;
    final cancel = MediaCancellation();
    _active.add(cancel);
    if (_closed) cancel.cancel();
    ProtectedMediaResponse? response;
    RandomAccessFile? sink;
    Future<void>? heartbeat;
    final timer = Timer.periodic(const Duration(milliseconds: 250), (_) {
      if (heartbeat != null) return;
      heartbeat = repository
          .heartbeat(job)
          .catchError((Object _) {
            cancel.cancel();
          })
          .whenComplete(() => heartbeat = null);
    });
    final events = repository.changes.where((id) => id == job.id).listen((_) {
      unawaited(
        repository.assertClaim(job).catchError((Object _) {
          cancel.cancel();
        }),
      );
    });
    var networkTransfer = false;
    Future<void> check() async {
      cancel.check();
      await repository.assertClaim(job);
      cancel.check();
      if (networkTransfer) {
        networkPolicy.requireNetwork();
        await revalidateNetwork?.call(job);
        cancel.check();
      }
    }

    Future<void> write(List<int> chunk) async {
      const limit = 256 * 1024;
      for (var start = 0; start < chunk.length; start += limit) {
        final end = start + limit < chunk.length ? start + limit : chunk.length;
        await check();
        await beforeWrite?.call(end - start);
        if (reserveWrite != null) {
          final nextLength = await sink!.position() + end - start;
          await reserveWrite!(job, nextLength);
        }
        await check();
        await sink!.writeFrom(chunk, start, end);
      }
    }

    try {
      await check();
      final part = await repository.paths.file(
        originalFence.owner,
        id,
        generation,
        job.writer!,
      );
      var offset = 0;
      int? total;
      String? etag;
      final previous = job.checkpoint;
      var complete = false;
      if (previous != null && (previous.resumable || previous.sha256 != null)) {
        var source = await repository.paths.file(
          originalFence.owner,
          id,
          previous.generation,
          previous.claim,
        );
        if (!await source.exists() && previous.sha256 != null) {
          source = await repository.paths.file(
            originalFence.owner,
            id,
            previous.generation,
            previous.claim,
            ready: true,
          );
        }
        if (await source.exists() && await source.length() >= previous.bytes) {
          sink = await repository.paths.io.openWrite(part, append: false);
          await for (final chunk in source.openRead(0, previous.bytes)) {
            await write(chunk);
          }
          await sink.flush();
          await sink.close();
          sink = null;
          offset = previous.bytes;
          total = previous.totalBytes;
          etag = previous.strongEtag;
          complete =
              previous.sha256 != null &&
              await repository.verifier.matches(
                part,
                bytes: offset,
                digest: previous.sha256!,
              );
          if (previous.sha256 != null && !complete) {
            offset = 0;
            total = null;
            etag = null;
          }
        }
      }
      if (!complete) {
        networkTransfer = true;
        _networkTransfers.add(cancel);
        networkPolicy.requireNetwork();
        await check();
        final media = await resolverForQuality(job.quality).resolve(
          job.track.ref,
          ResolvePurpose.download,
          originalFence,
          cancellation: cancel,
        );
        await check();
        networkPolicy.requireNetwork();
        ByteRange? range = offset > 0 ? ByteRange(start: offset) : null;
        try {
          response = await fetcher.open(
            media,
            originalFence,
            range: range,
            ifRange: range == null ? null : etag,
            expectedTotal: range == null ? null : total,
            cancellation: cancel,
            admitRequest: check,
          );
        } on AppFailure catch (error) {
          if (range == null || error.code != 'invalid_media') rethrow;
          // A changed validator/total or invalid resumed range is never appended.
          range = null;
          offset = 0;
          total = null;
          etag = null;
          networkPolicy.requireNetwork();
          await check();
          response = await fetcher.open(
            media,
            originalFence,
            cancellation: cancel,
            admitRequest: check,
          );
        }
        var validated = MediaResponseValidator.validate(
          statusCode: response.statusCode,
          headers: response.headers,
          range: range,
          ifRange: range == null ? null : etag,
          expectedTotal: range == null ? null : total,
        );
        if (response.statusCode == 416) {
          await response.close();
          networkPolicy.requireNetwork();
          await check();
          range = null;
          offset = 0;
          total = null;
          etag = null;
          response = await fetcher.open(
            media,
            originalFence,
            cancellation: cancel,
            admitRequest: check,
          );
          validated = MediaResponseValidator.validate(
            statusCode: response.statusCode,
            headers: response.headers,
          );
        }
        if (validated.actualStart == 0) {
          offset = 0;
        } else if (validated.actualStart != offset ||
            offset == 0 ||
            response.headers['etag'] != etag ||
            validated.totalLength != total) {
          throw invalidMedia;
        }
        total = validated.totalLength;
        etag = DownloadCheckpoint.isStrongEtag(response.headers['etag'])
            ? response.headers['etag']
            : null;
        sink = await repository.paths.io.openWrite(part, append: offset > 0);
        await repository.updateClaim(
          job,
          checkpoint: DownloadCheckpoint(
            generation: generation,
            claim: job.writer!,
            bytes: offset,
            totalBytes: total,
            strongEtag: etag,
          ),
        );
        await for (final chunk in response.body) {
          await write(chunk);
          offset += chunk.length;
          if (total != null && offset > total) throw invalidMedia;
          // Flush before the durable count advances; recovery copies at most
          // this count and discards any unsynced/uncommitted tail.
          await sink.flush();
          await repository.updateClaim(
            job,
            checkpoint: DownloadCheckpoint(
              generation: generation,
              claim: job.writer!,
              bytes: offset,
              totalBytes: total,
              strongEtag: etag,
            ),
          );
        }
        // The complete body and its final checkpoint have arrived. Verifying
        // these local bytes does not require keeping a network permission.
        networkTransfer = false;
        _networkTransfers.remove(cancel);
        await sink.flush();
        await sink.close();
        sink = null;
      }
      await check();
      await repository.updateClaim(
        job,
        state: DownloadState.verifying,
        checkpoint: DownloadCheckpoint(
          generation: generation,
          claim: job.writer!,
          bytes: offset,
          totalBytes: total,
          strongEtag: etag,
        ),
      );
      final verified = await repository.verifier.verify(
        part,
        expectedBytes: total,
      );
      await check();
      final cp = DownloadCheckpoint(
        generation: generation,
        claim: job.writer!,
        bytes: verified.bytes,
        totalBytes: verified.bytes,
        strongEtag: etag,
        sha256: verified.sha256,
      );
      // Journal the verified bytes before rename. Both a surviving part and a
      // finalized orphan are recoverable; neither is exposed until ready commit.
      await repository.updateClaim(
        job,
        state: DownloadState.verifying,
        checkpoint: cp,
      );
      await check();
      final target = await repository.paths.file(
        originalFence.owner,
        id,
        generation,
        job.writer!,
        ready: true,
      );
      await repository.paths.file(
        originalFence.owner,
        id,
        generation,
        job.writer!,
      );
      await check();
      await repository.paths.io.rename(part, target);
      await check();
      await repository.updateClaim(
        job,
        state: DownloadState.ready,
        checkpoint: cp,
        release: true,
      );
      return DownloadRunResult.ready;
    } catch (error) {
      final deferred =
          _networkDeferrals.contains(cancel) &&
          !_closed &&
          repository.authority.isCurrent(originalFence);
      final cancelled =
          (!deferred && cancel.isCancelled) ||
          !repository.authority.isCurrent(originalFence) ||
          (!deferred &&
              error is AppFailure &&
              const {'media_cancelled', 'stale_session'}.contains(error.code));
      final code = deferred
          ? 'download_network_restricted'
          : error is AppFailure
          ? error.code
          : error is FileSystemException
          ? (error.osError?.errorCode == 28
                ? 'download_storage_full'
                : 'download_storage_error')
          : 'download_failed';
      try {
        await repository.updateClaim(
          job,
          state: cancelled ? DownloadState.paused : DownloadState.failed,
          errorCode: code,
          release: true,
          pauseAutomaticDownloads: error is FileSystemException,
          retryNotBefore:
              error is AppFailure && error.retryable && error.retryAfter != null
              ? repository.now + error.retryAfter!.inMilliseconds
              : null,
        );
      } catch (_) {
        /* Revoked fence/claim: never touch the replacement. */
      }
      return deferred
          ? DownloadRunResult.retry
          : cancelled
          ? DownloadRunResult.cancelled
          : (error is FileSystemException ||
                    (error is AppFailure && error.retryable)
                ? DownloadRunResult.retry
                : DownloadRunResult.failed);
    } finally {
      timer.cancel();
      await events.cancel();
      if (heartbeat != null) await heartbeat;
      cancel.cancel();
      var drained = true;
      try {
        await response?.close();
      } catch (_) {
        drained = false;
        /* Preserve the recorded failure. */
      }
      try {
        await sink?.close();
      } catch (_) {
        drained = false;
        /* A failed flush/close was already reported. */
      }
      if (drained && onWriterDrained != null) {
        try {
          await onWriterDrained!(job);
        } catch (_) {
          // A retained quota reservation is conservative. A ready commit must
          // not become a retry just because optional accounting is unavailable.
        }
      }
      _networkTransfers.remove(cancel);
      _networkDeferrals.remove(cancel);
      _active.remove(cancel);
    }
  }

  /// Route/policy changes stop only transfers; local verification may finish.
  void cancelNetworkTransfers({bool retryWhenAllowed = false}) {
    for (final cancel in List.of(_networkTransfers)) {
      if (retryWhenAllowed) _networkDeferrals.add(cancel);
      cancel.cancel();
    }
  }

  Future<void> close() async {
    _closed = true;
    for (final cancel in List.of(_active)) {
      cancel.cancel();
    }
    await Future.wait(List.of(_pending));
  }
}
