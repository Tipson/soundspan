import 'package:flutter/services.dart';

import '../core/model/owner_key.dart';
import '../core/session/session_broker_protocol.dart';
import 'download_network_access.dart';

final class DownloadWorkRequest {
  DownloadWorkRequest(this.downloadId, this.originalFence, this.generation) {
    if (!RegExp(r'^[a-f0-9]{64}$').hasMatch(downloadId) ||
        originalFence.epoch < 1 ||
        generation < 1 ||
        originalFence.owner.userId.length > 1024) {
      throw const FormatException('Invalid download identity');
    }
  }
  final String downloadId;
  final SessionFence originalFence;
  final int generation;
  static DownloadWorkRequest decode(Object? value) {
    final data = BrokerCodec.object(value, {
      'downloadId',
      'fence',
      'generation',
    });
    return DownloadWorkRequest(
      BrokerCodec.text(data['downloadId']),
      BrokerCodec.fence(data['fence']),
      BrokerCodec.number(data['generation'], minimum: 1),
    );
  }

  Map<String, Object?> encode() => {
    'downloadId': downloadId,
    'fence': BrokerCodec.encodeFence(originalFence),
    'generation': generation,
  };
}

final class DownloadWorkerBridge {
  const DownloadWorkerBridge();
  static const _channel = MethodChannel('soundspan/downloads');
  Future<String> schedule(
    String id,
    SessionFence fence,
    int generation, {
    DownloadNetworkConstraint networkConstraint =
        DownloadNetworkConstraint.unmetered,
  }) async => BrokerCodec.text(
    await _channel.invokeMethod<String>('schedule', {
      ...DownloadWorkRequest(id, fence, generation).encode(),
      'networkConstraint': networkConstraint.name,
    }),
  );
  Future<void> cancel(OwnerKey owner) => _channel.invokeMethod<void>(
    'cancelOwner',
    BrokerCodec.encodeOwner(owner),
  );
  Future<void> cancelJob(String id, SessionFence fence, int generation) =>
      _channel.invokeMethod<void>(
        'cancelJob',
        DownloadWorkRequest(id, fence, generation).encode(),
      );
  Future<String?> status(String workId) =>
      _channel.invokeMethod<String>('status', workId);
  Future<Map<String, Object?>?> info(String workId) =>
      _channel.invokeMapMethod<String, Object?>('info', workId);
  Future<bool> requestNotificationPermission() async =>
      await _channel.invokeMethod<bool>('requestNotificationPermission') ??
      false;
}
