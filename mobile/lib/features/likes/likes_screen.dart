import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/model/app_failure.dart';
import '../../core/model/track.dart';
import '../../design_system/design_system.dart';
import '../../playback/playback_controller.dart';
import '../library/library_models.dart';
import 'likes_controller.dart';
import 'likes_models.dart';
import 'preference_controller.dart';

typedef CollectionPlayCallback = Future<void> Function(
  CollectionPlaybackRequest request,
);
typedef CollectionTracksCallback = FutureOr<void> Function(List<Track> tracks);
typedef CollectionTrackCallback = FutureOr<void> Function(Track track);

/// Real account collection. Every optional action is a composition capability.
class LikesScreen extends StatefulWidget {
  const LikesScreen({
    super.key,
    required this.controller,
    required this.preferences,
    required this.onPlay,
    this.playback,
    this.onOpenSearch,
    this.onOpenDownloads,
    this.onAddToPlaylist,
    this.onDownload,
    this.onRadio,
    this.scrollController,
    this.autoLoad = true,
  });
  final LikesController controller;
  final PreferenceController preferences;
  final CollectionPlayCallback onPlay;
  final PlaybackController? playback;
  final FutureOr<void> Function()? onOpenSearch;
  final FutureOr<void> Function()? onOpenDownloads;
  final CollectionTracksCallback? onAddToPlaylist;
  final CollectionTracksCallback? onDownload;
  final CollectionTrackCallback? onRadio;
  final ScrollController? scrollController;
  final bool autoLoad;
  @override
  State<LikesScreen> createState() => _LikesScreenState();
}

class _LikesScreenState extends State<LikesScreen> {
  String _query = '';
  AppFailure? _actionFailure;
  bool _playing = false;
  StreamSubscription<QueueSnapshot>? _playbackSubscription;
  @override
  void initState() {
    super.initState();
    _bindPlayback();
    if (widget.autoLoad &&
        widget.controller.state.tracks.isEmpty &&
        !widget.controller.state.loading) {
      unawaited(widget.controller.refresh());
    }
  }

  void _bindPlayback() {
    _playbackSubscription = widget.playback?.snapshots.listen((_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void didUpdateWidget(LikesScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.playback != widget.playback) {
      _playbackSubscription?.cancel();
      _bindPlayback();
    }
    if (oldWidget.controller != widget.controller) {
      _query = '';
      _actionFailure = null;
      if (widget.autoLoad) unawaited(widget.controller.refresh());
    }
  }

  @override
  void dispose() {
    _playbackSubscription?.cancel();
    super.dispose();
  }

  List<Track> _visible() => widget.controller.state.tracks.where((track) {
    final signal = widget.preferences.current(track.ref).signal;
    return signal != PreferenceSignal.clear &&
        signal != PreferenceSignal.dislike &&
        '${track.title} ${track.artist}'.toLowerCase().contains(
          _query.trim().toLowerCase(),
        );
  }).toList();
  Future<void> _run(
    FutureOr<void> Function() action, {
    LikesController? owner,
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

  Future<void> _play(
    List<Track> visible, {
    Track? selected,
    bool shuffle = false,
  }) async {
    if (_playing) return;
    final playable = visible.where((t) => t.playable).toList();
    final index = selected == null
        ? 0
        : playable.indexWhere((t) => t.ref == selected.ref);
    if (playable.isEmpty || index < 0) return;
    final request = CollectionPlaybackRequest(
      tracks: playable,
      startIndex: index,
      shuffle: shuffle,
      fence: widget.controller.fence,
    );
    setState(() => _playing = true);
    await _run(() => widget.onPlay(request));
    if (mounted) setState(() => _playing = false);
  }

  Future<void> _trackActions(Track track) async {
    final capturedController = widget.controller;
    final prefs = widget.preferences;
    final unavailable = !prefs.supports(track.ref, PreferenceSignal.clear);
    await MusicActionSheet.show(context, [
      if (track.playable)
        MusicAction(
          id: 'play',
          label: 'Слушать',
          icon: Icons.play_arrow_rounded,
          onSelected: () => _run(
            () => _play(_visible(), selected: track),
            owner: capturedController,
          ),
        ),
      if (widget.onAddToPlaylist != null && track.playable)
        MusicAction(
          id: 'playlist',
          label: 'Добавить в плейлист',
          icon: Icons.playlist_add,
          onSelected: () => _run(
            () => widget.onAddToPlaylist!([track]),
            owner: capturedController,
          ),
        ),
      if (widget.onDownload != null && track.playable)
        MusicAction(
          id: 'download',
          label: 'Скачать на устройство',
          icon: Icons.download_outlined,
          onSelected: () => _run(
            () => widget.onDownload!([track]),
            owner: capturedController,
          ),
        ),
      if (widget.onRadio != null && track.playable)
        MusicAction(
          id: 'radio',
          label: 'Волна по треку',
          icon: Icons.radio_outlined,
          onSelected: () =>
              _run(() => widget.onRadio!(track), owner: capturedController),
        ),
      MusicAction(
        id: 'unlike',
        label: 'Убрать из любимого',
        icon: Icons.favorite_border,
        destructive: true,
        disabledReason: unavailable
            ? 'Изменение предпочтений для этой записи недоступно.'
            : !prefs.canMutate
            ? 'Для изменения нужна сеть и действующий аккаунт.'
            : null,
        onSelected: unavailable || !prefs.canMutate
            ? null
            : () => _run(() async {
                if (capturedController != widget.controller ||
                    !capturedController.isCurrent) {
                  return;
                }
                await prefs.set(track.ref, PreferenceSignal.clear);
              }, owner: capturedController),
      ),
    ], title: track.title);
  }

  Future<void> _collectionActions() async {
    final capturedController = widget.controller;
    final tracks = _visible().where((t) => t.playable).toList();
    await MusicActionSheet.show(context, [
      MusicAction(
        id: 'refresh',
        label: 'Обновить любимое',
        icon: Icons.refresh,
        onSelected: () =>
            _run(capturedController.refresh, owner: capturedController),
      ),
      if (widget.onAddToPlaylist != null && tracks.isNotEmpty)
        MusicAction(
          id: 'playlist',
          label: 'Добавить показанные треки в плейлист',
          icon: Icons.playlist_add,
          onSelected: () => _run(
            () => widget.onAddToPlaylist!(tracks),
            owner: capturedController,
          ),
        ),
      if (widget.onDownload != null && tracks.isNotEmpty)
        MusicAction(
          id: 'download',
          label: 'Скачать показанные треки',
          icon: Icons.download_outlined,
          onSelected: () =>
              _run(() => widget.onDownload!(tracks), owner: capturedController),
        ),
      if (widget.onOpenDownloads != null)
        MusicAction(
          id: 'downloads',
          label: 'Открыть загрузки',
          icon: Icons.offline_pin_outlined,
          onSelected: () =>
              _run(() => widget.onOpenDownloads!(), owner: capturedController),
        ),
    ], title: 'Действия с любимым');
  }

  TrackPlaybackState _playbackState(Track track) {
    final snapshot = widget.playback?.snapshot;
    if (snapshot?.fence != widget.controller.fence ||
        snapshot?.currentEntry?.track.ref != track.ref) {
      return TrackPlaybackState.idle;
    }
    if (snapshot!.processing == PlaybackProcessing.loading ||
        snapshot.processing == PlaybackProcessing.buffering) {
      return TrackPlaybackState.resolving;
    }
    return snapshot.playing
        ? TrackPlaybackState.playing
        : TrackPlaybackState.paused;
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: Listenable.merge([widget.controller, widget.preferences]),
    builder: (context, _) {
      final state = widget.controller.state;
      final visible = _visible();
      final playable = visible.any((t) => t.playable);
      final removed = state.tracks.where((track) {
        final signal = widget.preferences.current(track.ref).signal;
        return signal == PreferenceSignal.clear ||
            signal == PreferenceSignal.dislike;
      }).length;
      final effectivelyEmpty =
          state.tracks.isEmpty ||
          (removed == state.tracks.length && !state.hasMore);
      return ScreenScaffold(
        title: 'Любимое',
        scrollController: widget.scrollController,
        actions: state.stale
            ? null
            : [
                MusicIconButton(
                  label: 'Действия с любимым',
                  icon: Icons.more_horiz,
                  onPressed: _collectionActions,
                ),
              ],
        child: state.stale
            ? const MusicStatus(
                message: 'Аккаунт изменился. Откройте раздел снова.',
              )
            : Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (_actionFailure != null)
                    MusicStatus(message: _actionFailure!.message, error: true),
                  if (state.failure != null)
                    MusicErrorState(
                      title: 'Не удалось обновить любимое',
                      message: state.failure!.message,
                      onRetry: widget.controller.retry,
                    ),
                  if (state.loading && effectivelyEmpty)
                    const MusicLoadingState(label: 'Загружаем любимое')
                  else if (effectivelyEmpty && state.failure == null)
                    MusicEmptyState(
                      title: 'Здесь будет ваша музыка',
                      message: 'Отмечайте понравившиеся треки сердцем — они появятся в любимом.',
                      icon: Icons.favorite_border,
                      actionLabel: widget.onOpenSearch == null
                          ? null
                          : 'Найти музыку',
                      onAction: widget.onOpenSearch == null
                          ? null
                          : () => _run(widget.onOpenSearch!),
                    )
                  else if (state.tracks.isNotEmpty) ...[
                    Text(
                      '${musicQuantity((state.total - removed).clamp(0, state.total).toInt(), one: 'трек', few: 'трека', many: 'треков')} в любимом',
                      style: Theme.of(context).textTheme.bodyMedium
                          ?.copyWith(color: MusicColors.textSecondary),
                    ),
                    const SizedBox(height: 20),
                    TextField(
                      key: const ValueKey('likes-filter'),
                      decoration: const InputDecoration(
                        labelText: 'Найти в любимом',
                        prefixIcon: Icon(Icons.search),
                      ),
                      onChanged: (value) => setState(() => _query = value),
                    ),
                    const SizedBox(height: 20),
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(
                          child: MusicButton(
                            label: 'Слушать',
                            icon: Icons.play_arrow_rounded,
                            busy: _playing,
                            onPressed: playable ? () => _play(visible) : null,
                            disabledReason: playable ? null : 'Среди показанных треков нет доступных записей.',
                          ),
                        ),
                        if (playable) ...[
                          const SizedBox(width: 8),
                          MusicIconButton(
                            label: 'Перемешать',
                            icon: Icons.shuffle,
                            onPressed: _playing
                                ? null
                                : () => _play(visible, shuffle: true),
                          ),
                        ],
                      ],
                    ),
                    const SizedBox(height: 20),
                    if (state.loading) const LinearProgressIndicator(),
                    if (visible.isEmpty)
                      const MusicStatus(
                        message: 'По вашему запросу ничего не найдено.',
                      ),
                    for (final track in visible)
                      TrackRow(
                        track: track,
                        onPlay: () => _play(visible, selected: track),
                        onMore: () => _trackActions(track),
                        playbackState: _playbackState(track),
                      ),
                    if (state.hasMore) ...[
                      const SizedBox(height: 20),
                      MusicButton(
                        label: 'Загрузить ещё',
                        busy: state.loadingMore,
                        onPressed: widget.controller.loadMore,
                      ),
                    ],
                  ],
                  if (widget.onOpenDownloads != null &&
                      state.failure != null) ...[
                    const SizedBox(height: 12),
                    MusicButton(
                      label: 'Открыть загрузки',
                      tonal: true,
                      onPressed: () => _run(widget.onOpenDownloads!),
                    ),
                  ],
                ],
              ),
      );
    },
  );
}
