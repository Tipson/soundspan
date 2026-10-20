import 'package:flutter/material.dart';

import '../../design_system/artwork.dart';
import '../../design_system/music_controls.dart';
import '../../design_system/tokens.dart';
import '../../playback/queue_snapshot.dart';
import '../likes/likes_models.dart';
import 'player_controller.dart';

class MiniPlayer extends StatelessWidget {
  const MiniPlayer({super.key, required this.controller, required this.onOpen});
  final PlayerController controller;
  final VoidCallback onOpen;
  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: controller,
    builder: (context, _) {
      final state = controller.snapshot;
      final track = state.currentEntry?.track;
      if (track == null) return const SizedBox.shrink();
      final failed = state.processing == PlaybackProcessing.failed;
      final loading =
          state.processing == PlaybackProcessing.loading ||
          state.processing == PlaybackProcessing.buffering;
      final large = MediaQuery.textScalerOf(context).scale(16) > 24;
      return Material(
        color: MusicColors.surface2,
        borderRadius: BorderRadius.circular(16),
        clipBehavior: Clip.antiAlias,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
              child: Row(
                children: [
                  Expanded(
                    child: MusicTapTarget(
                      key: const ValueKey('mini-open'),
                      onTap: onOpen,
                      child: Row(
                        children: [
                          Artwork(
                            uri: track.artwork,
                            trackRef: track.ref,
                            size: 48,
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Padding(
                              padding: const EdgeInsets.symmetric(vertical: 6),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  Text(
                                    track.title,
                                    maxLines: large ? 2 : 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: Theme.of(context)
                                        .textTheme
                                        .bodyMedium
                                        ?.copyWith(fontWeight: FontWeight.w600),
                                  ),
                                  Text(
                                    track.artist,
                                    maxLines: large ? 2 : 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: Theme.of(context).textTheme.bodySmall
                                        ?.copyWith(
                                          color: MusicColors.textSecondary,
                                        ),
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  MusicIconButton(
                    label: 'Нравится',
                    icon: controller.preference.signal == PreferenceSignal.like
                        ? Icons.favorite
                        : Icons.favorite_border,
                    selected:
                        controller.preference.signal == PreferenceSignal.like,
                    onPressed: controller.canPrefer && !controller.busy
                        ? () => controller.feedback(PreferenceSignal.like)
                        : null,
                    disabledReason: controller.canPrefer ? null : 'Нужна сеть',
                  ),
                  const SizedBox(width: 8),
                  SizedBox(
                    width: 48,
                    height: 48,
                    child: Stack(
                      alignment: Alignment.center,
                      children: [
                        IconButton.filled(
                          tooltip: failed
                              ? 'Повторить'
                              : state.playing
                              ? 'Пауза'
                              : 'Продолжить',
                          style: IconButton.styleFrom(
                            backgroundColor: MusicColors.text,
                            foregroundColor: MusicColors.canvas,
                            shape: const CircleBorder(),
                            minimumSize: const Size.square(48),
                            padding: EdgeInsets.zero,
                          ),
                          icon: Icon(
                            failed
                                ? Icons.refresh
                                : state.playing
                                ? Icons.pause
                                : Icons.play_arrow,
                          ),
                          onPressed: controller.busy
                              ? null
                              : failed
                              ? controller.retry
                              : controller.togglePlayback,
                        ),
                        if (loading)
                          const Positioned(
                            bottom: 0,
                            child: SizedBox(
                              width: 24,
                              child: LinearProgressIndicator(minHeight: 2),
                            ),
                          ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            ExcludeSemantics(
              child: LinearProgressIndicator(
                minHeight: 2,
                value:
                    state.duration == null ||
                        state.duration!.inMilliseconds <= 0
                    ? 0
                    : (state.position.inMilliseconds /
                              state.duration!.inMilliseconds)
                          .clamp(0, 1),
              ),
            ),
          ],
        ),
      );
    },
  );
}
