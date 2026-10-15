import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/model/app_failure.dart';
import '../../design_system/design_system.dart';
import 'library_controller.dart';
import 'library_models.dart';

enum _LibraryFilter { all, playlists, albums, artists }

/// Navigation destinations and collection creation are supplied by composition.
class LibraryScreen extends StatefulWidget {
  const LibraryScreen({
    super.key,
    required this.controller,
    required this.onOpenLiked,
    this.onOpenDownloads,
    this.onCreatePlaylist,
    this.onImportPlaylist,
    this.onOpenSearch,
    this.onOpenEntity,
    this.onOpenPlaylist,
    this.scrollController,
    this.autoLoad = true,
  });
  final LibraryController controller;
  final FutureOr<void> Function() onOpenLiked;
  final FutureOr<void> Function()? onOpenDownloads;
  final FutureOr<void> Function()? onCreatePlaylist;
  final FutureOr<void> Function()? onImportPlaylist;
  final FutureOr<void> Function()? onOpenSearch;
  final FutureOr<void> Function(SavedEntityRef entity)? onOpenEntity;
  final FutureOr<void> Function(String id)? onOpenPlaylist;
  final ScrollController? scrollController;
  final bool autoLoad;
  @override
  State<LibraryScreen> createState() => _LibraryScreenState();
}

class _LibraryScreenState extends State<LibraryScreen> {
  _LibraryFilter _filter = _LibraryFilter.all;
  AppFailure? _actionFailure;
  @override
  void initState() {
    super.initState();
    if (widget.autoLoad &&
        !widget.controller.state.loading &&
        widget.controller.state.collection.saved.isEmpty &&
        widget.controller.state.collection.playlists.isEmpty) {
      unawaited(widget.controller.refresh());
    }
  }

  @override
  void didUpdateWidget(LibraryScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      _filter = _LibraryFilter.all;
      _actionFailure = null;
      if (widget.autoLoad) unawaited(widget.controller.refresh());
    }
  }

  Future<void> _run(
    FutureOr<void> Function() action, {
    LibraryController? owner,
  }) async {
    final controller = owner ?? widget.controller;
    if (!mounted ||
        !identical(controller, widget.controller) ||
        !controller.isCurrent) {
      return;
    }
    setState(() => _actionFailure = null);
    try {
      await action();
    } catch (error) {
      if (mounted &&
          identical(controller, widget.controller) &&
          controller.isCurrent) {
        setState(() => _actionFailure = collectionFailure(error));
      }
    }
  }

  Future<void> _actions() {
    final owner = widget.controller;
    return MusicActionSheet.show(context, [
      if (widget.onCreatePlaylist != null)
        MusicAction(
          id: 'create',
          label: 'Создать плейлист',
          icon: Icons.playlist_add,
          onSelected: () =>
              _run(() => widget.onCreatePlaylist!(), owner: owner),
        ),
      if (widget.onImportPlaylist != null)
        MusicAction(
          id: 'import',
          label: 'Импортировать плейлист',
          icon: Icons.file_download_outlined,
          onSelected: () =>
              _run(() => widget.onImportPlaylist!(), owner: owner),
        ),
      MusicAction(
        id: 'refresh',
        label: 'Обновить коллекцию',
        icon: Icons.refresh,
        onSelected: () => _run(owner.refresh, owner: owner),
      ),
    ], title: 'Действия с коллекцией');
  }

  Future<void> _savedActions(SavedEntityRef entity) {
    final controller = widget.controller;
    final pending = controller.state.pending.contains(entity.identityKey);
    return MusicActionSheet.show(context, [
      if (widget.onOpenEntity != null)
        MusicAction(
          id: 'open',
          label: entity.kind == SavedEntityKind.album
              ? 'Открыть альбом'
              : 'Открыть исполнителя',
          icon: Icons.open_in_new,
          onSelected: () =>
              _run(() => widget.onOpenEntity!(entity), owner: controller),
        ),
      MusicAction(
        id: 'remove',
        label: 'Убрать из моей музыки',
        icon: Icons.bookmark_remove_outlined,
        destructive: true,
        disabledReason: pending
            ? 'Изменение сохраняется.'
            : !controller.canMutate
            ? 'Для изменения нужна сеть и действующий аккаунт.'
            : null,
        onSelected: pending || !controller.canMutate
            ? null
            : () => _run(() async {
                if (controller != widget.controller) return;
                await controller.save(entity, false);
              }, owner: controller),
      ),
    ], title: entity.title);
  }

  Widget _destination({
    required String label,
    required String subtitle,
    required IconData icon,
    required FutureOr<void> Function() callback,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: MusicTapTarget(
      onTap: () => _run(callback),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 16, horizontal: 12),
        child: Row(
          children: [
            Icon(icon, size: 32, color: MusicColors.primary),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(label, style: Theme.of(context).textTheme.titleLarge),
                  const SizedBox(height: 4),
                  Text(subtitle, style: Theme.of(context).textTheme.bodyMedium),
                ],
              ),
            ),
            const SizedBox(width: 8),
            const Icon(Icons.chevron_right),
          ],
        ),
      ),
    ),
  );

  Widget _heading(String title) => Padding(
    padding: const EdgeInsets.only(top: 28, bottom: 12),
    child: Semantics(
      header: true,
      child: Text(title, style: Theme.of(context).textTheme.titleLarge),
    ),
  );
  Widget _savedRow(SavedEntityRef entity) => Row(
    children: [
      Expanded(
        child: MusicTapTarget(
          onTap: widget.onOpenEntity == null
              ? null
              : () => _run(() => widget.onOpenEntity!(entity)),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 12),
            child: Row(
              children: [
                Artwork(uri: entity.image, size: 48),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        entity.title,
                        maxLines: 3,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      if (entity.subtitle != null) ...[
                        const SizedBox(height: 4),
                        Text(
                          entity.subtitle!,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ],
                      if (widget.controller.state.pending.contains(
                        entity.identityKey,
                      ))
                        const Text('Сохраняем изменение…'),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
      const SizedBox(width: 8),
      MusicIconButton(
        label: 'Действия: ${entity.title}',
        icon: Icons.more_vert,
        onPressed: () => _savedActions(entity),
      ),
    ],
  );

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.controller,
    builder: (context, _) {
      final state = widget.controller.state;
      final collection = state.collection;
      final showPlaylists =
          _filter == _LibraryFilter.all || _filter == _LibraryFilter.playlists;
      final kinds = switch (_filter) {
        _LibraryFilter.albums => [SavedEntityKind.album],
        _LibraryFilter.artists => [SavedEntityKind.artist],
        _LibraryFilter.playlists => <SavedEntityKind>[],
        _LibraryFilter.all => SavedEntityKind.values,
      };
      return ScreenScaffold(
        title: 'Моя музыка',
        scrollController: widget.scrollController,
        actions: state.stale
            ? null
            : [
                MusicIconButton(
                  label: 'Действия с коллекцией',
                  icon: Icons.more_horiz,
                  onPressed: _actions,
                ),
              ],
        child: state.stale
            ? const MusicStatus(
                message: 'Аккаунт изменился. Откройте раздел снова.',
              )
            : Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _destination(
                    label: 'Любимое',
                    subtitle: 'Треки, которые вам нравятся',
                    icon: Icons.favorite_rounded,
                    callback: widget.onOpenLiked,
                  ),
                  if (widget.onOpenDownloads != null)
                    _destination(
                      label: 'Загрузки',
                      subtitle: 'Музыка на этом устройстве',
                      icon: Icons.offline_pin_outlined,
                      callback: widget.onOpenDownloads!,
                    ),
                  if (widget.onCreatePlaylist != null) ...[
                    const SizedBox(height: 8),
                    MusicButton(
                      label: 'Создать плейлист',
                      icon: Icons.add,
                      onPressed: () => _run(widget.onCreatePlaylist!),
                    ),
                  ],
                  const SizedBox(height: 24),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      for (final filter in _LibraryFilter.values)
                        ConstrainedBox(
                          constraints: const BoxConstraints(minHeight: 48),
                          child: ChoiceChip(
                            label: Text(switch (filter) {
                              _LibraryFilter.all => 'Всё',
                              _LibraryFilter.playlists => 'Плейлисты',
                              _LibraryFilter.albums => 'Альбомы',
                              _LibraryFilter.artists => 'Исполнители',
                            }),
                            selected: _filter == filter,
                            onSelected: (_) => setState(() => _filter = filter),
                          ),
                        ),
                    ],
                  ),
                  if (_actionFailure != null)
                    MusicStatus(message: _actionFailure!.message, error: true),
                  if (state.failure != null)
                    MusicErrorState(
                      title: 'Не удалось обновить коллекцию',
                      message: state.failure!.message,
                      onRetry: widget.controller.refresh,
                    ),
                  if (collection.degraded)
                    const MusicStatus(
                      message: 'Часть коллекции пока недоступна. Доступная музыка остаётся ниже.',
                    ),
                  if (state.loading &&
                      collection.saved.isEmpty &&
                      collection.playlists.isEmpty)
                    const MusicLoadingState(label: 'Загружаем коллекцию')
                  else ...[
                    if (state.loading)
                      const Padding(
                        padding: EdgeInsets.only(top: 12),
                        child: LinearProgressIndicator(),
                      ),
                    if (showPlaylists) ...[
                      _heading('Плейлисты'),
                      if (collection.playlistsFailure != null)
                        MusicErrorState(
                          title: 'Плейлисты недоступны',
                          message: collection.playlistsFailure!.message,
                          onRetry: widget.controller.retryPlaylists,
                        ),
                      if (collection.playlists.isEmpty &&
                          collection.playlistsFailure == null)
                        const MusicStatus(
                          message: 'Ваши плейлисты появятся здесь.',
                        ),
                      for (final playlist in collection.playlists)
                        MusicTapTarget(
                          onTap: widget.onOpenPlaylist == null
                              ? null
                              : () => _run(
                                  () => widget.onOpenPlaylist!(playlist.id),
                                ),
                          child: Padding(
                            padding: const EdgeInsets.symmetric(vertical: 16),
                            child: Row(
                              children: [
                                const Icon(Icons.queue_music, size: 32),
                                const SizedBox(width: 16),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        playlist.name,
                                        maxLines: 3,
                                        overflow: TextOverflow.ellipsis,
                                        style: Theme.of(context)
                                            .textTheme
                                            .titleMedium,
                                      ),
                                      const SizedBox(height: 4),
                                      Text('${playlist.trackCount} треков'),
                                    ],
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                    ],
                    for (final kind in kinds) ...[
                      _heading(
                        kind == SavedEntityKind.album
                            ? 'Сохранённые альбомы'
                            : 'Сохранённые исполнители',
                      ),
                      if (collection.savedFailure != null)
                        MusicErrorState(
                          title: 'Сохранённая музыка недоступна',
                          message: collection.savedFailure!.message,
                          onRetry: widget.controller.retrySaved,
                        ),
                      if (!collection.saved.any((e) => e.kind == kind) &&
                          collection.savedFailure == null)
                        MusicStatus(
                          message: kind == SavedEntityKind.album
                              ? 'Сохраняйте альбомы, чтобы возвращаться к ним здесь.'
                              : 'Сохраняйте любимых исполнителей в свою коллекцию.',
                        ),
                      for (final entity in collection.saved.where(
                        (e) => e.kind == kind,
                      ))
                        _savedRow(entity),
                    ],
                    if (collection.hasMoreSaved && kinds.isNotEmpty) ...[
                      const SizedBox(height: 20),
                      MusicButton(
                        label: 'Показать ещё сохранённую музыку',
                        busy: state.loadingMore,
                        onPressed: widget.controller.loadMore,
                      ),
                    ],
                    if (widget.onOpenSearch != null &&
                        collection.saved.isEmpty &&
                        collection.playlists.isEmpty &&
                        !collection.degraded &&
                        !state.loading) ...[
                      const SizedBox(height: 24),
                      MusicButton(
                        label: 'Найти музыку',
                        icon: Icons.search,
                        tonal: true,
                        onPressed: () => _run(widget.onOpenSearch!),
                      ),
                    ],
                  ],
                ],
              ),
      );
    },
  );
}
