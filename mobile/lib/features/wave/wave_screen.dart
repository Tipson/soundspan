import 'dart:async';

import 'package:flutter/material.dart';

import '../../design_system/design_system.dart';
import '../../playback/playback_controller.dart';
import '../../playback/wave_continuation.dart';
import 'wave_controller.dart';
import 'wave_direction_sheet.dart';

/// Service-backed Wave destination. Mounting and navigation never start audio.
class WaveScreen extends StatefulWidget {
  const WaveScreen({
    super.key,
    required this.controller,
    this.onOpenDownloads,
    this.onOpenPlayer,
    this.scrollController,
  });
  final WaveController controller;
  final FutureOr<void> Function()? onOpenDownloads, onOpenPlayer;
  final ScrollController? scrollController;
  @override
  State<WaveScreen> createState() => _WaveScreenState();
}

class _WaveScreenState extends State<WaveScreen> {
  Future<void> _configure() async {
    final owner = widget.controller, initial = widget.controller.selection;
    final revision = owner.selectionRevision;
    final selection = await WaveDirectionSheet.show(context, initial);
    if (!mounted ||
        owner != widget.controller ||
        !owner.isCurrent ||
        revision != owner.selectionRevision ||
        selection == null ||
        owner.selection != initial) {
      return;
    }
    await owner.apply(selection);
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.controller,
    builder: (context, _) {
      final owner = widget.controller,
          state = owner.state,
          queue = owner.snapshot;
      final current = owner.ownsCurrentWave ? queue.currentEntry : null,
          upcoming = owner.upcoming;
      final busy = state.status == WaveStatus.loading;
      final ended =
          state.status == WaveStatus.exhausted &&
          upcoming.isEmpty &&
          (current == null || queue.processing == PlaybackProcessing.completed);
      final selection = owner.selection;
      return Scaffold(
        appBar: AppBar(
          title: const Text('Волна'),
          actions: [
            if (owner.isCurrent)
              MusicIconButton(
                label: 'Настроить волну',
                icon: Icons.tune_rounded,
                onPressed: _configure,
              ),
          ],
        ),
        body: SafeArea(
          top: false,
          bottom: false,
          child: !owner.isCurrent
              ? const MusicEmptyState(
                  title: 'Аккаунт изменился',
                  message: 'Откройте волну снова.',
                )
              : LayoutBuilder(
                  builder: (context, viewport) {
                    final compact = viewport.maxWidth < 600;
                    return CustomScrollView(
                      controller: widget.scrollController,
                      slivers: [
                        SliverPadding(
                          padding: const EdgeInsets.fromLTRB(20, 16, 20, 20),
                          sliver: SliverToBoxAdapter(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              children: [
                                Row(
                                  children: [
                                    Expanded(
                                      child: Semantics(
                                        header: true,
                                        child: Text(
                                          current == null
                                              ? 'В вашем ритме'
                                              : 'Моя волна',
                                          style: Theme.of(context)
                                              .textTheme
                                              .headlineMedium,
                                        ),
                                      ),
                                    ),
                                    const SizedBox(width: 20),
                                    if (current != null)
                                      Artwork(
                                        uri: current.track.artwork,
                                        trackRef: current.track.ref,
                                        size: compact ? 96 : 128,
                                        radius: 16,
                                      )
                                    else
                                      SizedBox(
                                        width: compact ? 104 : 160,
                                        height: compact ? 104 : 128,
                                        child: WaveArtwork(
                                          active:
                                              queue.playing &&
                                              owner.ownsCurrentWave,
                                        ),
                                      ),
                                  ],
                                ),
                                const SizedBox(height: 20),
                                MusicButton(
                                  label: current != null && !ended
                                      ? (queue.playing ? 'Пауза' : 'Продолжить')
                                      : 'Начать волну',
                                  icon:
                                      current != null && queue.playing && !ended
                                      ? Icons.pause_rounded
                                      : Icons.play_arrow_rounded,
                                  busy: busy,
                                  onPressed: !owner.online && current == null
                                      ? null
                                      : current != null && !ended
                                      ? owner.togglePlayback
                                      : owner.start,
                                  disabledReason:
                                      !owner.online && current == null
                                      ? 'Новые рекомендации доступны при подключении к сети.'
                                      : null,
                                ),
                                const SizedBox(height: 16),
                                if (current == null) ...[
                                  Text(
                                    'Знакомые песни и новые открытия — в вашем ритме.',
                                    style: Theme.of(context)
                                        .textTheme
                                        .bodyMedium
                                        ?.copyWith(
                                          color: MusicColors.textSecondary,
                                        ),
                                  ),
                                  const SizedBox(height: 16),
                                ],
                                if (current != null) ...[
                                  Semantics(
                                    header: true,
                                    child: Text(
                                      current.track.title,
                                      style: Theme.of(context)
                                          .textTheme
                                          .titleLarge,
                                    ),
                                  ),
                                  const SizedBox(height: 4),
                                  Text(
                                    current.track.artist,
                                    style: Theme.of(context)
                                        .textTheme
                                        .bodyMedium
                                        ?.copyWith(
                                          color: MusicColors.textSecondary,
                                        ),
                                  ),
                                  const SizedBox(height: 16),
                                ],
                                Text(
                                  'Направление · ${waveModeLabel(selection.mode)}',
                                  style: Theme.of(context)
                                      .textTheme
                                      .titleMedium,
                                ),
                                const SizedBox(height: 8),
                                Text(
                                  '${waveMoodLabel(selection.mood)} · ${waveLanguageLabel(selection.language)}',
                                  style: Theme.of(context).textTheme.bodyMedium
                                      ?.copyWith(
                                        color: MusicColors.textSecondary,
                                      ),
                                ),
                                const SizedBox(height: 12),
                                if (!owner.online) ...[
                                  const MusicStatus(
                                    message: 'Для новых рекомендаций нужна сеть. Загруженная музыка доступна на устройстве.',
                                  ),
                                  if (widget.onOpenDownloads != null)
                                    MusicButton(
                                      label: 'Открыть загрузки',
                                      icon: Icons.offline_pin_outlined,
                                      onPressed: () {
                                        if (owner == widget.controller &&
                                            owner.isCurrent) {
                                          widget.onOpenDownloads!();
                                        }
                                      },
                                    ),
                                ],
                                if (owner.failure != null) ...[
                                  MusicStatus(
                                    message: owner.failure!.message,
                                    error: true,
                                  ),
                                  if (owner.online &&
                                      state.status == WaveStatus.error)
                                    MusicButton(
                                      label: 'Повторить',
                                      onPressed: owner.retry,
                                    ),
                                ],
                                if (busy)
                                  const MusicStatus(
                                    message: 'Подбираем музыку для вас…',
                                  ),
                                if (ended)
                                  const MusicStatus(
                                    message: 'Музыка закончилась. Начните новую волну.',
                                  ),
                                if (current != null &&
                                    widget.onOpenPlayer != null)
                                  TextButton(
                                    onPressed: () {
                                      if (owner == widget.controller &&
                                          owner.isCurrent) {
                                        widget.onOpenPlayer!();
                                      }
                                    },
                                    child: const Text('Открыть плеер'),
                                  ),
                                const SizedBox(height: 20),
                                Semantics(
                                  header: true,
                                  child: Text(
                                    'Дальше в волне',
                                    style: Theme.of(context)
                                        .textTheme
                                        .titleLarge,
                                  ),
                                ),
                                const SizedBox(height: 8),
                                Text(
                                  upcoming.isEmpty
                                      ? 'Новый состав появится после запуска.'
                                      : '${upcoming.where((e) => e.track.playable).length} доступных треков · продолжение подбирается автоматически',
                                  style: Theme.of(context).textTheme.bodyMedium
                                      ?.copyWith(
                                        color: MusicColors.textSecondary,
                                      ),
                                ),
                              ],
                            ),
                          ),
                        ),
                        SliverPadding(
                          padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
                          sliver: SliverList.builder(
                            itemCount: upcoming.length,
                            itemBuilder: (_, i) => TrackRow(
                              key: ValueKey(
                                'wave-upcoming-${upcoming[i].entryId}',
                              ),
                              track: upcoming[i].track,
                              onPlay: () =>
                                  owner.playUpcoming(upcoming[i].entryId),
                            ),
                          ),
                        ),
                      ],
                    );
                  },
                ),
        ),
      );
    },
  );
}
