import '../../core/model/app_failure.dart';
import '../../core/model/owner_key.dart';
import '../../core/model/track.dart';
import '../../core/model/track_ref.dart';
import '../playlists/playlist_models.dart';
import '../search/catalog_models.dart';
import 'owner_endpoint.dart';

const unsupportedShare = AppFailure(
  code: 'unsupported_share',
  message: 'Ссылка доступна только для треков и альбомов серверной библиотеки и ваших плейлистов.',
);
const invalidShareOptions = AppFailure(
  code: 'invalid_share_options',
  message: 'Укажите будущий срок и положительный лимит сеансов доступа.',
);

enum ShareResourceKind { playlist, album, track }

/// Only typed, supported sources can become a resource grant.
final class ShareResource {
  const ShareResource._(this.kind, this.id, this.title);
  final ShareResourceKind kind;
  final String id, title;
  factory ShareResource.track(Track track) {
    if (!track.playable || track.ref is! LibraryTrackRef) {
      throw unsupportedShare;
    }
    return ShareResource._(
      ShareResourceKind.track,
      capabilityId((track.ref as LibraryTrackRef).libraryId),
      track.title,
    );
  }
  factory ShareResource.album(CatalogEntityRef entity) {
    if (entity.kind != CatalogEntityKind.album ||
        entity.source != CatalogSource.library) {
      throw unsupportedShare;
    }
    return ShareResource._(
      ShareResourceKind.album,
      capabilityId(entity.id),
      entity.name,
    );
  }
  factory ShareResource.playlist(PlaylistSummary playlist) {
    if (!playlist.isOwner) throw unsupportedShare;
    return ShareResource._(
      ShareResourceKind.playlist,
      capabilityId(playlist.id),
      playlist.name,
    );
  }
}

final class ShareDraft {
  const ShareDraft(this.resource, {this.expiresAt, this.maxPlays});
  final ShareResource resource;
  final DateTime? expiresAt;
  final int? maxPlays;
  Map<String, Object?> payload(DateTime now) {
    if ((expiresAt != null && !expiresAt!.isAfter(now)) ||
        (maxPlays != null && (maxPlays! < 1 || maxPlays! > 2147483647))) {
      throw invalidShareOptions;
    }
    return {
      'resourceType': resource.kind.name,
      'resourceId': resource.id,
      if (expiresAt != null) 'expiresAt': expiresAt!.toUtc().toIso8601String(),
      if (maxPlays != null) 'maxPlays': maxPlays,
    };
  }
}

/// Bearer URL exists only in this in-memory model, never in persistence/errors.
final class ShareLink {
  const ShareLink._({
    required this.id,
    required this.kind,
    required this.resourceId,
    required this.publicUrl,
    required this.createdAt,
    required this.expiresAt,
    required this.maxPlays,
    required this.playCount,
    required this.revoked,
  });
  final String id, resourceId;
  final ShareResourceKind kind;
  final Uri publicUrl;
  final DateTime createdAt;
  final DateTime? expiresAt;
  final int? maxPlays;
  final int playCount;
  final bool revoked;
  factory ShareLink.decode(Object? value, OwnerKey owner) {
    final dto = capabilityObject(value),
        token = capabilityObject(value)['token'];
    if (dto['userId'] != owner.userId ||
        token is! String ||
        !RegExp(r'^[a-f0-9]{64}$').hasMatch(token) ||
        dto['accessPath'] != '/api/share-links/access/$token' ||
        dto['revoked'] is! bool) {
      throw invalidCapability;
    }
    final kind = ShareResourceKind.values
        .where((k) => k.name == dto['resourceType'])
        .firstOrNull;
    if (kind == null) throw invalidCapability;
    return ShareLink._(
      id: capabilityId(dto['id']),
      kind: kind,
      resourceId: capabilityId(dto['resourceId']),
      publicUrl: owner.serverOrigin.replace(path: '/share/$token'),
      createdAt: _date(dto['createdAt']),
      expiresAt: dto['expiresAt'] == null ? null : _date(dto['expiresAt']),
      maxPlays: dto['maxPlays'] == null
          ? null
          : _count(dto['maxPlays'], positive: true),
      playCount: _count(dto['playCount']),
      revoked: dto['revoked'] as bool,
    );
  }
  bool available(DateTime now) =>
      !revoked &&
      (expiresAt == null || expiresAt!.isAfter(now)) &&
      (maxPlays == null || playCount < maxPlays!);
  @override
  String toString() => 'ShareLink(<redacted>)';
}

DateTime _date(Object? value) {
  if (value is! String || value.length > 40 || !value.endsWith('Z')) {
    throw invalidCapability;
  }
  return DateTime.tryParse(value) ?? (throw invalidCapability);
}

int _count(Object? value, {bool positive = false}) {
  if (value is! int || value < (positive ? 1 : 0) || value > 2147483647) {
    throw invalidCapability;
  }
  return value;
}
