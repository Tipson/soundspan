import '../core/model/owner_key.dart';
import '../core/model/track.dart';
import '../core/storage/music_codec.dart';
import 'download_checkpoint.dart';

enum DownloadState {
  queued,
  downloading,
  paused,
  verifying,
  ready,
  failed,
  removing,
}

enum DownloadRunResult { ready, busy, cancelled, retry, failed }

/// Immutable durable job. A new user retry receives a new generation; a worker
/// always keeps the fence and generation originally delivered to it.
final class DeviceDownload {
  const DeviceDownload({
    required this.id,
    required this.track,
    required this.quality,
    required this.originalFence,
    required this.generation,
    required this.state,
    required this.manual,
    this.checkpoint,
    this.writer,
    this.leaseUntil = 0,
    this.errorCode,
    this.files = const [],
    this.retryNotBefore = 0,
  });
  final String id;
  final Track track;
  final String quality;
  final SessionFence originalFence;
  final int generation;
  final DownloadState state;
  final bool manual;
  final DownloadCheckpoint? checkpoint;
  final String? writer;
  final int leaseUntil;
  final String? errorCode;

  /// Durable server-directed holdoff, shared by UI retries and headless work.
  final int retryNotBefore;

  /// Every admitted claim remains tracked so removal also cleans crash orphans.
  final List<DownloadCheckpoint> files;
  int get bytes => checkpoint?.bytes ?? 0;
  int? get totalBytes => checkpoint?.totalBytes;
  String? get sha256 => checkpoint?.sha256;

  Map<String, Object?> toJson() => {
    'version': 1,
    'id': id,
    'track': MusicCodec.encodeTrack(track),
    'quality': quality,
    'origin': originalFence.owner.serverOrigin.toString(),
    'user': originalFence.owner.userId,
    'epoch': originalFence.epoch,
    'generation': generation,
    'state': state.name,
    'manual': manual,
    'checkpoint': checkpoint?.toJson(),
    'writer': writer,
    'leaseUntil': leaseUntil,
    'errorCode': errorCode,
    'retryNotBefore': retryNotBefore,
    'files': files.map((file) => file.toJson()).toList(),
  };
  factory DeviceDownload.fromJson(Map<String, Object?> json) {
    if (json['version'] != 1) throw const FormatException('Download version');
    final result = DeviceDownload(
      id: json['id'] as String,
      track: MusicCodec.decodeTrack(json['track']),
      quality: json['quality'] as String,
      originalFence: SessionFence(
        owner: OwnerKey(
          serverOrigin: Uri.parse(json['origin'] as String),
          userId: json['user'] as String,
        ),
        epoch: json['epoch'] as int,
      ),
      generation: json['generation'] as int,
      state: DownloadState.values.byName(json['state'] as String),
      manual: json['manual'] as bool,
      checkpoint: json['checkpoint'] == null
          ? null
          : DownloadCheckpoint.fromJson(
              Map<String, Object?>.from(json['checkpoint'] as Map),
            ),
      writer: json['writer'] as String?,
      leaseUntil: json['leaseUntil'] as int,
      errorCode: json['errorCode'] as String?,
      retryNotBefore: (json['retryNotBefore'] ?? 0) as int,
      files: List.unmodifiable(
        ((json['files'] ?? []) as List).map(
          (f) =>
              DownloadCheckpoint.fromJson(Map<String, Object?>.from(f as Map)),
        ),
      ),
    );
    if (!RegExp(r'^[a-f0-9]{64}$').hasMatch(result.id) ||
        result.generation < 1 ||
        result.originalFence.epoch < 0 ||
        result.retryNotBefore < 0 ||
        result.files.any((f) => f.generation > result.generation) ||
        (result.writer != null &&
            !RegExp(r'^[a-f0-9]{48}$').hasMatch(result.writer!))) {
      throw const FormatException('Download identity');
    }
    return result;
  }
  DeviceDownload patch(Map<String, Object?> changes) =>
      DeviceDownload.fromJson({...toJson(), ...changes});
}
