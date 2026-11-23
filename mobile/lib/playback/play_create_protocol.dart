import 'dart:convert';

import '../core/model/queue_entry.dart';
import '../core/model/track_ref.dart';
import '../core/network/api_transport.dart';
import '../core/storage/music_codec.dart';
import '../core/storage/owner_store.dart';
import 'playback_event_models.dart';

/// The immutable, URL-free accepted DTO of one remote confirmed run.
final class FrozenPlayCreate {
  const FrozenPlayCreate._(this.body, this.source);
  static const maxBytes = 64 * 1024;
  final Map<String, Object?> body;
  final String source;

  factory FrozenPlayCreate.fromEntry(QueueEntry entry) {
    if (entry.track.ref is! YoutubeTrackRef &&
        entry.track.ref is! NativeTrackRef) {
      throw ArgumentError('Keyed Play requires an admitted remote recording');
    }
    return FrozenPlayCreate.decode(
      playStartBody(entry)..remove('thumbnailUrl'),
    );
  }

  factory FrozenPlayCreate.decode(Object? value) {
    if (value is! Map<String, Object?>) _invalid();
    const common = {
      'playContext',
      'waveMode',
      'recommendationGenerationId',
      'recommendationSessionId',
    };
    final native = value['musicSourceRecording'];
    late final String source;
    final Set<String> keys;
    if (native != null) {
      keys = {...common, 'musicSourceRecording'};
      if (native is! Map<String, Object?> ||
          native['preview'] != false ||
          native.keys.any(
            (key) => !const {
              'provider',
              'id',
              'title',
              'artists',
              'duration',
              'contentVersion',
              'preview',
              'isrc',
            }.contains(key),
          )) {
        _invalid();
      }
      final recording = MusicCodec.decodeRecording({
        'provider': native['provider'],
        'id': native['id'],
        'title': native['title'],
        'artists': native['artists'],
        'durationSeconds': native['duration'],
        'contentVersion': native['contentVersion'],
        'isrc': native['isrc'],
      });
      source = recording.provider.name;
    } else {
      keys = {
        ...common,
        'youtubeVideoId',
        'title',
        'artist',
        'album',
        'duration',
      };
      for (final name in ['youtubeVideoId', 'title', 'artist', 'album']) {
        if (!_text(value[name]) ||
            (value[name] as String).trim() != value[name]) {
          _invalid();
        }
      }
      final duration = value['duration'];
      if (duration is! int || duration < 0 || duration > 9007199254740991) {
        _invalid();
      }
      source = 'youtube';
    }
    if (value.keys.any((key) => !keys.contains(key)) ||
        !PlaySurface.values.any(
          (surface) => surface.name == value['playContext'],
        )) {
      _invalid();
    }
    for (final name in [
      'recommendationGenerationId',
      'recommendationSessionId',
    ]) {
      if (value.containsKey(name) &&
          (!_text(value[name]) || (value[name] as String).length > 128)) {
        _invalid();
      }
    }
    if (value.containsKey('waveMode') &&
        !const {'for-you', 'new', 'familiar'}.contains(value['waveMode'])) {
      _invalid();
    }
    final frozen = OwnerRecord(key: 'create', value: value).value;
    if (utf8.encode(jsonEncode(frozen)).length > maxBytes) _invalid();
    return FrozenPlayCreate._(frozen, source);
  }

  static bool _text(Object? value) =>
      value is String &&
      value.isNotEmpty &&
      value.length <= maxBytes &&
      !RegExp(r'[\x00-\x1f\x7f]').hasMatch(value);
  static Never _invalid() =>
      throw const FormatException('Invalid frozen Play create');
}

/// Owner history epoch and immutable server-time expiry travel inside the key.
final class PlayCreateKey {
  const PlayCreateKey._(this.value, this.epoch, this.issuedAtMs);
  final String value;
  final int epoch, issuedAtMs;
  int get expiresAtMs => issuedAtMs + 86400000;
  factory PlayCreateKey.issue({
    required int epoch,
    required int issuedAtMs,
    String? nonce,
  }) => PlayCreateKey.parse(
    'p1.${epoch.toRadixString(36)}.${issuedAtMs.toRadixString(36)}.${nonce ?? newPlaybackTraceId()}',
  );
  factory PlayCreateKey.parse(String value) {
    final match = RegExp(
      r'^p1\.([0-9a-z]{1,6})\.([0-9a-z]{1,11})\.([A-Za-z0-9_-]{32})$',
    ).firstMatch(value);
    if (match == null || value.length > 64) {
      throw const FormatException('Invalid Play key');
    }
    final epoch = int.tryParse(match[1]!, radix: 36);
    final issued = int.tryParse(match[2]!, radix: 36);
    if (epoch == null ||
        epoch < 0 ||
        epoch > 2147483647 ||
        epoch.toRadixString(36) != match[1] ||
        issued == null ||
        issued < 0 ||
        issued > 8640000000000000 - 86400000 ||
        issued.toRadixString(36) != match[2]) {
      throw const FormatException('Invalid Play key');
    }
    return PlayCreateKey._(value, epoch, issued);
  }
}

/// A known ID requires the server's explicit same-key versioned acknowledgement.
final class PlayCreateAck {
  const PlayCreateAck._(this.playId);
  final String playId;
  factory PlayCreateAck.decode(Object? value, PlayCreateKey key) {
    if (value is! Map || value['id'] is! String) _invalid();
    final id = value['id'] as String;
    final ack = value['playCreation'];
    if (id.isEmpty ||
        id.length > 512 ||
        id.trim() != id ||
        RegExp(r'[\x00-\x1f\x7f]').hasMatch(id) ||
        ack is! Map ||
        ack['version'] != 1 ||
        ack['clientPlaybackId'] != key.value ||
        !const {'created', 'replayed'}.contains(ack['disposition']) ||
        ack['replayExpiresAt'] is! String ||
        (ack['replayExpiresAt'] as String).length > 64 ||
        DateTime.tryParse(ack['replayExpiresAt'] as String)
                ?.millisecondsSinceEpoch !=
            key.expiresAtMs) {
      _invalid();
    }
    return PlayCreateAck._(id);
  }
  static Never _invalid() =>
      throw const FormatException('Invalid Play create acknowledgement');
}
