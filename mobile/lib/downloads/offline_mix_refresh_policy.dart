import 'dart:convert';
import 'dart:math';

import '../core/model/owner_key.dart';
import '../core/storage/owner_store.dart';

final class OfflineMixRefreshState {
  const OfflineMixRefreshState({
    this.enabled = false,
    this.revision = 0,
    this.sourceIdentity,
    this.quality = 'original',
    this.lastSuccessAt = 0,
  });
  final bool enabled;
  final int revision, lastSuccessAt;
  final String? sourceIdentity;
  final String quality;
}

final class OfflineMixRefreshTicket {
  const OfflineMixRefreshTicket({
    required this.fence,
    required this.revision,
    required this.sourceIdentity,
    required this.quality,
    required this.nonce,
  });
  final SessionFence fence;
  final int revision;
  final String sourceIdentity, quality, nonce;

  Map<String, Object?> encode() => {
    'epoch': fence.epoch,
    'revision': revision,
    'sourceIdentity': sourceIdentity,
    'quality': quality,
    'nonce': nonce,
  };

  static OfflineMixRefreshTicket decode(Object? value, SessionFence fence) {
    if (value is! Map ||
        value.length != 5 ||
        value['epoch'] != fence.epoch ||
        value['epoch'] is! int ||
        value['revision'] is! int ||
        (value['revision'] as int) < 1 ||
        value['sourceIdentity'] is! String ||
        !OfflineMixRefreshPolicy._validSource(
          value['sourceIdentity'] as String,
        ) ||
        !OfflineMixRefreshPolicy._qualities.contains(value['quality']) ||
        value['nonce'] is! String ||
        !RegExp(r'^[a-f0-9]{48}$').hasMatch(value['nonce'] as String)) {
      throw const FormatException('Offline refresh ticket');
    }
    return OfflineMixRefreshTicket(
      fence: fence,
      revision: value['revision'] as int,
      sourceIdentity: value['sourceIdentity'] as String,
      quality: value['quality'] as String,
      nonce: value['nonce'] as String,
    );
  }
}

final class OfflineMixRefreshPolicy {
  OfflineMixRefreshPolicy({
    required this.store,
    required this.fence,
    DateTime Function()? clock,
  }) : clock = clock ?? DateTime.now;
  final OwnerStore store;
  final SessionFence fence;
  final DateTime Function() clock;
  static const namespace = 'offlineMixRefresh.v1';
  static const key = 'control';
  static const interval = Duration(hours: 24);
  static const attemptLease = Duration(minutes: 30);
  static const _qualities = {
    'original',
    'high',
    'medium',
    'low',
    'lossless',
    'HIGH',
    'MEDIUM',
    'LOW',
    'LOSSLESS',
  };
  static const _kinds = {'daily', 'dailyBlend', 'daypart', 'weekly', 'legacy'};

  Future<OfflineMixRefreshState> read() =>
      store.transaction(fence, (tx) async => (await _read(tx)).state);

  /// Explicit opt-in captures an exact saved source, without scheduling work.
  /// Revision changes retire old attempts; unknown records are never replaced.
  Future<OfflineMixRefreshState> configure({
    required bool enabled,
    String? sourceIdentity,
    String? quality,
  }) => store.transaction(fence, (tx) async {
    final previous = (await _read(tx)).state;
    final source = sourceIdentity ?? previous.sourceIdentity;
    final selectedQuality = quality ?? previous.quality;
    if ((enabled && source == null) ||
        (source != null && !_validSource(source)) ||
        !_qualities.contains(selectedQuality)) {
      throw ArgumentError('Expected a saved mix source and supported quality');
    }
    if (previous.enabled == enabled &&
        previous.sourceIdentity == source &&
        previous.quality == selectedQuality) {
      return previous;
    }
    final sameTarget =
        previous.sourceIdentity == source &&
        previous.quality == selectedQuality;
    final state = OfflineMixRefreshState(
      enabled: enabled,
      revision: previous.revision + 1,
      sourceIdentity: source,
      quality: selectedQuality,
      lastSuccessAt: sameTarget ? previous.lastSuccessAt : 0,
    );
    await tx.write(namespace, key, _encode(state));
    return state;
  });

  /// This lease governs orchestration, never decoder/file liveness. Each effect
  /// must validate the exact ticket in its own transaction before committing.
  Future<OfflineMixRefreshTicket?> claim({
    required bool charging,
    required bool unmetered,
    required int expectedRevision,
  }) async {
    if (!charging || !unmetered) return null;
    return store.transaction(fence, (tx) async {
      final record = await _read(tx), state = record.state;
      final now = _now();
      if (!state.enabled ||
          state.revision != expectedRevision ||
          (state.lastSuccessAt > 0 &&
              now < state.lastSuccessAt + interval.inMilliseconds)) {
        return null;
      }
      final attempt = record.attempt;
      if (attempt != null &&
          attempt.epoch == fence.epoch &&
          now < attempt.startedAt + attemptLease.inMilliseconds) {
        return null;
      }
      final random = Random.secure();
      final nonce = List.generate(
        24,
        (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'),
      ).join();
      final next = _RefreshAttempt(nonce, fence.epoch, state.revision, now);
      await tx.write(namespace, key, _encode(state, next));
      return OfflineMixRefreshTicket(
        fence: fence,
        revision: state.revision,
        sourceIdentity: state.sourceIdentity!,
        quality: state.quality,
        nonce: nonce,
      );
    });
  }

  Future<bool> isCurrent(OfflineMixRefreshTicket ticket) async {
    if (ticket.fence != fence) return false;
    return store.transaction(fence, (tx) => isCurrentIn(tx, ticket));
  }

  /// Validate within the caller's existing atomic stage/bind/manifest mutation.
  Future<bool> isCurrentIn(
    OwnerTransaction tx,
    OfflineMixRefreshTicket ticket,
  ) async => ticket.fence == fence && _matches(await _read(tx), ticket);

  Future<bool> finish(
    OfflineMixRefreshTicket ticket, {
    required bool success,
  }) async {
    if (ticket.fence != fence) return false;
    return store.transaction(
      fence,
      (tx) => finishIn(tx, ticket, success: success),
    );
  }

  /// The verified manifest switch and success receipt share one owner commit.
  Future<bool> finishIn(
    OwnerTransaction tx,
    OfflineMixRefreshTicket ticket, {
    required bool success,
  }) async {
    if (ticket.fence != fence) return false;
    final record = await _read(tx);
    if (!_matches(record, ticket)) return false;
    final previous = record.state;
    final now = _now();
    final completedAt = now > record.attempt!.startedAt
        ? now
        : record.attempt!.startedAt;
    final next = OfflineMixRefreshState(
      enabled: previous.enabled,
      revision: previous.revision,
      sourceIdentity: previous.sourceIdentity,
      quality: previous.quality,
      lastSuccessAt: success ? completedAt : previous.lastSuccessAt,
    );
    await tx.write(namespace, key, _encode(next));
    return true;
  }

  bool _matches(_RefreshRecord record, OfflineMixRefreshTicket ticket) =>
      record.state.enabled &&
      record.state.revision == ticket.revision &&
      record.state.sourceIdentity == ticket.sourceIdentity &&
      record.state.quality == ticket.quality &&
      record.attempt?.nonce == ticket.nonce &&
      record.attempt?.epoch == fence.epoch;

  int _now() {
    final value = clock().millisecondsSinceEpoch;
    if (value < 0) throw const FormatException('Invalid refresh clock');
    return value;
  }

  static bool _validSource(String source) {
    final colon = source.indexOf(':');
    return colon > 0 &&
        colon < source.length - 1 &&
        _kinds.contains(source.substring(0, colon)) &&
        utf8.encode(source).length <= 1024 &&
        !source.contains('\u0000');
  }

  Future<_RefreshRecord> _read(OwnerTransaction tx) async {
    final row = await tx.read(namespace, key);
    if (row == null) {
      return const _RefreshRecord(OfflineMixRefreshState(), null);
    }
    final version = row['version'],
        enabled = row['enabled'],
        revision = row['revision'],
        source = row['sourceIdentity'],
        quality = row['quality'],
        success = row['lastSuccessAt'],
        raw = row['attempt'];
    if (row.length != 7 ||
        version is! int ||
        version != 1 ||
        enabled is! bool ||
        revision is! int ||
        revision < 0 ||
        (source != null && (source is! String || !_validSource(source))) ||
        (enabled && source == null) ||
        quality is! String ||
        !_qualities.contains(quality) ||
        success is! int ||
        success < 0) {
      throw const FormatException('Offline refresh policy');
    }
    _RefreshAttempt? attempt;
    if (raw != null) {
      if (raw is! Map ||
          raw.length != 4 ||
          !enabled ||
          raw['nonce'] is! String ||
          !RegExp(r'^[a-f0-9]{48}$').hasMatch(raw['nonce'] as String) ||
          raw['epoch'] is! int ||
          (raw['epoch'] as int) < 1 ||
          raw['revision'] != revision ||
          raw['revision'] is! int ||
          raw['startedAt'] is! int ||
          (raw['startedAt'] as int) < 0) {
        throw const FormatException('Offline refresh attempt');
      }
      attempt = _RefreshAttempt(
        raw['nonce'] as String,
        raw['epoch'] as int,
        raw['revision'] as int,
        raw['startedAt'] as int,
      );
    }
    return _RefreshRecord(
      OfflineMixRefreshState(
        enabled: enabled,
        revision: revision,
        sourceIdentity: source as String?,
        quality: quality,
        lastSuccessAt: success,
      ),
      attempt,
    );
  }

  static Map<String, Object?> _encode(
    OfflineMixRefreshState state, [
    _RefreshAttempt? attempt,
  ]) => {
    'version': 1,
    'enabled': state.enabled,
    'revision': state.revision,
    'sourceIdentity': state.sourceIdentity,
    'quality': state.quality,
    'lastSuccessAt': state.lastSuccessAt,
    'attempt': attempt == null
        ? null
        : {
            'nonce': attempt.nonce,
            'epoch': attempt.epoch,
            'revision': attempt.revision,
            'startedAt': attempt.startedAt,
          },
  };
}

final class _RefreshRecord {
  const _RefreshRecord(this.state, this.attempt);
  final OfflineMixRefreshState state;
  final _RefreshAttempt? attempt;
}

final class _RefreshAttempt {
  const _RefreshAttempt(this.nonce, this.epoch, this.revision, this.startedAt);
  final String nonce;
  final int epoch, revision, startedAt;
}
