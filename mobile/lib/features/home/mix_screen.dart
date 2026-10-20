import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/model/app_failure.dart';
import '../../core/model/track.dart';
import '../../design_system/design_system.dart';
import '../../playback/playback_controller.dart';
import '../library/library_models.dart';
import 'home_controller.dart';
import 'home_models.dart';

/// Lazy ordered mix detail. Opening never submits a playback command.
class MixScreen extends StatefulWidget {
  const MixScreen({
    super.key,
    required this.controller,
    required this.mix,
    required this.onPlay,
    this.playback,
    this.onSaveMix,
    this.onReconcileSave,
    this.onOpenPlaylists,
    this.onTrackActions,
  });
  final HomeController controller;
  final PlaybackController? playback;
  final MusicMix mix;
  final FutureOr<void> Function(CollectionPlaybackRequest request) onPlay;
  final SaveMusicMix? onSaveMix;
  final ReconcileMusicMix? onReconcileSave;
  final FutureOr<void> Function()? onOpenPlaylists;
  final FutureOr<void> Function(MusicMix mix, int index)? onTrackActions;
  @override
  State<MixScreen> createState() => _MixScreenState();
}

class _MixScreenState extends State<MixScreen> {
  AppFailure? _failure;
  @override
  void initState() {
    super.initState();
    unawaited(widget.controller.openMix(widget.mix));
  }

  @override
  void didUpdateWidget(MixScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller ||
        !identical(oldWidget.mix, widget.mix)) {
      _failure = null;
      unawaited(widget.controller.openMix(widget.mix));
    }
  }

  Future<void> _run(
    FutureOr<void> Function() action,
    HomeController owner,
    int revision,
  ) async {
    if (!mounted ||
        owner != widget.controller ||
        !owner.isCurrent ||
        revision != owner.selectionRevision) {
      return;
    }
    setState(() => _failure = null);
    try {
      await action();
    } catch (error) {
      if (mounted &&
          owner == widget.controller &&
          owner.isCurrent &&
          revision == owner.selectionRevision) {
        setState(() => _failure = homeFailure(error));
      }
    }
  }

  Future<void> _actions(MusicMix mix) {
    final owner = widget.controller, revision = owner.selectionRevision;
    return MusicActionSheet.show(context, [
      if (mix.kind == MusicMixKind.legacy || widget.onSaveMix != null)
        MusicAction(
          id: 'save',
          label: 'Сохранить в плейлист',
          icon: Icons.playlist_add,
          disabledReason: !owner.online
              ? 'Для сохранения нужна сеть.'
              : owner.state.saveStatus != MixSaveStatus.idle
              ? 'Сначала проверьте результат предыдущего сохранения.'
              : null,
          onSelected:
              !owner.online || owner.state.saveStatus != MixSaveStatus.idle
              ? null
              : () => _run(
                  () => owner.saveSelected(save: widget.onSaveMix),
                  owner,
                  revision,
                ),
        ),
      if (widget.onOpenPlaylists != null)
        MusicAction(
          id: 'playlists',
          label: 'Открыть мои плейлисты',
          icon: Icons.queue_music,
          onSelected: () => _run(widget.onOpenPlaylists!, owner, revision),
        ),
    ], title: 'Действия с подборкой');
  }

  TrackPlaybackState _playbackState(Track track) {
    final snapshot = widget.playback?.snapshot;
    if (!widget.controller.isCurrent ||
        snapshot?.fence != widget.controller.fence ||
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
  Widget build(BuildContext context) => StreamBuilder<QueueSnapshot>(
    stream: widget.playback?.snapshots,
    builder: (context, _) => _content(context),
  );

  Widget _content(BuildContext context) => AnimatedBuilder(
    animation: widget.controller,
    builder: (context, _) {
      final owner = widget.controller, state = owner.state;
      final mix = state.selectedMix;
      if (state.stale || mix == null || mix.identity != widget.mix.identity) {
        return const ScreenScaffold(
          title: 'Подборка',
          child: MusicStatus(
            message: 'Подборка изменилась. Откройте её снова.',
          ),
        );
      }
      final availabilityKnown = mix.loaded && !state.mixLoading;
      final firstPlayable = mix.tracks.indexWhere((t) => t.playable),
          revision = owner.selectionRevision;
      void play(int index, {bool shuffle = false}) => unawaited(
        _run(
          () => widget.onPlay(
            owner.playbackRequest(mix, index, shuffle: shuffle),
          ),
          owner,
          revision,
        ),
      );
      final showActions =
          mix.kind == MusicMixKind.legacy ||
          widget.onSaveMix != null ||
          widget.onOpenPlaylists != null;
      final listen = MusicButton(
        label: 'Слушать',
        icon: Icons.play_arrow_rounded,
        busy: state.mixLoading,
        onPressed: firstPlayable < 0 ? null : () => play(firstPlayable),
        disabledReason: firstPlayable < 0 && availabilityKnown
            ? 'В подборке пока нет доступных записей.'
            : null,
      );
      final shuffle = MusicIconButton(
        label: 'Перемешать подборку',
        icon: Icons.shuffle_rounded,
        onPressed: firstPlayable < 0 || state.mixLoading
            ? null
            : () => play(firstPlayable, shuffle: true),
      );
      return Scaffold(
        appBar: AppBar(
          title: const Text('Подборка'),
          actions: [
            if (showActions)
              MusicIconButton(
                label: 'Действия с подборкой',
                icon: Icons.more_horiz,
                onPressed: () => _actions(mix),
              ),
          ],
        ),
        body: SafeArea(
          top: false,
          bottom: false,
          child: CustomScrollView(
            slivers: [
              SliverPadding(
                padding: const EdgeInsets.fromLTRB(20, 16, 20, 16),
                sliver: SliverToBoxAdapter(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      _MixOverview(
                        mix: mix,
                        availabilityKnown: availabilityKnown,
                      ),
                      if (availabilityKnown && mix.unavailableCount > 0)
                        Padding(
                          padding: const EdgeInsets.only(top: 8),
                          child: Text(
                            'Недоступных записей: ${mix.unavailableCount}. Они не попадут в очередь.',
                            style: Theme.of(context).textTheme.bodySmall
                                ?.copyWith(color: MusicColors.textSecondary),
                          ),
                        ),
                      if (mix.languagePending)
                        const MusicStatus(
                          message: 'Уточняем язык песен. Попробуйте позже.',
                        ),
                      if (state.mixLoading)
                        const MusicLoadingState(label: 'Загружаем подборку'),
                      if (state.mixFailure != null)
                        MusicErrorState(
                          title: 'Подборка недоступна',
                          message: state.mixFailure!.message,
                          onRetry: () => owner.openMix(widget.mix),
                        ),
                      if (_failure != null)
                        MusicStatus(message: _failure!.message, error: true),
                      const SizedBox(height: 12),
                      if (MediaQuery.textScalerOf(context).scale(16) >= 24)
                        Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            listen,
                            const SizedBox(height: 12),
                            Align(
                              alignment: Alignment.centerLeft,
                              child: shuffle,
                            ),
                          ],
                        )
                      else
                        Row(
                          children: [
                            Expanded(child: listen),
                            const SizedBox(width: 12),
                            shuffle,
                          ],
                        ),
                      if (state.saveStatus == MixSaveStatus.saving)
                        const MusicStatus(message: 'Сохраняем подборку…'),
                      if (state.saveReceipt != null)
                        MusicStatus(
                          message: state.saveReceipt!.message,
                          icon: Icons.check_circle_outline,
                        ),
                      if (state.saveFailure != null)
                        MusicStatus(
                          message: state.saveFailure!.message,
                          error: true,
                        ),
                      if (state.saveStatus == MixSaveStatus.uncertain &&
                          widget.onReconcileSave != null)
                        MusicButton(
                          label: 'Проверить сохранение',
                          onPressed: () => _run(
                            () => owner.reconcileSelected(
                              widget.onReconcileSave!,
                            ),
                            owner,
                            revision,
                          ),
                        ),
                      if (state.saveStatus == MixSaveStatus.uncertain &&
                          widget.onOpenPlaylists != null)
                        TextButton(
                          onPressed: () =>
                              _run(widget.onOpenPlaylists!, owner, revision),
                          child: const Text('Открыть мои плейлисты'),
                        ),
                    ],
                  ),
                ),
              ),
              SliverPadding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
                sliver: SliverList.builder(
                  itemCount: mix.tracks.length,
                  itemBuilder: (_, i) => TrackRow(
                    key: ValueKey('mix-track-$i'),
                    track: mix.tracks[i],
                    playbackState: _playbackState(mix.tracks[i]),
                    onPlay: () => play(i),
                    onMore: widget.onTrackActions == null
                        ? null
                        : () => _run(
                            () => widget.onTrackActions!(mix, i),
                            owner,
                            revision,
                          ),
                  ),
                ),
              ),
            ],
          ),
        ),
      );
    },
  );
}

class _MixOverview extends StatelessWidget {
  const _MixOverview({required this.mix, required this.availabilityKnown});
  final MusicMix mix;
  final bool availabilityKnown;

  @override
  Widget build(BuildContext context) {
    final type = Theme.of(context).textTheme;
    final trackCount = musicQuantity(
      mix.trackCount,
      one: 'трек',
      few: 'трека',
      many: 'треков',
    );
    final details = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Semantics(header: true, child: Text(mix.title, style: type.titleLarge)),
        if (mix.description.isNotEmpty) ...[
          const SizedBox(height: 8),
          Text(
            mix.description,
            style: type.bodyMedium?.copyWith(color: MusicColors.textSecondary),
          ),
        ],
        const SizedBox(height: 8),
        Text(
          availabilityKnown
              ? '$trackCount · доступно: ${mix.playableCount}'
              : trackCount,
          style: type.bodySmall?.copyWith(color: MusicColors.textMuted),
        ),
      ],
    );
    final artwork = Artwork(uri: mix.cover, size: 104, radius: 16);
    if (MediaQuery.textScalerOf(context).scale(16) >= 24) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [artwork, const SizedBox(height: 16), details],
      );
    }
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        artwork,
        const SizedBox(width: 16),
        Expanded(child: details),
      ],
    );
  }
}
