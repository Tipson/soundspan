import 'package:flutter/material.dart';

import '../core/model/track.dart';
import '../core/model/track_ref.dart';
import 'artwork.dart';
import 'music_controls.dart';
import 'tokens.dart';

enum TrackPlaybackState { idle, playing, paused, resolving }

/// Exact recording metadata; all effects are injected by the owning feature.
class TrackRow extends StatelessWidget {
  const TrackRow({
    super.key,
    required this.track,
    this.onPlay,
    this.onMore,
    this.playbackState = TrackPlaybackState.idle,
    this.downloaded = false,
    this.subtitle,
  });
  final Track track;
  final VoidCallback? onPlay;
  final VoidCallback? onMore;
  final TrackPlaybackState playbackState;
  final bool downloaded;
  final String? subtitle;
  @override
  Widget build(BuildContext context) {
    final ref = track.ref;
    final reason = track.playable
        ? null
        : track.unavailableReason ??
              (ref is UnavailableTrackRef ? ref.reason : 'Запись недоступна');
    final state = switch (playbackState) {
      TrackPlaybackState.idle => '',
      TrackPlaybackState.playing => 'Воспроизводится',
      TrackPlaybackState.paused => 'На паузе',
      TrackPlaybackState.resolving => 'Подготавливаем воспроизведение',
    };
    final active = playbackState != TrackPlaybackState.idle;
    return ConstrainedBox(
      constraints: BoxConstraints(
        minHeight: MediaQuery.textScalerOf(context).scale(16) >= 24 ? 96 : 72,
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Expanded(
            child: Semantics(
              label: 'Воспроизвести ${track.title}, ${track.artist}',
              value: [
                state,
                if (downloaded) 'На устройстве',
                ?reason,
              ].where((s) => s.isNotEmpty).join('. '),
              enabled: track.playable && onPlay != null,
              button: true,
              excludeSemantics: true,
              onTap: track.playable ? onPlay : null,
              child: MusicTapTarget(
                key: ValueKey('track-play-${ref.identityKey}'),
                onTap: track.playable ? onPlay : null,
                borderRadius: BorderRadius.circular(12),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    vertical: 12,
                    horizontal: 4,
                  ),
                  child: Row(
                    children: [
                      Artwork(
                        uri: track.artwork,
                        trackRef: track.ref,
                        size: 48,
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(
                              track.title,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: Theme.of(context).textTheme.titleMedium
                                  ?.copyWith(
                                    color: active
                                        ? MusicColors.primary
                                        : MusicColors.text,
                                  ),
                            ),
                            const SizedBox(height: 2),
                            Text(
                              subtitle ?? track.artist,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: Theme.of(context).textTheme.bodyMedium
                                  ?.copyWith(color: MusicColors.textSecondary),
                            ),
                            if (reason != null) ...[
                              const SizedBox(height: 4),
                              Text(
                                reason,
                                style: Theme.of(context).textTheme.bodyMedium
                                    ?.copyWith(color: MusicColors.warning),
                              ),
                            ],
                            if (active || downloaded) ...[
                              const SizedBox(height: 4),
                              Wrap(
                                spacing: 8,
                                runSpacing: 4,
                                crossAxisAlignment: WrapCrossAlignment.center,
                                children: [
                                  if (playbackState ==
                                      TrackPlaybackState.playing)
                                    const Icon(
                                      Icons.graphic_eq_rounded,
                                      size: 20,
                                      color: MusicColors.primary,
                                    ),
                                  if (active)
                                    Text(
                                      state,
                                      style: Theme.of(context)
                                          .textTheme
                                          .labelSmall
                                          ?.copyWith(
                                            color: MusicColors.primary,
                                          ),
                                    ),
                                  if (downloaded)
                                    const Icon(
                                      Icons.offline_pin_outlined,
                                      size: 20,
                                      color: MusicColors.success,
                                    ),
                                ],
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
          if (onMore != null) ...[
            const SizedBox(width: 8),
            MusicIconButton(
              label: 'Действия с треком «${track.title}»',
              icon: Icons.more_vert,
              onPressed: onMore,
            ),
          ],
        ],
      ),
    );
  }
}
