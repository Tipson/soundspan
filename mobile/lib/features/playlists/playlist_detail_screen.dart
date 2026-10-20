import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/model/track.dart';
import '../../design_system/design_system.dart';
import '../library/library_models.dart';
import '../likes/preference_controller.dart';
import '../likes/likes_models.dart';
import 'playlist_controller.dart';
import 'playlist_editor_sheet.dart';
import 'playlist_models.dart';

typedef PlaylistTracksAction = FutureOr<void> Function(List<Track> tracks);

class PlaylistDetailScreen extends StatefulWidget {
  const PlaylistDetailScreen({
    super.key,
    required this.controller,
    required this.preferences,
    required this.onPlay,
    this.playlistId,
    this.onEnqueue,
    this.onPickTracks,
    this.onDownload,
    this.onShare,
    this.onRadio,
    this.autoLoad = true,
  });
  final PlaylistController controller;
  final PreferenceController preferences;
  final Future<void> Function(CollectionPlaybackRequest request) onPlay;
  final String? playlistId;
  final PlaylistTracksAction? onEnqueue, onDownload;
  final Future<List<Track>?> Function()? onPickTracks;
  final FutureOr<void> Function(PlaylistSummary playlist)? onShare;
  final FutureOr<void> Function(String playlistId)? onRadio;
  final bool autoLoad;
  @override
  State<PlaylistDetailScreen> createState() => _PlaylistDetailScreenState();
}

class _PlaylistDetailScreenState extends State<PlaylistDetailScreen> {
  String? _failure;
  bool _playing = false;
  @override
  void initState() {
    super.initState();
    _load();
  }

  void _load() {
    if (widget.autoLoad && widget.playlistId != null) {
      unawaited(widget.controller.open(widget.playlistId!));
    }
  }

  @override
  void didUpdateWidget(PlaylistDetailScreen old) {
    super.didUpdateWidget(old);
    if (old.controller != widget.controller ||
        old.playlistId != widget.playlistId) {
      _failure = null;
      _playing = false;
      _load();
    }
  }

  Future<void> _run(PlaylistController c, FutureOr<void> Function() fn) async {
    if (!mounted || widget.controller != c || !c.isCurrent) return;
    setState(() => _failure = null);
    try {
      await fn();
    } catch (e) {
      if (mounted && widget.controller == c && c.isCurrent) {
        setState(() => _failure = collectionFailure(e).message);
      }
    }
  }

  Future<void> _play(
    PlaylistController c, {
    String? selected,
    bool shuffle = false,
  }) async {
    if (_playing || c != widget.controller || !c.isCurrent) return;
    final items =
        c.state.detail?.items.where((e) => e.track.playable).toList() ?? [];
    final index = selected == null
        ? 0
        : items.indexWhere((e) => e.id == selected);
    if (items.isEmpty || index < 0) return;
    final callback = widget.onPlay;
    final request = CollectionPlaybackRequest(
      tracks: items.map((e) => e.track),
      startIndex: index,
      shuffle: shuffle,
      fence: c.fence,
    );
    setState(() => _playing = true);
    await _run(c, () => callback(request));
    if (mounted && c == widget.controller) setState(() => _playing = false);
  }

  String? _mutationReason(PlaylistController c) =>
      !c.repository.networkPolicy.networkAllowed
      ? 'Для изменения нужна сеть.'
      : c.state.uncertain
      ? 'Сначала проверьте результат предыдущего изменения.'
      : c.state.busy
      ? 'Изменение ещё сохраняется.'
      : null;
  Future<void> _itemActions(PlaylistItem item) async {
    final c = widget.controller;
    final prefs = widget.preferences;
    final d = c.state.detail;
    if (d == null) return;
    final enqueue = widget.onEnqueue;
    final download = widget.onDownload;
    Future<void> run(FutureOr<void> Function() action) => _run(c, () async {
      if (c.state.detail?.playlist.id != d.playlist.id) return;
      await action();
    });
    await MusicActionSheet.show(context, [
      if (item.track.playable)
        MusicAction(
          id: 'play',
          label: 'Слушать отсюда',
          icon: Icons.play_arrow,
          onSelected: () => run(() => _play(c, selected: item.id)),
        ),
      if (enqueue != null && item.track.playable)
        MusicAction(
          id: 'queue',
          label: 'Добавить в очередь',
          icon: Icons.queue_music,
          onSelected: () => run(() => enqueue([item.track])),
        ),
      if (download != null && item.track.playable)
        MusicAction(
          id: 'download',
          label: 'Скачать на устройство',
          icon: Icons.download,
          onSelected: () => run(() => download([item.track])),
        ),
      if (item.track.playable &&
          prefs.supports(item.track.ref, PreferenceSignal.like))
        MusicAction(
          id: 'like',
          label: prefs.current(item.track.ref).signal == PreferenceSignal.like
              ? 'Убрать из любимого'
              : 'Добавить в любимое',
          icon: Icons.favorite_border,
          disabledReason: !prefs.canMutate ? 'Для изменения нужна сеть.' : null,
          onSelected: !prefs.canMutate
              ? null
              : () => run(
                  () => prefs.set(
                    item.track.ref,
                    prefs.current(item.track.ref).signal ==
                            PreferenceSignal.like
                        ? PreferenceSignal.clear
                        : PreferenceSignal.like,
                  ),
                ),
        ),
      if (d.playlist.isOwner)
        MusicAction(
          id: 'remove',
          label: item.pending
              ? 'Удалить ожидающую запись'
              : 'Удалить из плейлиста',
          icon: Icons.delete_outline,
          destructive: true,
          disabledReason: _mutationReason(c),
          onSelected: c.canMutate ? () => run(() => c.remove(item)) : null,
        ),
    ], title: item.track.title);
  }

  Future<void> _actions() async {
    final c = widget.controller;
    final d = c.state.detail;
    if (d == null) return;
    final tracks = d.items
        .where((e) => e.track.playable)
        .map((e) => e.track)
        .toList();
    final enqueue = widget.onEnqueue,
        download = widget.onDownload,
        pick = widget.onPickTracks,
        share = widget.onShare,
        radio = widget.onRadio;
    final prefs = widget.preferences;
    final orderReason = _mutationReason(c) ?? d.reorderBlockedReason;
    Future<void> run(FutureOr<void> Function() action) => _run(c, () async {
      if (c.state.detail?.playlist.id != d.playlist.id) return;
      await action();
    });
    await MusicActionSheet.show(context, [
      MusicAction(
        id: 'refresh',
        label: 'Обновить плейлист',
        icon: Icons.refresh,
        onSelected: () => run(c.refresh),
      ),
      if (d.playlist.isOwner) ...[
        MusicAction(
          id: 'edit',
          label: 'Название и доступ',
          icon: Icons.edit_outlined,
          disabledReason: _mutationReason(c),
          onSelected: c.canMutate
              ? () => run(
                  () => PlaylistEditorSheet.show(
                    context,
                    controller: c,
                    playlist: d.playlist,
                  ),
                )
              : null,
        ),
        if (pick != null)
          MusicAction(
            id: 'add',
            label: 'Добавить треки',
            icon: Icons.playlist_add,
            disabledReason: _mutationReason(c),
            onSelected: c.canMutate
                ? () => run(() async {
                    final tracks = await pick();
                    if (c == widget.controller &&
                        c.isCurrent &&
                        c.state.detail?.playlist.id == d.playlist.id &&
                        tracks != null) {
                      await c.add(tracks);
                    }
                  })
                : null,
          ),
        MusicAction(
          id: 'sort-title',
          label: 'Сортировать по названию',
          icon: Icons.sort_by_alpha,
          disabledReason: orderReason,
          onSelected: orderReason == null
              ? () => run(() {
                  final rows = List<PlaylistItem>.of(d.items)
                    ..sort((a, b) {
                      final n = a.track.title.toLowerCase().compareTo(
                        b.track.title.toLowerCase(),
                      );
                      return n == 0
                          ? d.items.indexOf(a).compareTo(d.items.indexOf(b))
                          : n;
                    });
                  return c.reorder(rows.map((e) => e.id).toList());
                })
              : null,
        ),
        MusicAction(
          id: 'order',
          label: 'Изменить порядок вручную',
          icon: Icons.reorder,
          disabledReason: orderReason,
          onSelected: orderReason == null
              ? () => run(() => _reorder(c, d))
              : null,
        ),
      ],
      if (enqueue != null && tracks.isNotEmpty)
        MusicAction(
          id: 'queue',
          label: 'Добавить показанные треки в очередь',
          icon: Icons.queue_music,
          onSelected: () => run(() => enqueue(tracks)),
        ),
      if (download != null && tracks.isNotEmpty)
        MusicAction(
          id: 'download',
          label: 'Скачать показанные треки',
          icon: Icons.download_outlined,
          onSelected: () => run(() => download(tracks)),
        ),
      if (tracks.isNotEmpty &&
          tracks.every((t) => prefs.supports(t.ref, PreferenceSignal.like)))
        MusicAction(
          id: 'like-all',
          label: 'Добавить показанные треки в любимое',
          icon: Icons.favorite_border,
          disabledReason: !prefs.canMutate ? 'Для изменения нужна сеть.' : null,
          onSelected: !prefs.canMutate
              ? null
              : () => run(() async {
                  for (final t in tracks) {
                    if (c != widget.controller || !c.isCurrent) return;
                    await prefs.set(t.ref, PreferenceSignal.like);
                  }
                }),
        ),
      if (share != null)
        MusicAction(
          id: 'share',
          label: 'Поделиться плейлистом',
          icon: Icons.share_outlined,
          onSelected: () => run(() => share(d.playlist)),
        ),
      if (radio != null)
        MusicAction(
          id: 'radio',
          label: 'Волна по плейлисту',
          icon: Icons.radio_outlined,
          onSelected: () => run(() => radio(d.playlist.id)),
        ),
      MusicAction(
        id: 'hide',
        label: d.playlist.isHidden
            ? 'Вернуть в библиотеку'
            : 'Скрыть из библиотеки',
        icon: Icons.visibility_off_outlined,
        disabledReason: _mutationReason(c),
        onSelected: c.canMutate
            ? () => run(() => c.hide(!d.playlist.isHidden))
            : null,
      ),
      if (d.playlist.isOwner)
        MusicAction(
          id: 'delete',
          label: 'Удалить плейлист',
          icon: Icons.delete_outline,
          destructive: true,
          disabledReason: _mutationReason(c),
          onSelected: c.canMutate ? () => run(() => _confirmDelete(c)) : null,
        ),
    ], title: 'Действия с плейлистом');
  }

  Future<void> _confirmDelete(PlaylistController c) async {
    final targetId = c.state.detail?.playlist.id;
    final confirm = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Удалить плейлист?'),
        content: const Text(
          'Плейлист будет удалён с сервера. Музыкальные файлы на устройстве сохранятся.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Отмена'),
          ),
          TextButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Удалить'),
          ),
        ],
      ),
    );
    if (confirm == true &&
        mounted &&
        c == widget.controller &&
        c.isCurrent &&
        c.state.detail?.playlist.id == targetId) {
      await c.delete();
    }
  }

  Future<void> _reorder(PlaylistController c, PlaylistDetail d) async {
    final rows = List<PlaylistItem>.of(d.items);
    final ids = await showModalBottomSheet<List<String>>(
      context: context,
      useRootNavigator: true,
      useSafeArea: true,
      isScrollControlled: true,
      builder: (context) => StatefulBuilder(
        builder: (context, setSheetState) => SafeArea(
          top: false,
          child: SizedBox(
            height: MediaQuery.sizeOf(context).height * .85,
            child: Column(
              children: [
                Padding(
                  padding: const EdgeInsets.all(16),
                  child: Row(
                    children: [
                      const Expanded(child: Text('Порядок записей')),
                      MusicIconButton(
                        label: 'Отмена',
                        icon: Icons.close,
                        onPressed: () => Navigator.of(context).pop(),
                      ),
                    ],
                  ),
                ),
                Expanded(
                  child: ReorderableListView.builder(
                    itemCount: rows.length,
                    onReorderItem: (from, to) => setSheetState(() {
                      rows.insert(to, rows.removeAt(from));
                    }),
                    itemBuilder: (context, index) => ListTile(
                      key: ValueKey(rows[index].id),
                      title: Text(
                        rows[index].track.title,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                      subtitle: Text(
                        rows[index].track.artist,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                      trailing: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          MusicIconButton(
                            key: ValueKey('playlist-move-up-${rows[index].id}'),
                            label:
                                'Переместить вверх: ${rows[index].track.title}',
                            icon: Icons.arrow_upward,
                            onPressed: index == 0
                                ? null
                                : () => setSheetState(() {
                                    rows.insert(
                                      index - 1,
                                      rows.removeAt(index),
                                    );
                                  }),
                          ),
                          MusicIconButton(
                            key: ValueKey(
                              'playlist-move-down-${rows[index].id}',
                            ),
                            label:
                                'Переместить вниз: ${rows[index].track.title}',
                            icon: Icons.arrow_downward,
                            onPressed: index == rows.length - 1
                                ? null
                                : () => setSheetState(() {
                                    rows.insert(
                                      index + 1,
                                      rows.removeAt(index),
                                    );
                                  }),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.all(16),
                  child: MusicButton(
                    label: 'Сохранить порядок',
                    onPressed: () =>
                        Navigator.of(context)
                            .pop(rows.map((e) => e.id).toList()),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
    if (ids != null &&
        mounted &&
        c == widget.controller &&
        c.isCurrent &&
        c.state.detail?.playlist.id == d.playlist.id) {
      await c.reorder(ids);
    }
  }

  Widget _row(PlaylistController c, PlaylistItem item) => Padding(
    key: ValueKey('playlist-row-${item.id}'),
    padding: const EdgeInsets.symmetric(vertical: 4),
    child: Row(
      children: [
        Expanded(
          child: MusicTapTarget(
            onTap: item.track.playable
                ? () => _play(c, selected: item.id)
                : null,
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 12),
              child: Row(
                children: [
                  Artwork(uri: item.track.artwork, size: 48),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          item.track.title.isEmpty
                              ? 'Недоступная запись'
                              : item.track.title,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                        Text(
                          item.track.artist,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                        ),
                        if (item.reason != null)
                          Text(
                            item.reason!,
                            style: Theme.of(context).textTheme.bodySmall,
                          ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
        MusicIconButton(
          key: ValueKey('playlist-item-menu-${item.id}'),
          label: 'Действия с записью «${item.track.title}»',
          icon: Icons.more_vert,
          onPressed: () => _itemActions(item),
        ),
      ],
    ),
  );
  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.controller,
    builder: (context, _) {
      final c = widget.controller;
      final state = c.state;
      final d = state.detail;
      final playable = d?.items.any((e) => e.track.playable) ?? false;
      final title = d?.playlist.name ?? 'Плейлист';
      final largeText = MediaQuery.textScalerOf(context).scale(16) > 20.8;
      final header = Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (largeText) ...[
            Semantics(
              header: true,
              child: Text(
                title,
                style: Theme.of(context).textTheme.headlineMedium,
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
              ),
            ),
            const SizedBox(height: 20),
          ],
          if (state.stale)
            const MusicStatus(
              message: 'Аккаунт изменился. Откройте плейлист снова.',
            )
          else if (state.deleted)
            const MusicStatus(message: 'Плейлист удалён.')
          else ...[
            if (_failure != null) MusicStatus(message: _failure!, error: true),
            if (state.uncertain) ...[
              MusicStatus(
                message:
                    '${state.pendingIntent ?? 'Изменение'}: результат неизвестен. Повторная отправка заблокирована.',
                error: true,
              ),
              MusicButton(
                label: 'Проверить состояние плейлиста',
                onPressed: c.reconcile,
              ),
              if (state.reconciled)
                MusicButton(
                  label: 'Я проверил результат',
                  onPressed: c.acknowledgeReconciliation,
                ),
            ],
            if (state.failure != null && !state.uncertain)
              MusicErrorState(
                title: 'Не удалось загрузить плейлист',
                message: state.failure!.message,
                onRetry: c.refresh,
              ),
            if (state.loading)
              const MusicLoadingState(label: 'Загружаем плейлист'),
            if (d != null) ...[
              Text(
                '${musicQuantity(d.total, one: 'трек', few: 'трека', many: 'треков')}${d.items.length < d.total ? ' · Показано ${d.items.length}' : ''}${d.playlist.isPublic ? ' · Публичный' : ''}${d.playlist.isHidden ? ' · Скрыт' : ''}',
                style: Theme.of(context).textTheme.bodyMedium
                    ?.copyWith(color: MusicColors.textSecondary),
              ),
              const SizedBox(height: 20),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: MusicButton(
                      label: d.complete ? 'Слушать' : 'Слушать показанное',
                      icon: Icons.play_arrow,
                      busy: _playing,
                      onPressed: playable ? () => _play(c) : null,
                      disabledReason: playable
                          ? null
                          : 'В плейлисте пока нет доступных записей.',
                    ),
                  ),
                  if (playable) ...[
                    const SizedBox(width: 8),
                    MusicIconButton(
                      label: 'Перемешать показанные треки',
                      icon: Icons.shuffle,
                      onPressed: _playing
                          ? null
                          : () => _play(c, shuffle: true),
                    ),
                  ],
                ],
              ),
              const SizedBox(height: 20),
              if (d.items.isEmpty && !state.loading)
                const MusicEmptyState(
                  title: 'Плейлист пуст',
                  message: 'Добавьте записи через действия с плейлистом.',
                  icon: Icons.queue_music,
                ),
            ],
          ],
        ],
      );
      return Scaffold(
        appBar: AppBar(
          title: largeText
              ? null
              : Semantics(
                  header: true,
                  child: Text(
                    title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
          actions: d == null || state.stale
              ? null
              : [
                  MusicIconButton(
                    label: 'Действия с плейлистом',
                    icon: Icons.more_horiz,
                    onPressed: _actions,
                  ),
                ],
        ),
        body: SafeArea(
          top: false,
          bottom: false,
          child: LayoutBuilder(
            builder: (context, constraints) => Align(
              alignment: Alignment.topCenter,
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 960),
                child: CustomScrollView(
                  key: PageStorageKey(
                    'playlist:${d?.playlist.id ?? widget.playlistId}',
                  ),
                  slivers: [
                    SliverPadding(
                      padding: EdgeInsets.fromLTRB(
                        MusicSpace.gutter(constraints.maxWidth),
                        16,
                        MusicSpace.gutter(constraints.maxWidth),
                        16,
                      ),
                      sliver: SliverMainAxisGroup(
                        slivers: [
                          SliverToBoxAdapter(child: header),
                          if (d != null && !state.stale && !state.deleted) ...[
                            SliverList.builder(
                              itemCount: d.items.length,
                              itemBuilder: (context, index) =>
                                  _row(c, d.items[index]),
                            ),
                            if (d.hasMore)
                              SliverToBoxAdapter(
                                child: Padding(
                                  padding: const EdgeInsets.only(top: 20),
                                  child: MusicButton(
                                    label: 'Загрузить ещё',
                                    busy: state.loadingMore,
                                    onPressed: c.loadMore,
                                  ),
                                ),
                              ),
                          ],
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      );
    },
  );
}
