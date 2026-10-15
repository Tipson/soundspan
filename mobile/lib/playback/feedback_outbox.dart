import 'dart:async';

import '../core/model/owner_key.dart';
import '../core/model/app_failure.dart';
import '../core/network/network_policy.dart';
import '../core/session/session_authority.dart';
import '../core/storage/owner_store.dart';
import '../features/recommendations/recommendation_repository.dart';
import 'playback_event_models.dart';

/// Durable absolute engagement PATCHes only. Ambiguous POSTs never enter here.
/// OwnerStore provides persisted owner/epoch admission in the SQLite transaction.
final class FeedbackOutbox {
  FeedbackOutbox({
    required this.store,
    required this.repository,
    required this.authority,
    this.networkPolicy = const NetworkPolicy.online(),
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now;
  final OwnerStore store;
  final RecommendationRepository repository;
  final SessionAuthority authority;
  final NetworkPolicy networkPolicy;
  final DateTime Function() _now;
  static const namespace = 'play-engagement-v1';
  static const _controlNamespace = 'play-engagement-control-v1';
  static const maxAttempts = 3;
  final _flights = <SessionFence, _FeedbackFlight>{};

  Future<void> enqueue(
    String playId,
    PlayEngagement engagement,
    SessionFence fence,
  ) async {
    if (playId.isEmpty || playId.length > 512) {
      throw ArgumentError('Invalid known play ID');
    }
    if (!authority.isCurrent(fence)) return;
    final changed = await store.transaction(fence, (tx) async {
      final old = await tx.read(namespace, playId);
      // OwnerStore retains owner data across logins. An old row never acquires
      // a new epoch merely because a caller presents a fresh current fence.
      if (old != null && old['epoch'] != fence.epoch) return false;
      final merged = old == null
          ? engagement
          : PlayEngagement.fromJson(old).merge(engagement);
      final payload = merged.toJson();
      if (old != null &&
          payload.entries.every((entry) => old[entry.key] == entry.value)) {
        return false;
      }
      await tx.write(namespace, playId, {
        ...payload,
        'epoch': fence.epoch,
        'attempts': old?['attempts'] ?? 0,
        'ackVersion': old?['ackVersion'] ?? 0,
        'version': ((old?['version'] as int?) ?? 0) + 1,
        'nextAttemptAtUtc': old?['nextAttemptAtUtc'] ?? 0,
      });
      return true;
    });
    if (changed) _flights[fence]?.dirty = true;
  }

  /// One bounded flight, with no polling timer. New durable versions wake a
  /// subsequent scan inside the same flight; all scans share100 send attempts.
  /// Attempts are reserved durably before network, so process death cannot reset
  /// an offline loop. No networking occurs while the SQL transaction is held.
  Future<void> flush(SessionFence fence) {
    final flight = _flights[fence];
    if (flight != null) return flight.completion.future;
    final next = _FeedbackFlight();
    _flights[fence] = next;
    unawaited(_drain(fence, next));
    return next.completion.future;
  }

  Future<void> _drain(SessionFence fence, _FeedbackFlight flight) async {
    try {
      var scans = 0;
      do {
        scans++;
        flight.dirty = false;
        await _flush(fence, flight);
      } while (flight.dirty &&
          !flight.holdoff &&
          flight.sent < 100 &&
          scans < 100 &&
          authority.isCurrent(fence) &&
          networkPolicy.networkAllowed);
      flight.completion.complete();
    } catch (error, stack) {
      flight.completion.completeError(error, stack);
    } finally {
      // Removal and the final dirty check have no intervening await. A caller
      // either joins a live draining flight or starts a fresh one after it.
      _flights.remove(fence);
    }
  }

  Future<void> _flush(SessionFence fence, _FeedbackFlight flight) async {
    if (!authority.isCurrent(fence) || !networkPolicy.networkAllowed) return;
    String? after;
    while (flight.sent < 100) {
      if (!authority.isCurrent(fence) || !networkPolicy.networkAllowed) return;
      final rows = await store.transaction(
        fence,
        (tx) => tx.list(namespace, afterKey: after, limit: 100),
      );
      if (rows.isEmpty) return;
      after = rows.last.key;
      for (final row in rows) {
        if (flight.failedKeys.contains(row.key)) continue;
        if (!authority.isCurrent(fence) || !networkPolicy.networkAllowed) {
          return;
        }
        final reserved = await store.transaction(fence, (tx) async {
          final control = await tx.read(_controlNamespace, 'holdoff');
          if (control != null &&
              control['epoch'] == fence.epoch &&
              _held(control)) {
            return null;
          }
          final current = await tx.read(namespace, row.key);
          if (current == null ||
              current['epoch'] != fence.epoch ||
              current['version'] == current['ackVersion'] ||
              _held(current) ||
              (current['attempts'] as int) >= maxAttempts) {
            return null;
          }
          final value = {
            ...current,
            'attempts': (current['attempts'] as int) + 1,
          };
          await tx.write(namespace, row.key, value);
          return value;
        });
        if (reserved == null) continue;
        flight.sent++;
        if (!authority.isCurrent(fence)) return;
        try {
          networkPolicy.requireNetwork();
          await repository.updatePlay(
            row.key,
            PlayEngagement.fromJson(reserved),
            fence,
          );
        } catch (error) {
          // A dirty wakeup is new work, not permission for an immediate retry
          // of a failed play. An external later flush owns its next attempt.
          flight.failedKeys.add(row.key);
          if (error is AppFailure &&
              (error.statusCode == 429 || error.statusCode == 503) &&
              error.retryAfter != null &&
              error.retryAfter! > Duration.zero) {
            if (!authority.isCurrent(fence)) return;
            final until = _now()
                .toUtc()
                .add(error.retryAfter!)
                .millisecondsSinceEpoch;
            await store.transaction(fence, (tx) async {
              final current = await tx.read(namespace, row.key);
              if (current != null && current['epoch'] == fence.epoch) {
                final prior = (current['nextAttemptAtUtc'] as int?) ?? 0;
                await tx.write(namespace, row.key, {
                  ...current,
                  'nextAttemptAtUtc': until > prior ? until : prior,
                });
              }
              final control = await tx.read(_controlNamespace, 'holdoff');
              final prior = control?['epoch'] == fence.epoch
                  ? ((control?['nextAttemptAtUtc'] as int?) ?? 0)
                  : 0;
              await tx.write(_controlNamespace, 'holdoff', {
                'epoch': fence.epoch,
                'nextAttemptAtUtc': until > prior ? until : prior,
              });
            });
            flight.holdoff = true;
            return;
          }
          // Absolute totals remain durable. A later explicit pass consumes the next
          // bounded attempt; raw transport exceptions are never exposed or logged.
          continue;
        }
        if (!authority.isCurrent(fence)) return;
        await store.transaction(fence, (tx) async {
          final current = await tx.read(namespace, row.key);
          if (current != null && current['epoch'] == fence.epoch) {
            final ack = (current['ackVersion'] as int?) ?? 0;
            final version = reserved['version'] as int;
            await tx.write(namespace, row.key, {
              ...current,
              'ackVersion': version > ack ? version : ack,
              'attempts': 0,
              'nextAttemptAtUtc': 0,
            });
          }
        });
        if (flight.sent >= 100) return;
      }
    }
  }

  /// User-directed retry after the automatic budget is exhausted.
  Future<void> retry(SessionFence fence) async {
    if (!authority.isCurrent(fence)) return;
    await store.transaction(fence, (tx) async {
      final control = await tx.read(_controlNamespace, 'holdoff');
      if (control != null &&
          control['epoch'] == fence.epoch &&
          _held(control)) {
        return;
      }
      String? after;
      while (true) {
        final rows = await tx.list(namespace, afterKey: after, limit: 100);
        if (rows.isEmpty) break;
        for (final row in rows) {
          if (row.value['epoch'] == fence.epoch && !_held(row.value)) {
            await tx.write(namespace, row.key, {...row.value, 'attempts': 0});
          }
        }
        after = rows.last.key;
      }
    });
    await flush(fence);
  }

  bool _held(Map<String, Object?> value) =>
      ((value['nextAttemptAtUtc'] as int?) ?? 0) >
      _now().toUtc().millisecondsSinceEpoch;
}

final class _FeedbackFlight {
  final completion = Completer<void>();
  final failedKeys = <String>{};
  bool dirty = false;
  bool holdoff = false;
  int sent = 0;
}
