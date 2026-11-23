import 'dart:async';

import 'package:flutter/material.dart';

import '../../design_system/design_system.dart';
import '../library/library_models.dart';
import 'playlist_controller.dart';
import 'playlist_editor_sheet.dart';

class PlaylistListScreen extends StatefulWidget {
  const PlaylistListScreen({
    super.key,
    required this.controller,
    required this.onOpenPlaylist,
    this.onImportPlaylist,
    this.autoLoad = true,
  });
  final PlaylistController controller;
  final FutureOr<void> Function(String id) onOpenPlaylist;
  final FutureOr<void> Function()? onImportPlaylist;
  final bool autoLoad;
  @override
  State<PlaylistListScreen> createState() => _PlaylistListScreenState();
}

class _PlaylistListScreenState extends State<PlaylistListScreen> {
  bool _hidden = false;
  String? _failure;
  @override
  void initState() {
    super.initState();
    if (widget.autoLoad) unawaited(widget.controller.refreshList());
  }

  @override
  void didUpdateWidget(PlaylistListScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      _hidden = false;
      _failure = null;
      if (widget.autoLoad) unawaited(widget.controller.refreshList());
    }
  }

  Future<void> _run(FutureOr<void> Function() fn) async {
    final c = widget.controller;
    try {
      if (!c.isCurrent) return;
      await fn();
    } catch (e) {
      if (mounted && c == widget.controller && c.isCurrent) {
        setState(() => _failure = collectionFailure(e).message);
      }
    }
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.controller,
    builder: (context, _) {
      final c = widget.controller;
      final state = c.state;
      final rows = state.playlists.where((p) => p.isHidden == _hidden).toList();
      return ScreenScaffold(
        title: 'Плейлисты',
        actions: state.stale
            ? null
            : [
                MusicIconButton(
                  label: 'Обновить плейлисты',
                  icon: Icons.refresh,
                  onPressed: state.loading ? null : c.refreshList,
                ),
              ],
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (state.stale)
              const MusicStatus(
                message: 'Аккаунт изменился. Откройте раздел снова.',
              )
            else ...[
              MusicButton(
                label: 'Создать плейлист',
                icon: Icons.add,
                onPressed: c.canMutate
                    ? () => _run(
                        () => PlaylistEditorSheet.show(context, controller: c),
                      )
                    : null,
                disabledReason: !c.repository.networkPolicy.networkAllowed
                    ? 'Для создания нужна сеть.'
                    : null,
              ),
              if (widget.onImportPlaylist != null) ...[
                const SizedBox(height: 12),
                MusicButton(
                  label: 'Импортировать плейлист',
                  tonal: true,
                  onPressed: () => _run(widget.onImportPlaylist!),
                ),
              ],
              const SizedBox(height: 16),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Показать скрытые плейлисты'),
                value: _hidden,
                onChanged: (v) => setState(() => _hidden = v),
              ),
              if (state.uncertain) ...[
                MusicStatus(
                  message:
                      '${state.pendingIntent ?? 'Изменение'}: результат неизвестен. Проверьте список перед новым действием.',
                  error: true,
                ),
                MusicButton(
                  label: 'Проверить состояние',
                  onPressed: c.reconcile,
                ),
                if (state.reconciled)
                  MusicButton(
                    label: 'Я проверил результат',
                    onPressed: c.acknowledgeReconciliation,
                  ),
              ],
              if (_failure != null)
                MusicStatus(message: _failure!, error: true),
              if (state.failure != null)
                MusicErrorState(
                  title: 'Не удалось обновить плейлисты',
                  message: state.failure!.message,
                  onRetry: c.refreshList,
                ),
              if (state.loading)
                const MusicLoadingState(label: 'Загружаем плейлисты'),
              if (!state.loading && rows.isEmpty)
                MusicEmptyState(
                  title: _hidden ? 'Нет скрытых плейлистов' : 'Ваши плейлисты',
                  message: 'Создайте плейлист и добавьте любимые записи.',
                  icon: Icons.queue_music,
                ),
              for (final p in rows)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  child: MusicTapTarget(
                    onTap: () => _run(() => widget.onOpenPlaylist(p.id)),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(vertical: 16),
                      child: Row(
                        children: [
                          const Icon(Icons.queue_music),
                          const SizedBox(width: 16),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  p.name,
                                  style: Theme.of(context)
                                      .textTheme
                                      .titleMedium,
                                ),
                                Text(
                                  '${p.trackCount} записей · ${p.isOwner ? 'Ваш плейлист' : 'Общий плейлист'}${p.isPublic ? ' · Публичный' : ''}',
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
            ],
          ],
        ),
      );
    },
  );
}
