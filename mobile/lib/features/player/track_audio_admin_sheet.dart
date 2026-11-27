import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';

import '../../core/model/app_failure.dart';
import '../../design_system/music_controls.dart';
import '../../design_system/tokens.dart';
import '../../playback/track_audio_admin.dart';

typedef _SelectedAudio = ({String name, Uint8List bytes});

/// Manages the full version of one track captured by the player action.
abstract final class TrackAudioAdminSheet {
  /// Presents the current drafts and publication for the captured account.
  /// [onDispose] can cancel work that belongs to the sheet's lifetime.
  static Future<void> show(
    BuildContext context, {
    required String trackTitle,
    required Future<TrackAudioAdminState> Function() load,
    required Future<({String name, Uint8List bytes})?> Function() pickFile,
    required Future<TrackAudioAdminState> Function(Uint8List) upload,
    required Future<TrackAudioAdminState> Function(String) publish,
    required Future<TrackAudioAdminState> Function(String) withdraw,
    required bool Function() isCurrent,
    VoidCallback? onDispose,
  }) => showModalBottomSheet<void>(
    context: context,
    useRootNavigator: true,
    isScrollControlled: true,
    useSafeArea: true,
    requestFocus: true,
    sheetAnimationStyle: MediaQuery.disableAnimationsOf(context)
        ? AnimationStyle.noAnimation
        : const AnimationStyle(
            duration: MusicMotion.standard,
            reverseDuration: MusicMotion.standard,
          ),
    builder: (_) => _TrackAudioAdminBody(
      trackTitle: trackTitle,
      load: load,
      pickFile: pickFile,
      upload: upload,
      publish: publish,
      withdraw: withdraw,
      isCurrent: isCurrent,
      onDispose: onDispose,
    ),
  );
}

class _TrackAudioAdminBody extends StatefulWidget {
  const _TrackAudioAdminBody({
    required this.trackTitle,
    required this.load,
    required this.pickFile,
    required this.upload,
    required this.publish,
    required this.withdraw,
    required this.isCurrent,
    required this.onDispose,
  });

  final String trackTitle;
  final Future<TrackAudioAdminState> Function() load;
  final Future<_SelectedAudio?> Function() pickFile;
  final Future<TrackAudioAdminState> Function(Uint8List) upload;
  final Future<TrackAudioAdminState> Function(String) publish, withdraw;
  final bool Function() isCurrent;
  final VoidCallback? onDispose;

  @override
  State<_TrackAudioAdminBody> createState() => _TrackAudioAdminBodyState();
}

class _TrackAudioAdminBodyState extends State<_TrackAudioAdminBody> {
  static const _invalidFile = 'Выберите непустой MP3 размером до 16 МиБ.';
  static const _adminRequired =
      'Для замены аудио войдите с правами администратора.';
  static const _offline =
      'Отключите офлайн-режим, чтобы управлять версиями трека.';

  TrackAudioAdminState? _versions;
  _SelectedAudio? _file;
  String? _progress, _error;

  @override
  void initState() {
    super.initState();
    unawaited(_refresh());
  }

  @override
  void dispose() {
    widget.onDispose?.call();
    super.dispose();
  }

  Future<void> _run<T>(
    String progress,
    Future<T> Function() operation,
    void Function(T result) onResult,
    void Function(Object error) onError,
  ) async {
    if (_progress != null || !_checkSession()) return;
    setState(() {
      _progress = progress;
      _error = null;
    });
    try {
      final result = await operation();
      if (_checkSession()) setState(() => onResult(result));
    } catch (error) {
      if (_checkSession()) setState(() => onError(error));
    } finally {
      if (mounted) setState(() => _progress = null);
    }
  }

  bool _checkSession() {
    if (!mounted) return false;
    if (widget.isCurrent()) return true;
    setState(() {
      _versions = null;
      _file = null;
    });
    return false;
  }

  Future<void> _refresh() => _run(
    'Проверяем версии…',
    widget.load,
    (versions) => _versions = versions,
    (error) => _error = switch (error) {
      AppFailure(statusCode: 404) =>
        'Эта версия сервера не поддерживает замену аудио.',
      AppFailure(statusCode: 401 || 403) => _adminRequired,
      AppFailure(code: 'offline_mode') => _offline,
      _ => 'Не удалось проверить версии трека.',
    },
  );

  Future<void> _choose() => _run(
    'Выбираем файл…',
    widget.pickFile,
    (file) {
      if (file == null) return;
      if (!file.name.toLowerCase().endsWith('.mp3') ||
          file.bytes.isEmpty ||
          file.bytes.length > TrackAudioAdmin.maxUploadBytes) {
        _file = null;
        _error = _invalidFile;
        return;
      }
      _file = file;
    },
    (error) {
      _file = null;
      _error = error is AppFailure ? error.message : 'Не удалось выбрать файл.';
    },
  );

  Future<void> _change(
    Future<TrackAudioAdminState> Function() operation,
    String progress,
    String failure,
  ) => _run(
    progress,
    operation,
    (versions) {
      _versions = versions;
      _file = null;
    },
    (error) {
      _versions = null;
      _file = null;
      _error = switch (error) {
        AppFailure(statusCode: 401 || 403) => _adminRequired,
        AppFailure(code: 'offline_mode') => _offline,
        AppFailure(statusCode: 409) => 'Версии изменились. Обновите список.',
        AppFailure(statusCode: 413) => _invalidFile,
        AppFailure(statusCode: 422) =>
          'Не удалось прочитать MP3. Выберите другой файл.',
        _ => '$failure Обновите версии и проверьте результат.',
      };
    },
  );

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final active = widget.isCurrent();
    final file = _file;
    final busy = _progress != null;
    final versions = _versions;
    final draft = versions?.draftId;
    final published = versions?.publishedId;

    return SafeArea(
      top: false,
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(context).height * 0.85,
        ),
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            spacing: 12,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Semantics(
                      header: true,
                      child: Text(
                        'Полная версия трека',
                        style: theme.textTheme.titleLarge,
                      ),
                    ),
                  ),
                  MusicIconButton(
                    label: 'Закрыть',
                    icon: Icons.close,
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                ],
              ),
              if (!active)
                Semantics(
                  liveRegion: true,
                  child: const Text('Сеанс завершён.'),
                )
              else ...[
                Text(widget.trackTitle, style: theme.textTheme.titleMedium),
                if (busy) ...[
                  Semantics(liveRegion: true, child: Text(_progress!)),
                  const ExcludeSemantics(child: LinearProgressIndicator()),
                ],
                if (_error != null)
                  Semantics(
                    liveRegion: true,
                    child: Text(
                      _error!,
                      style: TextStyle(color: theme.colorScheme.error),
                    ),
                  ),
                if (versions == null && !busy)
                  MusicButton(label: 'Обновить версии', onPressed: _refresh),
                if (versions != null) ...[
                  Semantics(
                    liveRegion: true,
                    child: Text(
                      published == null
                          ? 'Полная версия не опубликована'
                          : 'Без цензуры · опубликовано',
                    ),
                  ),
                  Text(file?.name ?? 'Аудиофайл MP3 до 16 МиБ'),
                  if (file != null)
                    TextButton(
                      onPressed: busy
                          ? null
                          : () => setState(() => _file = null),
                      child: const Text('Сбросить выбор файла'),
                    ),
                  OutlinedButton(
                    onPressed: busy ? null : _choose,
                    child: const Text('Выбрать MP3'),
                  ),
                  MusicButton(
                    label: 'Загрузить черновик',
                    onPressed: busy || file == null
                        ? null
                        : () => _change(
                            () => widget.upload(file.bytes),
                            'Загружаем черновик…',
                            'Не удалось подтвердить загрузку.',
                          ),
                  ),
                  if (draft != null) ...[
                    Semantics(
                      liveRegion: true,
                      child: const Text('Черновик готов'),
                    ),
                    const Text(
                      'Черновик можно прослушать в веб-версии в меню трека.',
                    ),
                    MusicButton(
                      label: 'Опубликовать для всех',
                      disabledReason: file == null
                          ? null
                          : 'Загрузите выбранный файл или сбросьте выбор.',
                      onPressed: busy || file != null
                          ? null
                          : () => _change(
                              () => widget.publish(draft),
                              'Публикуем полную версию…',
                              'Не удалось подтвердить публикацию.',
                            ),
                    ),
                  ],
                  if (published != null)
                    OutlinedButton(
                      onPressed: busy
                          ? null
                          : () => _change(
                              () => widget.withdraw(published),
                              'Снимаем с публикации…',
                              'Не удалось подтвердить снятие с публикации.',
                            ),
                      child: const Text('Снять с публикации'),
                    ),
                ],
              ],
            ],
          ),
        ),
      ),
    );
  }
}
