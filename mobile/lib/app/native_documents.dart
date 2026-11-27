import 'dart:convert';
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:file_selector/file_selector.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import '../core/model/app_failure.dart';
import '../features/settings/settings_models.dart';

typedef OpenNativeDocument = Future<XFile?> Function(List<XTypeGroup> groups);

final class PlaylistDocument {
  const PlaylistDocument({
    required this.name,
    required this.content,
    this.format,
  });
  final String name, content;
  final String? format;
}

/// User-selected documents only. Neither paths nor filename-supplied MIME are
/// trusted, and an open native chooser cannot adopt a replacement account.
final class NativeDocuments {
  NativeDocuments({OpenNativeDocument? open}) : _open = open ?? _openDocument;
  final OpenNativeDocument _open;
  static const _channel = MethodChannel('soundspan/documents');

  static Future<XFile?> _openDocument(List<XTypeGroup> groups) async {
    if (kIsWeb || defaultTargetPlatform != TargetPlatform.android) {
      return openFile(acceptedTypeGroups: groups);
    }
    try {
      final reply = await _channel.invokeMethod<Object?>('pick', {
        'kind': identical(groups.single, _photoTypes)
            ? 'image'
            : identical(groups.single, _exportTypes)
            ? 'export'
            : identical(groups.single, _audioTypes)
            ? 'audio'
            : 'playlist',
      });
      if (reply == null) return null;
      if (reply is! Map ||
          reply['bytes'] is! Uint8List ||
          reply['name'] is! String) {
        throw const FormatException('Invalid document reply');
      }
      // cross_file's IO implementation derives name from path even for bytes.
      // This is only a synthetic basename; no filesystem path is opened.
      return XFile.fromData(
        reply['bytes'] as Uint8List,
        path: reply['name'] as String,
      );
    } on PlatformException catch (error) {
      if (identical(groups.single, _audioTypes)) {
        if (error.code == 'document_too_large') throw _largeTrackAudio;
        if (error.code == 'document_empty') throw _invalidTrackAudio;
      }
      throw _pickerFailed;
    } catch (_) {
      throw _pickerFailed;
    }
  }

  static const maxPlaylistBytes = 512 * 1024;
  static const maxTrackAudioBytes = 16 * 1024 * 1024;
  static const _audioTypes = XTypeGroup(
    label: 'Аудиофайл MP3',
    extensions: ['mp3'],
    mimeTypes: ['audio/mpeg'],
    uniformTypeIdentifiers: ['public.mp3'],
  );
  static const _exportTypes = XTypeGroup(
    label: 'Музыкальный экспорт',
    extensions: ['txt', 'json'],
    mimeTypes: ['text/plain', 'application/json', 'application/octet-stream'],
    uniformTypeIdentifiers: ['public.data'],
  );
  static const _playlistTypes = XTypeGroup(
    label: 'Плейлист M3U',
    extensions: ['m3u', 'm3u8'],
    mimeTypes: [
      'audio/x-mpegurl',
      'application/vnd.apple.mpegurl',
      'application/x-mpegurl',
      'text/plain',
    ],
    uniformTypeIdentifiers: ['public.data'],
  );
  static const _photoTypes = XTypeGroup(
    label: 'Фото профиля',
    extensions: ['jpg', 'jpeg', 'png', 'webp'],
    mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    uniformTypeIdentifiers: ['public.image'],
  );
  bool _busy = false;

  void _check(bool Function() isCurrent) {
    if (!isCurrent()) throw _stale;
  }

  Future<T?> _pick<T>(
    XTypeGroup group,
    bool Function() isCurrent,
    Future<T> Function(XFile) read,
  ) async {
    _check(isCurrent);
    if (_busy) {
      throw const AppFailure(
        code: 'document_picker_busy',
        message: 'Выбор файла уже открыт.',
      );
    }
    _busy = true;
    try {
      final selected = await _open([group]);
      _check(isCurrent);
      if (selected == null) return null;
      final result = await read(selected);
      _check(isCurrent);
      return result;
    } finally {
      _busy = false;
    }
  }

  Future<Uint8List> _read(
    XFile file,
    int limit,
    bool Function() isCurrent,
    AppFailure tooLarge,
  ) async {
    final length = await file.length();
    _check(isCurrent);
    if (length < 0 || length > limit) throw tooLarge;
    final bytes = BytesBuilder(copy: false);
    await for (final chunk in file.openRead()) {
      _check(isCurrent);
      if (bytes.length + chunk.length > limit) throw tooLarge;
      bytes.add(chunk);
    }
    _check(isCurrent);
    return bytes.takeBytes();
  }

  Future<PlaylistDocument?> pickPlaylist({
    required bool Function() isCurrent,
  }) => _pick(_playlistTypes, isCurrent, (file) async {
    if (!RegExp(r'\.m3u8?$', caseSensitive: false).hasMatch(file.name)) {
      throw _invalidPlaylist;
    }
    final bytes = await _read(
      file,
      maxPlaylistBytes,
      isCurrent,
      _largePlaylist,
    );
    String content;
    try {
      content = utf8.decode(bytes);
    } on FormatException {
      throw _invalidPlaylist;
    }
    if (content.startsWith('\ufeff')) content = content.substring(1);
    if (content.trim().isEmpty || content.contains('\u0000')) {
      throw _invalidPlaylist;
    }
    final basename = file.name
        .replaceAll('\\', '/')
        .split('/')
        .last
        .replaceAll(RegExp(r'[\x00-\x1f\x7f]'), '')
        .replaceFirst(RegExp(r'\.m3u8?$', caseSensitive: false), '')
        .trim();
    final name = basename.isEmpty
        ? 'Импорт M3U'
        : basename.substring(0, math.min(basename.length, 200));
    // ApiRequest bounds JSON bodies independently. A file with many escaped
    // characters must not turn a bounded document into an oversized request.
    if (utf8.encode(jsonEncode({'content': content, 'name': name})).length >
        1024 * 1024) {
      throw _largePlaylist;
    }
    return PlaylistDocument(name: name, content: content);
  });

  Future<PlaylistDocument?> pickMusicExport({
    required bool Function() isCurrent,
  }) => _pick(_exportTypes, isCurrent, (file) async {
    final extension = RegExp(
      r'\.(txt|json)$',
      caseSensitive: false,
    ).firstMatch(file.name);
    const invalid = AppFailure(
      code: 'import_file_invalid',
      message: 'Выберите текстовый файл или экспорт Spotify в UTF-8 размером до 512 КБ.',
    );
    if (extension == null) throw invalid;
    final bytes = await _read(file, maxPlaylistBytes, isCurrent, invalid);
    String content;
    try {
      content = utf8.decode(bytes);
    } on FormatException {
      throw invalid;
    }
    if (content.startsWith('\ufeff')) content = content.substring(1);
    if (content.trim().isEmpty || content.contains('\u0000')) throw invalid;
    final basename = file.name
        .replaceAll('\\', '/')
        .split('/')
        .last
        .replaceAll(RegExp(r'[\x00-\x1f\x7f]'), '')
        .replaceFirst(RegExp(r'\.(txt|json)$', caseSensitive: false), '')
        .trim();
    final name = basename.isEmpty
        ? 'Импорт музыки'
        : basename.substring(0, math.min(basename.length, 200));
    if (utf8.encode(jsonEncode({'content': content, 'name': name})).length >
        1024 * 1024) {
      throw invalid;
    }
    return PlaylistDocument(
      name: name,
      content: content,
      format: extension[1]!.toLowerCase() == 'json' ? 'spotify-json' : 'text',
    );
  });

  /// Reads an MP3 candidate for the server to validate and stage as a draft.
  Future<({String name, Uint8List bytes})?> pickTrackAudio({
    required bool Function() isCurrent,
  }) => _pick(_audioTypes, isCurrent, (file) async {
    final basename = file.name
        .replaceAll('\\', '/')
        .split('/')
        .last
        .replaceAll(
          RegExp(r'[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]'),
          '',
        )
        .trim();
    if (!basename.toLowerCase().endsWith('.mp3')) throw _invalidTrackAudio;
    final bytes = await _read(
      file,
      maxTrackAudioBytes,
      isCurrent,
      _largeTrackAudio,
    );
    if (bytes.isEmpty) throw _invalidTrackAudio;
    final name = basename.length > 200
        ? '${basename.substring(0, 196)}${basename.substring(basename.length - 4)}'
        : basename;
    return (name: name, bytes: bytes);
  });

  Future<AvatarInput?> pickAvatar({required bool Function() isCurrent}) =>
      _pick(_photoTypes, isCurrent, (file) async {
        final bytes = await _read(
          file,
          AvatarInput.maxBytes,
          isCurrent,
          _invalidAvatar,
        );
        bool prefix(List<int> values, [int offset = 0]) =>
            bytes.length >= offset + values.length &&
            List.generate(
              values.length,
              (i) => bytes[offset + i] == values[i],
            ).every((value) => value);
        if (!(prefix([0xff, 0xd8, 0xff]) ||
            prefix([137, 80, 78, 71, 13, 10, 26, 10]) ||
            (prefix([82, 73, 70, 70]) && prefix([87, 69, 66, 80], 8)))) {
          throw _invalidAvatar;
        }
        ui.ImmutableBuffer? buffer;
        ui.ImageDescriptor? descriptor;
        ui.Codec? codec;
        ui.Image? image;
        try {
          buffer = await ui.ImmutableBuffer.fromUint8List(bytes);
          _check(isCurrent);
          descriptor = await ui.ImageDescriptor.encoded(buffer);
          _check(isCurrent);
          if (descriptor.width < 1 ||
              descriptor.height < 1 ||
              descriptor.width * descriptor.height > 16 * 1024 * 1024) {
            throw _invalidAvatar;
          }
          final ratio = math.min(
            1.0,
            512 / math.max(descriptor.width, descriptor.height),
          );
          codec = await descriptor.instantiateCodec(
            targetWidth: math.max(1, (descriptor.width * ratio).round()),
            targetHeight: math.max(1, (descriptor.height * ratio).round()),
          );
          _check(isCurrent);
          if (codec.frameCount != 1) throw _invalidAvatar;
          final frame = await codec.getNextFrame();
          image = frame.image;
          _check(isCurrent);
          final png = await image.toByteData(format: ui.ImageByteFormat.png);
          _check(isCurrent);
          if (png == null) throw _invalidAvatar;
          final validated = await AvatarInput.validate(
            png.buffer.asUint8List(png.offsetInBytes, png.lengthInBytes),
          );
          _check(isCurrent);
          return validated;
        } on AppFailure {
          rethrow;
        } catch (_) {
          throw _invalidAvatar;
        } finally {
          image?.dispose();
          codec?.dispose();
          descriptor?.dispose();
          buffer?.dispose();
        }
      });

  static const _pickerFailed = AppFailure(
    code: 'document_picker_failed',
    message: 'Не удалось прочитать файл. Выберите его ещё раз.',
  );
  static const _stale = AppFailure(
    code: 'stale_session',
    message: 'Сеанс завершён. Выберите файл после входа.',
  );
  static const _largePlaylist = AppFailure(
    code: 'playlist_file_too_large',
    message: 'Выберите плейлист M3U размером до 512 КБ.',
  );
  static const _invalidPlaylist = AppFailure(
    code: 'invalid_playlist_file',
    message: 'Выберите непустой M3U или M3U8 в кодировке UTF-8.',
  );
  static const _largeTrackAudio = AppFailure(
    code: 'track_audio_too_large',
    message: 'Выберите MP3 размером до 16 МиБ.',
  );
  static const _invalidTrackAudio = AppFailure(
    code: 'invalid_track_audio',
    message: 'Выберите непустой файл MP3.',
  );
  static const _invalidAvatar = AppFailure(
    code: 'invalid_avatar',
    message:
        'Выберите неподвижное JPEG, PNG или WebP до 5 МБ и 16 мегапикселей.',
  );
}
