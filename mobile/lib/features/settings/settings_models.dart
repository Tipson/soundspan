import 'dart:typed_data';
import 'dart:ui' as ui;

import '../../core/model/app_failure.dart';
import '../../playback/loudness_gain_policy.dart';
export '../../playback/loudness_gain_policy.dart' show LoudnessMode;

String? validateDisplayName(String raw) {
  final value = raw.trim();
  if (value.length > 80) return 'Не больше 80 символов.';
  if (value.isNotEmpty && !RegExp(r'^[A-Za-z0-9 .-]+$').hasMatch(value)) {
    return 'Сервер принимает латинские буквы, цифры, пробел, точку и дефис.';
  }
  return null;
}

class UserSettings {
  const UserSettings({
    this.displayName,
    this.hasProfilePicture = false,
    this.loudnessMode = LoudnessMode.auto,
    this.shareOnlinePresence = false,
    this.shareListeningStatus = false,
  });
  final String? displayName;
  final bool hasProfilePicture, shareOnlinePresence, shareListeningStatus;
  final LoudnessMode loudnessMode;

  /// Preserves all other confirmed settings after the profile-picture ACK.
  UserSettings withProfilePicture(bool value) => UserSettings(
    displayName: displayName,
    hasProfilePicture: value,
    loudnessMode: loudnessMode,
    shareOnlinePresence: shareOnlinePresence,
    shareListeningStatus: shareListeningStatus,
  );

  factory UserSettings.fromJson(
    Map<String, Object?> dto, {
    bool? hasProfilePicture,
  }) => UserSettings(
    displayName: dto['displayName'] as String?,
    hasProfilePicture:
        dto['hasProfilePicture'] as bool? ?? hasProfilePicture ?? false,
    loudnessMode: LoudnessMode.values.firstWhere(
      (m) => m.name == dto['loudnessMode'],
      orElse: () => LoudnessMode.auto,
    ),
    shareOnlinePresence: dto['shareOnlinePresence'] as bool? ?? false,
    shareListeningStatus: dto['shareListeningStatus'] as bool? ?? false,
  );
}

/// Only listener fields with actual native behavior. Playback quality is owned
/// by NativeOwnerServices and never enters this server patch.
class UserSettingsPatch {
  const UserSettingsPatch({
    this.displayName,
    this.loudnessMode,
    this.shareOnlinePresence,
    this.shareListeningStatus,
  });
  final String? displayName;
  final LoudnessMode? loudnessMode;
  final bool? shareOnlinePresence, shareListeningStatus;
  Map<String, Object?> toJson() {
    if (displayName != null && validateDisplayName(displayName!) != null) {
      throw const AppFailure(
        code: 'invalid_display_name',
        message: 'Проверьте имя профиля.',
      );
    }
    return {
      if (displayName != null)
        'displayName': displayName!.trim().isEmpty ? null : displayName!.trim(),
      if (loudnessMode != null) 'loudnessMode': loudnessMode!.name,
      if (shareOnlinePresence != null)
        'shareOnlinePresence': shareOnlinePresence,
      if (shareListeningStatus != null)
        'shareListeningStatus': shareListeningStatus,
    };
  }
}

/// Validated immutable image, after the native picker has resized it to <=512.
/// No filename, MIME or dimension supplied by a caller is trusted.
class AvatarInput {
  AvatarInput._(
    Uint8List bytes,
    this.mimeType,
    this.filename,
    this.width,
    this.height,
  ) : bytes = bytes.asUnmodifiableView();
  final Uint8List bytes;
  final String mimeType, filename;
  final int width, height;
  static const maxBytes = 5 * 1024 * 1024;
  static Future<AvatarInput> validate(Uint8List source) async {
    if (source.isEmpty || source.length > maxBytes) throw _invalid;
    final bytes = Uint8List.fromList(source);
    bool prefix(List<int> values, [int offset = 0]) =>
        bytes.length >= offset + values.length &&
        List.generate(
          values.length,
          (i) => bytes[offset + i] == values[i],
        ).every((x) => x);
    final (mime, name) = prefix([0xff, 0xd8, 0xff])
        ? ('image/jpeg', 'avatar.jpg')
        : prefix([137, 80, 78, 71, 13, 10, 26, 10])
        ? ('image/png', 'avatar.png')
        : prefix([82, 73, 70, 70]) && prefix([87, 69, 66, 80], 8)
        ? ('image/webp', 'avatar.webp')
        : ('', '');
    if (mime.isEmpty) throw _invalid;
    ui.ImmutableBuffer? buffer;
    ui.ImageDescriptor? descriptor;
    ui.Codec? codec;
    try {
      buffer = await ui.ImmutableBuffer.fromUint8List(bytes);
      descriptor = await ui.ImageDescriptor.encoded(buffer);
      if (descriptor.width < 1 ||
          descriptor.height < 1 ||
          descriptor.width > 512 ||
          descriptor.height > 512) {
        throw _invalid;
      }
      codec = await descriptor.instantiateCodec();
      if (codec.frameCount != 1) throw _invalid;
      final frame = await codec.getNextFrame();
      frame.image.dispose();
      return AvatarInput._(
        bytes,
        mime,
        name,
        descriptor.width,
        descriptor.height,
      );
    } catch (_) {
      throw _invalid;
    } finally {
      codec?.dispose();
      descriptor?.dispose();
      buffer?.dispose();
    }
  }

  static const _invalid = AppFailure(
    code: 'invalid_avatar',
    message: 'Выберите JPEG, PNG или WebP до 5 МБ и 512 × 512 пикселей.',
  );
}
