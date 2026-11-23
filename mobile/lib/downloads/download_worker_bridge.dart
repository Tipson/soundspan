import 'package:flutter/services.dart';

import '../core/model/owner_key.dart';
import '../core/session/session_broker_protocol.dart';
import 'download_network_access.dart';

final class DownloadWorkRequest {
  DownloadWorkRequest(
    this.downloadId,
    this.originalFence,
    this.generation, {
    this.refreshRevision,
  }) {
    if (!RegExp(r'^[a-f0-9]{64}$').hasMatch(downloadId) ||
        originalFence.epoch < 1 ||
        generation < 1 ||
        (refreshRevision != null &&
            (refreshRevision! < 1 || refreshRevision! > 9007199254740991)) ||
        originalFence.owner.userId.length > 1024) {
      throw const FormatException('Invalid download identity');
    }
  }
  final String downloadId;
  final SessionFence originalFence;
  final int generation;
  final int? refreshRevision;
  static DownloadWorkRequest decode(Object? value) {
    final daily = value is Map && value.containsKey('refreshRevision');
    final data = BrokerCodec.object(value, {
      'downloadId',
      'fence',
      'generation',
      if (daily) 'refreshRevision',
    });
    return DownloadWorkRequest(
      BrokerCodec.text(data['downloadId']),
      BrokerCodec.fence(data['fence']),
      BrokerCodec.number(data['generation'], minimum: 1),
      refreshRevision: daily
          ? BrokerCodec.number(data['refreshRevision'], minimum: 1)
          : null,
    );
  }

  Map<String, Object?> encode() => {
    'downloadId': downloadId,
    'fence': BrokerCodec.encodeFence(originalFence),
    'generation': generation,
    if (refreshRevision != null) 'refreshRevision': refreshRevision,
  };
}

final class OfflineMixRefreshRequest {
  OfflineMixRefreshRequest(this.originalFence, this.revision) {
    if (revision < 1 ||
        revision > 9007199254740991 ||
        originalFence.epoch < 1) {
      throw const FormatException('Refresh identity');
    }
  }
  final SessionFence originalFence;
  final int revision;
  Map<String, Object?> encode() => {
    'fence': BrokerCodec.encodeFence(originalFence),
    'revision': revision,
  };
  static OfflineMixRefreshRequest decode(Object? value) {
    final row = BrokerCodec.object(value, {'kind', 'fence', 'revision'});
    if (row['kind'] != 'offlineMixRefresh') {
      throw const FormatException('Refresh kind');
    }
    return OfflineMixRefreshRequest(
      BrokerCodec.fence(row['fence']),
      BrokerCodec.number(row['revision'], minimum: 1),
    );
  }
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
    int? refreshRevision,
  }) async => BrokerCodec.text(
    await _channel.invokeMethod<String>('schedule', {
      ...DownloadWorkRequest(
        id,
        fence,
        generation,
        refreshRevision: refreshRevision,
      ).encode(),
      'networkConstraint': networkConstraint.name,
    }),
  );
  Future<void> scheduleRefresh(SessionFence fence, int revision) =>
      _channel.invokeMethod<void>(
        'scheduleRefresh',
        OfflineMixRefreshRequest(fence, revision).encode(),
      );
  Future<void> retryRefresh(SessionFence fence, int revision) =>
      _channel.invokeMethod<void>(
        'retryRefresh',
        OfflineMixRefreshRequest(fence, revision).encode(),
      );
  Future<void> cancelRefresh(SessionFence fence, int revision) =>
      _channel.invokeMethod<void>(
        'cancelRefresh',
        OfflineMixRefreshRequest(fence, revision).encode(),
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
