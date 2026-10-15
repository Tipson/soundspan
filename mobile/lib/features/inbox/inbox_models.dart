import '../shares/owner_endpoint.dart';

enum InboxAction { read, readAll, clear, clearAll }

enum InboxDestinationKind { playlist, album }

final class InboxDestination {
  const InboxDestination(this.kind, this.id);
  final InboxDestinationKind kind;
  final String id;
}

final class InboxEntry {
  const InboxEntry({
    required this.id,
    required this.type,
    required this.title,
    required this.message,
    required this.read,
    required this.cleared,
    required this.createdAt,
    this.destination,
  });
  final String id, type, title;
  final String? message;
  final bool read, cleared;
  final DateTime? createdAt;
  final InboxDestination? destination;
  bool get serverAcquisition => type == 'download_complete';
  factory InboxEntry.decode(Object? raw) {
    final dto = capabilityObject(raw);
    if (dto['read'] is! bool || dto['cleared'] is! bool) {
      throw invalidCapability;
    }
    final type = _plain(dto['type'], 100, 'system');
    InboxDestination? destination;
    final metadata = dto['metadata'];
    if (metadata is Map) {
      final key = switch (type) {
        'playlist_ready' || 'import_complete' => 'playlistId',
        'download_complete' => 'albumId',
        _ => null,
      };
      if (key != null && metadata[key] != null) {
        try {
          destination = InboxDestination(
            key == 'playlistId'
                ? InboxDestinationKind.playlist
                : InboxDestinationKind.album,
            capabilityId(metadata[key]),
          );
        } catch (_) {
          /* Unknown metadata never becomes an action capability. */
        }
      }
    }
    final date = dto['createdAt'];
    return InboxEntry(
      id: capabilityId(dto['id']),
      type: type,
      title: _plain(dto['title'], 500, 'Уведомление'),
      message: dto['message'] == null ? null : _plain(dto['message'], 4000, ''),
      read: dto['read'] as bool,
      cleared: dto['cleared'] as bool,
      createdAt: date is String && date.length <= 40
          ? DateTime.tryParse(date)
          : null,
      destination: destination,
    );
  }
  InboxEntry markRead() => InboxEntry(
    id: id,
    type: type,
    title: title,
    message: message,
    read: true,
    cleared: cleared,
    createdAt: createdAt,
    destination: destination,
  );
}

String _plain(Object? value, int limit, String fallback) {
  if (value is! String) return fallback;
  final text = value
      .replaceAll(RegExp(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]'), '')
      .trim();
  return text.length <= limit ? text : '${text.substring(0, limit)}…';
}
