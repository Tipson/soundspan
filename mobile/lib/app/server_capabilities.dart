import 'dart:async';

import 'package:flutter/foundation.dart';

import '../core/model/owner_key.dart';
import '../core/network/api_transport.dart';
import '../core/network/network_policy.dart';
import '../core/session/session_authority.dart';
import '../core/storage/owner_store.dart';

/// Memory-only admission, constructed exclusively by the online repository.
final class PlayCreationGrant {
  PlayCreationGrant._(
    Map value,
    this.fence,
    this._elapsed,
    this._current,
    this._at,
  ) : epoch = value['ownerHistoryEpoch'] as int,
      _serverNowMs = value['serverNowMs'] as int,
      newCreationsEnabled = value['newCreationsEnabled'] as bool,
      replaySupported = value['replaySupported'] as bool,
      sources = Set<String>.unmodifiable(
        (value['allowedSources'] as List).cast<String>(),
      );
  final SessionFence fence;
  final int epoch, _serverNowMs;
  final bool newCreationsEnabled, replaySupported;
  final Set<String> sources;
  final Duration Function() _elapsed;
  final bool Function() _current;
  final Duration _at;
  bool get isFresh {
    final age = _elapsed() - _at;
    return _current() &&
        age >= Duration.zero &&
        age < const Duration(seconds: 300);
  }

  int get serverNowMs => _serverNowMs + (_elapsed() - _at).inMilliseconds;
  bool allowsNew(String source, SessionFence candidate) =>
      isFresh &&
      candidate == fence &&
      newCreationsEnabled &&
      replaySupported &&
      sources.contains(source);
  bool allowsReplay(int historyEpoch, SessionFence candidate) =>
      isFresh && candidate == fence && historyEpoch == epoch && replaySupported;

  static bool _valid(Object? raw) {
    if (raw is! Map ||
        raw['version'] != 1 ||
        raw['newCreationsEnabled'] is! bool ||
        raw['replaySupported'] is! bool ||
        raw['createPath'] != '/api/plays/idempotent' ||
        raw['replayWindowSeconds'] != 86400 ||
        raw['futureSkewSeconds'] != 300 ||
        raw['capabilityTtlSeconds'] != 300) {
      return false;
    }
    final epoch = raw['ownerHistoryEpoch'],
        now = raw['serverNowMs'],
        sources = raw['allowedSources'];
    return epoch is int &&
        epoch >= 0 &&
        epoch <= 2147483647 &&
        now is int &&
        now >= 0 &&
        now <= 8640000000000000 - 86400000 &&
        sources is List &&
        sources.length <= 3 &&
        sources.toSet().length == sources.length &&
        sources.every(
          (source) => const {'youtube', 'vk', 'yandex'}.contains(source),
        );
  }
}

final class ServerCapabilities {
  const ServerCapabilities({
    required this.discovery,
    required this.autoPlaylists,
    required this.federation,
    this.audius = false,
    this.loudnessTargetLufs,
    this.orderedWave = false,
    this.importDrafts = false,
  });
  final bool discovery, autoPlaylists, federation, audius;
  final double? loudnessTargetLufs;
  final bool orderedWave;
  final bool importDrafts;
  factory ServerCapabilities.decode(Object? value) {
    if (value is! Map ||
        value['discovery'] is! bool ||
        value['autoPlaylists'] is! bool ||
        value['federation'] is! bool ||
        (value.containsKey('audius') && value['audius'] is! bool)) {
      throw const FormatException('Invalid capabilities');
    }
    final loudness = value['loudnessTargetLufs'];
    final ordered = value['orderedWave'];
    if (value.containsKey('orderedWave') &&
        (ordered is! Map ||
            ordered.length != 1 ||
            ordered['version'] is! int ||
            ordered['version'] != 1)) {
      throw const FormatException('Invalid ordered Wave capability');
    }
    if (loudness != null &&
        (loudness is! num ||
            !loudness.isFinite ||
            loudness < -70 ||
            loudness > 0)) {
      throw const FormatException('Invalid loudness target');
    }
    return ServerCapabilities(
      discovery: value['discovery'] as bool,
      autoPlaylists: value['autoPlaylists'] as bool,
      federation: value['federation'] as bool,
      audius: value['audius'] as bool? ?? false,
      loudnessTargetLufs: (loudness as num?)?.toDouble(),
      orderedWave: value.containsKey('orderedWave'),
      importDrafts:
          value['importDrafts'] is Map &&
          (value['importDrafts'] as Map).length == 1 &&
          (value['importDrafts'] as Map)['version'] is int &&
          (value['importDrafts'] as Map)['version'] == 1,
    );
  }
  Map<String, Object?> toJson() => {
    'discovery': discovery,
    'autoPlaylists': autoPlaylists,
    'federation': federation,
    'audius': audius,
    if (orderedWave) 'orderedWave': {'version': 1},
    if (importDrafts) 'importDrafts': {'version': 1},
    if (loudnessTargetLufs != null) 'loudnessTargetLufs': loudnessTargetLufs,
  };
}

/// Unknown flags remain unknown; callers hide conditional features until known.
final class ServerCapabilitiesRepository {
  ServerCapabilitiesRepository({
    required this.transport,
    required this.store,
    required this.authority,
    required this.fence,
    required this.policy,
    Duration Function()? elapsed,
  }) : _elapsed = elapsed ?? (Stopwatch()..start()).elapsedDuration {
    if (policy case Listenable listenable) {
      listenable.addListener(_policyChanged);
    }
  }
  final ApiTransport transport;
  final OwnerStore store;
  final SessionAuthority authority;
  final SessionFence fence;
  final NetworkPolicy policy;
  final Duration Function() _elapsed;
  PlayCreationGrant? _playGrant;
  Duration? _onlineAt;
  int _networkGeneration = 0;
  bool get hasFreshUnsupportedPlayCreation =>
      _current &&
      policy.networkAllowed &&
      _onlineAt != null &&
      _elapsed() - _onlineAt! >= Duration.zero &&
      _elapsed() - _onlineAt! < const Duration(seconds: 300) &&
      _playGrant == null;
  PlayCreationGrant? get playCreationGrant =>
      _playGrant?.isFresh == true ? _playGrant : null;
  bool? get orderedWaveEnabled =>
      _current &&
          policy.networkAllowed &&
          _onlineAt != null &&
          _elapsed() - _onlineAt! >= Duration.zero &&
          _elapsed() - _onlineAt! < const Duration(seconds: 300)
      ? state.value?.orderedWave
      : null;
  bool? get importDraftsEnabled =>
      _current &&
          policy.networkAllowed &&
          _onlineAt != null &&
          _elapsed() - _onlineAt! >= Duration.zero &&
          _elapsed() - _onlineAt! < const Duration(seconds: 300)
      ? state.value?.importDrafts
      : null;
  VoidCallback? onPlayCreationRefresh;
  void _policyChanged() {
    if (!policy.networkAllowed) {
      _networkGeneration++;
      _playGrant = null;
      _onlineAt = null;
    }
  }

  final state = ValueNotifier<ServerCapabilities?>(null);
  bool _closed = false;
  Future<void>? _flight;
  bool get _current => !_closed && authority.isCurrent(fence);
  Future<void> restore() async {
    try {
      final row = await store.transaction(
        fence,
        (tx) => tx.read('capabilities', 'system'),
      );
      await authority.assertCurrent(fence);
      if (_current && row?['version'] == 1) {
        state.value = ServerCapabilities.decode(row!['flags']);
      }
    } catch (_) {
      /* Cache absence never blocks downloaded music. */
    }
  }

  Future<void> refresh() {
    if (!_current || !policy.networkAllowed) return Future.value();
    return _flight ??= _refresh().whenComplete(() => _flight = null);
  }

  Future<void> _refresh() async {
    _playGrant = null;
    _onlineAt = null;
    try {
      policy.requireNetwork();
      final networkGeneration = _networkGeneration;
      final response = await transport.send(
        ApiRequest(
          origin: fence.owner.serverOrigin,
          method: ApiMethod.get,
          path: '/api/system/features',
        ),
        fence: fence,
      );
      final receivedAt = _elapsed();
      response.requireSuccess();
      final flags = ServerCapabilities.decode(response.data);
      await authority.assertCurrent(fence);
      if (!_current) return;
      await store.transaction(fence, (tx) async {
        if (!_current) return;
        await tx.write('capabilities', 'system', {
          'version': 1,
          'flags': flags.toJson(),
        });
      });
      if (_current && !mapEquals(state.value?.toJson(), flags.toJson())) {
        state.value = flags;
      }
      final body = response.data;
      final age = _elapsed() - receivedAt;
      if (_current &&
          policy.networkAllowed &&
          _networkGeneration == networkGeneration &&
          age >= Duration.zero &&
          age < const Duration(seconds: 300) &&
          body is Map) {
        _onlineAt = receivedAt;
        final raw = body['playCreation'];
        if (PlayCreationGrant._valid(raw)) {
          late final PlayCreationGrant grant;
          grant = PlayCreationGrant._(
            raw as Map,
            fence,
            _elapsed,
            () =>
                _current &&
                policy.networkAllowed &&
                _networkGeneration == networkGeneration &&
                identical(_playGrant, grant),
            receivedAt,
          );
          _playGrant = grant;
        }
        onPlayCreationRefresh?.call();
      }
    } catch (_) {
      _playGrant = null;
      _onlineAt = null;
      /* Keep only the last validated nonsecret flags. */
    }
  }

  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    _playGrant = null;
    onPlayCreationRefresh = null;
    if (policy case Listenable listenable) {
      listenable.removeListener(_policyChanged);
    }
    await _flight;
    state.dispose();
  }
}

extension on Stopwatch {
  Duration elapsedDuration() => elapsed;
}
