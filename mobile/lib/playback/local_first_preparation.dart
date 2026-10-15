import 'dart:io';

import '../core/model/owner_key.dart';
import '../core/model/track_ref.dart';
import '../core/network/network_policy.dart';
import '../core/session/session_authority.dart';
import 'playback_engine.dart';
import 'queue_snapshot.dart';

typedef OpenReadyMedia = Future<File?> Function(
  TrackRef ref,
  String quality,
  SessionFence fence,
);

/// Only DownloadRepository.openReady may supply a file: it verifies the private
/// path, manifest, hash and original owner fence. No server filePath is used.
final class LocalFirstPreparation {
  const LocalFirstPreparation({
    required this.authority,
    required this.policy,
    required this.qualities,
    required this.openReady,
    required this.network,
  });
  final SessionAuthority authority;
  final NetworkPolicy policy;
  final List<String> Function() qualities;
  final OpenReadyMedia openReady;
  final PrepareAudio network;

  Future<PreparedAudio> prepare(QueueEntry entry, SessionFence fence) async {
    await authority.assertCurrent(fence);
    final order = qualities().toSet().toList(growable: false);
    if (order.isEmpty || order.length > 16) {
      throw ArgumentError('Invalid local quality order');
    }
    for (final quality in order) {
      final file = await openReady(entry.track.ref, quality, fence);
      await authority.assertCurrent(fence);
      if (file != null) {
        // A local file is independent of network admission. The queue authority
        // still revokes its active source on owner changes and before removal.
        return PreparedAudio(uri: file.uri, revoke: () async {});
      }
    }
    policy.requireNetwork();
    await authority.assertCurrent(fence);
    policy.requireNetwork();
    final prepared = await network(entry, fence);
    try {
      await authority.assertCurrent(fence);
      policy.requireNetwork();
      return prepared;
    } catch (_) {
      await prepared.revoke();
      rethrow;
    }
  }
}
