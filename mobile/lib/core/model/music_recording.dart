enum NativeMusicProvider { vk, yandex }

enum MusicContentVersion { explicit, clean, unknown }

/// Public, portable exact recording metadata. Contains no stream URL or lease.
final class MusicRecording {
  factory MusicRecording({
    required NativeMusicProvider provider,
    required String id,
    required String title,
    required List<String> artists,
    required double durationSeconds,
    required MusicContentVersion contentVersion,
    String? isrc,
  }) {
    final normalizedTitle = title.trim();
    final normalizedArtists = artists.map((artist) => artist.trim()).toList();
    final pattern = provider == NativeMusicProvider.vk
        ? RegExp(r'^-?\d{1,20}_\d{1,20}$')
        : RegExp(r'^\d{1,20}$');
    if (!pattern.hasMatch(id) ||
        id.length > 42 ||
        normalizedTitle.isEmpty ||
        normalizedTitle.length > 200 ||
        normalizedArtists.isEmpty ||
        normalizedArtists.length > 10 ||
        normalizedArtists.any(
          (artist) => artist.isEmpty || artist.length > 100,
        ) ||
        !durationSeconds.isFinite ||
        durationSeconds <= 0 ||
        durationSeconds > 3600 ||
        (isrc != null &&
            !RegExp(r'^[A-Za-z]{2}[A-Za-z0-9]{3}\d{7}$').hasMatch(isrc))) {
      throw ArgumentError('Invalid public music recording');
    }
    return MusicRecording._(
      provider: provider,
      id: id,
      title: normalizedTitle,
      artists: List.unmodifiable(normalizedArtists),
      durationSeconds: durationSeconds,
      contentVersion: contentVersion,
      isrc: isrc,
    );
  }

  const MusicRecording._({
    required this.provider,
    required this.id,
    required this.title,
    required this.artists,
    required this.durationSeconds,
    required this.contentVersion,
    this.isrc,
  });

  final NativeMusicProvider provider;
  final String id;
  final String title;
  final List<String> artists;
  final double durationSeconds;
  final MusicContentVersion contentVersion;
  final String? isrc;

  String get identityKey => '${provider.name}:$id';
  Duration get duration =>
      Duration(microseconds: (durationSeconds * 1000000).round());

  /// Sanitized candidate snapshot for queue persistence and play feedback.
  Map<String, Object?> toJson() => {
    'provider': provider.name,
    'id': id,
    'title': title,
    'artists': artists,
    'duration': durationSeconds,
    'contentVersion': contentVersion.name,
    'preview': false,
    if (isrc != null) 'isrc': isrc,
  };
}
