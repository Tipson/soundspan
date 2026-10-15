import 'dart:async';

import 'package:flutter/foundation.dart';

import '../core/model/owner_key.dart';
import '../core/network/api_transport.dart';
import '../core/network/network_policy.dart';
import '../core/session/session_authority.dart';
import '../core/storage/owner_store.dart';

final class ServerCapabilities {
  const ServerCapabilities({
    required this.discovery,
    required this.autoPlaylists,
    required this.federation,
    this.audius = false,
    this.loudnessTargetLufs,
  });
  final bool discovery, autoPlaylists, federation, audius;
  final double? loudnessTargetLufs;
  factory ServerCapabilities.decode(Object? value) {
    if (value is! Map ||
        value['discovery'] is! bool ||
        value['autoPlaylists'] is! bool ||
        value['federation'] is! bool ||
        (value.containsKey('audius') && value['audius'] is! bool)) {
      throw const FormatException('Invalid capabilities');
    }
    final loudness = value['loudnessTargetLufs'];
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
    );
  }
  Map<String, Object?> toJson() => {
    'discovery': discovery,
    'autoPlaylists': autoPlaylists,
    'federation': federation,
    'audius': audius,
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
  });
  final ApiTransport transport;
  final OwnerStore store;
  final SessionAuthority authority;
  final SessionFence fence;
  final NetworkPolicy policy;
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
    try {
      policy.requireNetwork();
      final response = await transport.send(
        ApiRequest(
          origin: fence.owner.serverOrigin,
          method: ApiMethod.get,
          path: '/api/system/features',
        ),
        fence: fence,
      );
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
      if (_current) state.value = flags;
    } catch (_) {
      /* Keep only the last validated nonsecret flags. */
    }
  }

  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    await _flight;
    state.dispose();
  }
}
