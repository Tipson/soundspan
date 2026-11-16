import 'dart:async';

import '../app/server_capabilities.dart';
import '../core/model/app_failure.dart';
import '../core/model/owner_key.dart';
import '../core/model/queue_entry.dart';
import '../core/network/api_transport.dart';
import '../core/network/network_policy.dart';
import '../core/session/session_authority.dart';
import '../core/storage/owner_store.dart';
import '../features/recommendations/recommendation_repository.dart';
import 'feedback_outbox.dart';
import 'play_create_protocol.dart';
import 'playback_event_models.dart';
import 'resolved_media.dart';

/// A run's immutable key and independently observable durable/known milestones.
final class PlayCreateTicket {
  PlayCreateTicket._(this.key, this._onUnknown) {
    unawaited(_created.future.then<void>((_) {}, onError: (Object _) {}));
  }
  final PlayCreateKey key;
  final _created = Completer<String>();
  String? _knownPlayId;
  final void Function()? _onUnknown;
  Future<String> get created => _created.future;
  late final Future<void> persisted;
}

/// Owner-scoped create recovery only. It never changes playback or retries legacy.
final class PlayCreateJournal {
  PlayCreateJournal({
    required this.store,
    required this.repository,
    required this.outbox,
    required this.capabilities,
    required this.authority,
    required this.fence,
    this.networkPolicy = const NetworkPolicy.online(),
    Duration Function()? elapsed,
  }) : _elapsed = elapsed ?? (Stopwatch()..start()).elapsedDuration {
    _sessions = authority.changes.listen((_) {
      if (!authority.isCurrent(fence)) {
        unawaited(close().catchError((Object _) {}));
      }
    });
  }
  static const namespace = 'play-create-v1';
  static const _control = 'play-create-control-v1';
  static const maxRows = 100;
  final OwnerStore store;
  final RecommendationRepository repository;
  final FeedbackOutbox outbox;
  final ServerCapabilitiesRepository capabilities;
  final SessionAuthority authority;
  final SessionFence fence;
  final NetworkPolicy networkPolicy;
  final Duration Function() _elapsed;
  final _tickets = <String, PlayCreateTicket>{};
  late final StreamSubscription<Object?> _sessions;
  Future<void> _tail = Future.value();
  _CreateFlight? _flight;
  Future<void>? _closing;
  bool _closed = false;
  MediaCancellation? _cancellation;
  Timer? _timer;
  int? _timerAt;
  bool get _owns => authority.isCurrent(fence);
  bool get _admitted => !_closed && _owns && networkPolicy.networkAllowed;

  /// Captures the DTO and starts durable work synchronously, before any await.
  PlayCreateTicket begin(
    QueueEntry entry,
    PlayCreationGrant grant, {
    required String playbackRunId,
    void Function()? onUnknown,
  }) {
    final dto = FrozenPlayCreate.fromEntry(entry);
    if (!_admitted || !grant.allowsNew(dto.source, fence)) {
      throw const AppFailure(
        code: 'play_create_not_admitted',
        message: 'Учёт прослушивания недоступен',
      );
    }
    final key = PlayCreateKey.issue(
      epoch: grant.epoch,
      issuedAtMs: grant.serverNowMs,
    );
    final ticket = PlayCreateTicket._(key, onUnknown);
    _tickets[key.value] = ticket;
    ticket.persisted = _ordered(() async {
      if (!_owns) throw _revoked;
      await store.transaction(fence, (tx) async {
        final rows = await tx.list(namespace, limit: maxRows);
        if (rows.length >= maxRows) {
          throw const AppFailure(
            code: 'play_create_capacity',
            message: 'Журнал прослушивания заполнен',
          );
        }
        await tx.write(namespace, key.value, {
          'version': 1,
          'epoch': fence.epoch,
          'state': 'ready',
          'dto': dto.body,
          'trace': normalizePlaybackTraceId(playbackRunId),
          'attempts': 0,
          'nextAt': 0,
          'maxNow': grant.serverNowMs,
          'playId': null,
          'totals': const PlayEngagement(
            listenedSeconds: 0,
            completionRatio: 0,
            outcome: PlayOutcome.skipped,
          ).toJson(),
          'final': false,
        });
      });
    });
    unawaited(
      ticket.persisted.then<void>(
        (_) {
          unawaited(flush(refresh: false).catchError((Object _) {}));
        },
        onError: (Object error, StackTrace stack) {
          _tickets.remove(key.value);
          if (!ticket._created.isCompleted) {
            ticket._created.completeError(error, stack);
          }
        },
      ),
    );
    return ticket;
  }

  /// Persists totals before attempting the independently atomic PATCH handoff.
  Future<void> checkpoint(
    PlayCreateTicket ticket,
    PlayEngagement totals, {
    bool finalTotals = false,
  }) {
    if (_closed || !_owns) return Future.value();
    final captured = _totals(totals.toJson());
    return _ordered(() async {
      var direct = false;
      await store.transaction(fence, (tx) async {
        final row = await tx.read(namespace, ticket.key.value);
        if (row == null) {
          final id = ticket._knownPlayId;
          if (id != null) {
            final result = await outbox.enqueueInTransaction(
              tx,
              id,
              captured,
              fence,
            );
            if (result == FeedbackAcceptance.stale) throw _revoked;
            direct = true;
          }
          return;
        }
        if (row['epoch'] != fence.epoch || row['state'] == 'terminal') return;
        await tx.write(namespace, ticket.key.value, {
          ...row,
          'totals': _totals(row['totals']).merge(captured).toJson(),
          'final': row['final'] == true || finalTotals,
        });
      });
      if (direct) {
        outbox.notifyDurableEnqueue(fence);
        if (_admitted) unawaited(outbox.flush(fence).catchError((Object _) {}));
      }
      if (finalTotals) await _handoff(ticket.key.value);
    });
  }

  Future<T> _ordered<T>(Future<T> Function() work) {
    final next = _tail.then((_) => work());
    _tail = next.then<void>((_) {}, onError: (Object _) {});
    return next;
  }

  /// Startup/resume/online wake; cached UI flags cannot authorize recovery.
  Future<void> recover() => flush();
  Future<void> flush({bool refresh = true}) {
    if (!_admitted) return Future.value();
    final existing = _flight;
    if (existing != null) {
      existing.dirty = true;
      existing.refreshRequested |= refresh;
      return existing.done.future;
    }
    final flight = _CreateFlight(_elapsed())..refreshRequested = refresh;
    _flight = flight;
    unawaited(_drain(flight));
    return flight.done.future;
  }

  Future<void> _drain(_CreateFlight flight) async {
    try {
      await _tail;
      // Known IDs are delivered without any create permission or time budget.
      await _knownAndGc();
      PlayCreationGrant? lastGrant;
      do {
        flight.dirty = false;
        if (!_admitted) break;
        final rows = await store.transaction(
          fence,
          (tx) => tx.list(namespace, limit: maxRows),
        );
        if (rows.isEmpty) continue;
        if (flight.refreshRequested) {
          flight.refreshRequested = false;
          await capabilities.refresh();
        }
        for (final row in rows) {
          if (!_admitted || flight.seen.length >= maxRows) {
            break;
          }
          final grant = capabilities.playCreationGrant;
          if (grant != null) lastGrant = grant;
          if (row.value['state'] == 'terminal' &&
              grant != null &&
              grant.serverNowMs >= PlayCreateKey.parse(row.key).expiresAtMs) {
            await store.transaction(
              fence,
              (tx) => tx.remove(namespace, row.key),
            );
            continue;
          }
          if (row.value['state'] == 'known') {
            if (grant != null &&
                grant.serverNowMs >= PlayCreateKey.parse(row.key).expiresAtMs) {
              await _handoff(row.key, force: true);
            }
            continue;
          }
          if (!flight.seen.add(row.key)) continue;
          if (grant == null) {
            if (capabilities.hasFreshUnsupportedPlayCreation) {
              await _terminal(row.key);
            }
            continue;
          }
          if (flight.sent >= 10 ||
              (flight.sent > 0 &&
                  _elapsed() - flight.started >= const Duration(seconds: 15))) {
            // A bounded follow-up owns ready work beyond this pass. An existing
            // durable holdoff timer retains priority over this backlog wake.
            if (_timerAt == null) {
              _arm(grant.serverNowMs + 1000, grant.serverNowMs);
            }
            break;
          }
          final reserved = await _reserve(row.key, grant);
          if (reserved == null || !_admitted) continue;
          if (!grant.isFresh) {
            _arm(grant.serverNowMs + 1000, grant.serverNowMs);
            continue;
          }
          flight.sent++;
          final key = PlayCreateKey.parse(row.key);
          PlayCreateAck ack;
          final cancellation = _cancellation = MediaCancellation();
          try {
            ack = await repository.createKeyedPlay(
              FrozenPlayCreate.decode(reserved['dto']),
              key,
              fence,
              playbackRunId: normalizePlaybackTraceId(reserved['trace']),
              cancellation: cancellation,
            );
          } catch (error) {
            if (_admitted) await _failed(row.key, error, grant.serverNowMs);
            continue;
          } finally {
            if (identical(_cancellation, cancellation)) _cancellation = null;
          }
          if (!_admitted) continue;
          var accepted = false;
          await store.transaction(fence, (tx) async {
            final current = await tx.read(namespace, row.key);
            if (!_admitted ||
                current == null ||
                current['epoch'] != fence.epoch ||
                current['state'] == 'terminal') {
              return;
            }
            await tx.write(namespace, row.key, {
              ...current,
              'state': 'known',
              'playId': ack.playId,
              'nextAt': 0,
            });
            accepted = true;
          });
          if (accepted) {
            final ticket = _tickets[row.key];
            if (ticket != null) {
              ticket._knownPlayId = ack.playId;
              if (!ticket._created.isCompleted) {
                ticket._created.complete(ack.playId);
              }
            }
            await _handoff(row.key);
          }
        }
      } while (flight.dirty &&
          _admitted &&
          flight.sent < 10 &&
          flight.seen.length < maxRows);
      // A new durable row may arrive during the final send, outside its scan.
      // Keep the existing holdoff timer; an expired clock only schedules a wake,
      // whose recovery obtains fresh permission before admitting another send.
      if (flight.dirty &&
          flight.sent > 0 &&
          _admitted &&
          _timerAt == null &&
          lastGrant != null) {
        final now = lastGrant.serverNowMs;
        _arm(now + 1000, now);
      }
      flight.done.complete();
    } catch (error, stack) {
      flight.done.completeError(error, stack);
    } finally {
      _flight = null;
    }
  }

  Future<void> _knownAndGc() async {
    final rows = await store.transaction(
      fence,
      (tx) => tx.list(namespace, limit: maxRows),
    );
    for (final row in rows) {
      if (!_owns || _closed) return;
      bool valid;
      try {
        _validate(row.key, row.value);
        valid = true;
      } catch (_) {
        valid = false;
      }
      if (!valid || row.value['epoch'] != fence.epoch) {
        await store.transaction(fence, (tx) => tx.remove(namespace, row.key));
        continue;
      }
      if (row.value['state'] == 'known') await _handoff(row.key);
      final key = PlayCreateKey.parse(row.key);
      final now = capabilities.playCreationGrant?.serverNowMs;
      if (row.value['state'] == 'terminal' &&
          now != null &&
          now >= key.expiresAtMs) {
        await store.transaction(fence, (tx) => tx.remove(namespace, row.key));
      }
    }
  }

  Future<Map<String, Object?>?> _reserve(String id, PlayCreationGrant grant) =>
      store.transaction(fence, (tx) async {
        final current = await tx.read(namespace, id);
        if (current == null || !_admitted) return null;
        _validate(id, current);
        if (current['epoch'] != fence.epoch ||
            current['state'] == 'known' ||
            current['state'] == 'terminal') {
          return null;
        }
        // Refresh/TTL revocation is a temporary absence of permission. Only a
        // current grant can authoritatively reject this key's history epoch.
        if (!grant.isFresh) {
          _arm(grant.serverNowMs + 1000, grant.serverNowMs);
          return null;
        }
        final key = PlayCreateKey.parse(id);
        final now = grant.serverNowMs > (current['maxNow'] as int)
            ? grant.serverNowMs
            : current['maxNow'] as int;
        final attempts = current['attempts'] as int;
        final dto = FrozenPlayCreate.decode(current['dto']);
        if (now >= key.expiresAtMs) {
          await tx.remove(namespace, id);
          _finishUnknown(id);
          return null;
        }
        if (now - key.issuedAtMs >= 600000 ||
            attempts >= 3 ||
            !grant.allowsReplay(key.epoch, fence)) {
          await tx.write(namespace, id, _terminalRow(current, now));
          _finishUnknown(id);
          return null;
        }
        if (attempts == 0 && !grant.allowsNew(dto.source, fence)) return null;
        final control = await tx.read(_control, 'holdoff');
        final shared = control?['epoch'] == fence.epoch
            ? ((control?['nextAt'] as int?) ?? 0)
            : 0;
        final next = (current['nextAt'] as int) > shared
            ? current['nextAt'] as int
            : shared;
        if (next > now) {
          _arm(
            next < key.issuedAtMs + 600000 ? next : key.issuedAtMs + 600000,
            now,
          );
          return null;
        }
        final value = {
          ...current,
          'state': 'unknown',
          'attempts': attempts + 1,
          'maxNow': now,
        };
        await tx.write(namespace, id, value);
        return value;
      });

  Future<void> _failed(String id, Object error, int now) async {
    final status = error is AppFailure ? error.statusCode : null;
    if (const {400, 401, 403, 404, 409, 410}.contains(status)) {
      await _terminal(id);
      return;
    }
    final delay =
        error is AppFailure &&
            error.retryAfter != null &&
            error.retryAfter! > Duration.zero
        ? error.retryAfter!
        : const Duration(seconds: 1);
    final next = now + delay.inMilliseconds;
    await store.transaction(fence, (tx) async {
      final current = await tx.read(namespace, id);
      if (!_admitted ||
          current == null ||
          current['epoch'] != fence.epoch ||
          current['state'] != 'unknown') {
        return;
      }
      await tx.write(namespace, id, {
        ...current,
        'nextAt': next,
        'maxNow': now > (current['maxNow'] as int) ? now : current['maxNow'],
      });
      if (status == 429 || status == 503) {
        final old = await tx.read(_control, 'holdoff');
        final prior = old?['epoch'] == fence.epoch
            ? ((old?['nextAt'] as int?) ?? 0)
            : 0;
        await tx.write(_control, 'holdoff', {
          'epoch': fence.epoch,
          'nextAt': next > prior ? next : prior,
        });
      }
    });
    try {
      _tickets[id]?._onUnknown?.call();
    } catch (_) {
      /* observer only */
    }
    final expires = PlayCreateKey.parse(id).issuedAtMs + 600000;
    _arm(next < expires ? next : expires, now);
  }

  Future<void> _terminal(String id) async {
    await store.transaction(fence, (tx) async {
      final row = await tx.read(namespace, id);
      if (row != null &&
          row['epoch'] == fence.epoch &&
          row['state'] != 'known') {
        await tx.write(namespace, id, _terminalRow(row, row['maxNow'] as int));
      }
    });
    _finishUnknown(id);
  }

  Map<String, Object?> _terminalRow(Map<String, Object?> row, int now) => {
    ...row,
    'state': 'terminal',
    'dto': null,
    'totals': null,
    'final': true,
    'playId': null,
    'nextAt': 0,
    'maxNow': now,
  };
  void _finishUnknown(String id) {
    final ticket = _tickets.remove(id);
    if (ticket != null && !ticket._created.isCompleted) {
      ticket._created.completeError(
        const AppFailure(
          code: 'play_create_ambiguous',
          message: 'Подтверждение прослушивания недоступно',
        ),
      );
    }
  }

  Future<void> _handoff(String id, {bool force = false}) async {
    var accepted = false;
    await store.transaction(fence, (tx) async {
      final row = await tx.read(namespace, id);
      if (row == null ||
          row['epoch'] != fence.epoch ||
          row['state'] != 'known' ||
          (!force && row['final'] != true && _tickets.containsKey(id))) {
        return;
      }
      final result = await outbox.enqueueInTransaction(
        tx,
        row['playId'] as String,
        _totals(row['totals']),
        fence,
        playbackRunId: normalizePlaybackTraceId(row['trace']),
      );
      if (result == FeedbackAcceptance.stale) throw _revoked;
      await tx.remove(namespace, id);
      accepted = true;
    });
    if (accepted) {
      _tickets.remove(id);
      outbox.notifyDurableEnqueue(fence);
      if (_admitted) unawaited(outbox.flush(fence).catchError((Object _) {}));
    }
  }

  void _arm(int due, int now) {
    if (!_admitted || (_timerAt != null && _timerAt! <= due)) return;
    _timer?.cancel();
    _timerAt = due;
    _timer = Timer(Duration(milliseconds: (due - now).clamp(1, 600000)), () {
      _timer = null;
      _timerAt = null;
      unawaited(recover().catchError((Object _) {}));
    });
  }

  void cancelNetwork() {
    _timer?.cancel();
    _timer = null;
    _timerAt = null;
    _cancellation?.cancel();
  }

  Future<void> close() {
    if (_closing != null) return _closing!;
    _closed = true;
    cancelNetwork();
    for (final id in _tickets.keys.toList()) {
      _finishUnknown(id);
    }
    return _closing = () async {
      await _sessions.cancel();
      await _tail;
      await _flight?.done.future;
    }();
  }

  static PlayEngagement _totals(Object? raw) {
    if (raw is! Map<String, Object?>) {
      throw const FormatException('Invalid durable totals');
    }
    final listened = raw['listenedSeconds'], ratio = raw['completionRatio'];
    if (listened is! num ||
        !listened.isFinite ||
        listened < 0 ||
        listened > 86400 ||
        ratio is! num ||
        !ratio.isFinite ||
        ratio < 0 ||
        ratio > 1 ||
        !PlayOutcome.values.any((outcome) => outcome.name == raw['outcome'])) {
      throw const FormatException('Invalid durable totals');
    }
    return PlayEngagement.fromJson(raw);
  }

  static void _validate(String id, Map<String, Object?> row) {
    PlayCreateKey.parse(id);
    const keys = {
      'version',
      'epoch',
      'state',
      'dto',
      'trace',
      'attempts',
      'nextAt',
      'maxNow',
      'playId',
      'totals',
      'final',
    };
    if (row.length != keys.length ||
        row.keys.any((key) => !keys.contains(key)) ||
        row['version'] != 1 ||
        row['epoch'] is! int ||
        (row['epoch'] as int) < 0 ||
        !const {
          'ready',
          'unknown',
          'known',
          'terminal',
        }.contains(row['state']) ||
        row['attempts'] is! int ||
        (row['attempts'] as int) < 0 ||
        (row['attempts'] as int) > 3 ||
        row['nextAt'] is! int ||
        (row['nextAt'] as int) < 0 ||
        row['maxNow'] is! int ||
        (row['maxNow'] as int) < 0 ||
        row['final'] is! bool ||
        (row['trace'] != null &&
            normalizePlaybackTraceId(row['trace']) == null)) {
      throw const FormatException('Invalid create journal');
    }
    if (row['state'] != 'terminal') {
      FrozenPlayCreate.decode(row['dto']);
      _totals(row['totals']);
    }
    if (row['state'] == 'known' &&
        (row['playId'] is! String ||
            (row['playId'] as String).isEmpty ||
            (row['playId'] as String).length > 512)) {
      throw const FormatException('Invalid known Play');
    }
  }

  static const _revoked = AppFailure(
    code: 'stale_session',
    message: 'Сессия завершена',
  );
}

final class _CreateFlight {
  _CreateFlight(this.started);
  final Duration started;
  final done = Completer<void>();
  final seen = <String>{};
  int sent = 0;
  bool dirty = false;
  bool refreshRequested = false;
}

extension on Stopwatch {
  Duration elapsedDuration() => elapsed;
}
