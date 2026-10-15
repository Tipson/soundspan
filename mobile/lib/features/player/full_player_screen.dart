import 'package:flutter/material.dart';

import '../../core/model/track_ref.dart';
import '../../design_system/artwork.dart';
import '../../design_system/music_action_sheet.dart';
import '../../design_system/music_controls.dart';
import '../../design_system/tokens.dart';
import '../../playback/queue_snapshot.dart';
import '../likes/likes_models.dart';
import 'player_controller.dart';

class FullPlayerScreen extends StatelessWidget {
  const FullPlayerScreen({
    super.key,
    required this.controller,
    this.onCollapse,
    this.onOpenQueue,
  });
  final PlayerController controller;
  final VoidCallback? onCollapse, onOpenQueue;
  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: controller,
    builder: (context, _) {
      final state = controller.snapshot;
      final track = state.currentEntry?.track;
      return Scaffold(
        body: SafeArea(
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12),
                child: Row(
                  children: [
                    MusicIconButton(
                      label: 'Свернуть плеер',
                      icon: Icons.keyboard_arrow_down,
                      onPressed:
                          onCollapse ?? () => Navigator.of(context).maybePop(),
                    ),
                    const Expanded(
                      child: Text('Сейчас играет', textAlign: TextAlign.center),
                    ),
                    if (track != null)
                      MusicIconButton(
                        label: 'Действия трека',
                        icon: Icons.more_horiz,
                        onPressed: () => _actions(context),
                      ),
                  ],
                ),
              ),
              Expanded(
                child: track == null
                    ? const Center(child: Text('Очередь пуста'))
                    : SingleChildScrollView(
                        key: const PageStorageKey('full-player-scroll'),
                        padding: const EdgeInsets.fromLTRB(20, 16, 20, 32),
                        child: LayoutBuilder(
                          builder: (context, box) {
                            final large =
                                MediaQuery.textScalerOf(context).scale(16) > 24;
                            final landscape = box.maxWidth >= 580 && !large;
                            final art = Center(
                              child: ConstrainedBox(
                                constraints: const BoxConstraints(
                                  maxWidth: 350,
                                ),
                                child: Artwork(
                                  key: const ValueKey('player-art'),
                                  uri: track.artwork,
                                  trackRef: track.ref,
                                  radius: 16,
                                ),
                              ),
                            );
                            final details = Column(
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              children: [
                                Text(
                                  track.title,
                                  style: Theme.of(context)
                                      .textTheme
                                      .headlineSmall,
                                ),
                                if (controller.callbacks.onArtist != null &&
                                    track.artistId != null)
                                  TextButton(
                                    onPressed: controller.busy
                                        ? null
                                        : () => controller.invoke(
                                            controller.callbacks.onArtist!,
                                          ),
                                    child: Align(
                                      alignment: Alignment.centerLeft,
                                      child: Text(track.artist),
                                    ),
                                  )
                                else
                                  Padding(
                                    padding: const EdgeInsets.symmetric(
                                      vertical: 12,
                                    ),
                                    child: Text(
                                      track.artist,
                                      style: Theme.of(context)
                                          .textTheme
                                          .bodyLarge
                                          ?.copyWith(
                                            color: MusicColors.textSecondary,
                                          ),
                                    ),
                                  ),
                                PlayerSeekBar(controller: controller),
                                const SizedBox(height: 8),
                                _transport(context, box.maxWidth, state),
                                if (state.processing ==
                                        PlaybackProcessing.loading ||
                                    state.processing ==
                                        PlaybackProcessing.buffering)
                                  const Padding(
                                    padding: EdgeInsets.only(top: 8),
                                    child: Text('Загружаем музыку…'),
                                  ),
                                if (state.failure != null ||
                                    controller.failure != null ||
                                    controller.preference.failure != null)
                                  Semantics(
                                    liveRegion: true,
                                    child: Padding(
                                      padding: const EdgeInsets.symmetric(
                                        vertical: 12,
                                      ),
                                      child: Text(
                                        (controller.failure ??
                                                state.failure ??
                                                controller.preference.failure)!
                                            .message,
                                      ),
                                    ),
                                  ),
                                if (state.processing ==
                                    PlaybackProcessing.failed)
                                  MusicButton(
                                    label: 'Повторить',
                                    icon: Icons.refresh,
                                    busy: controller.busy,
                                    onPressed: controller.retry,
                                  ),
                                const SizedBox(height: 16),
                                _feedback(context, large),
                                const SizedBox(height: 24),
                                _sections(context, large),
                              ],
                            );
                            return landscape
                                ? Row(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      Expanded(child: art),
                                      const SizedBox(width: 24),
                                      Expanded(child: details),
                                    ],
                                  )
                                : Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.stretch,
                                    children: [
                                      art,
                                      const SizedBox(height: 24),
                                      details,
                                    ],
                                  );
                          },
                        ),
                      ),
              ),
            ],
          ),
        ),
      );
    },
  );
  Widget _transport(BuildContext context, double width, QueueSnapshot state) {
    Widget icon(
      String label,
      IconData icon,
      VoidCallback callback, {
      bool selected = false,
    }) => MusicIconButton(
      label: label,
      icon: icon,
      selected: selected,
      onPressed: controller.busy ? null : callback,
    );
    final central = Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        icon('Предыдущий трек', Icons.skip_previous, controller.previous),
        const SizedBox(width: 8),
        SizedBox(
          width: 72,
          height: 72,
          child: FilledButton(
            style: FilledButton.styleFrom(
              shape: const CircleBorder(),
              padding: EdgeInsets.zero,
            ),
            onPressed: controller.busy ? null : controller.togglePlayback,
            child: Semantics(
              label: state.playingIntent ? 'Пауза' : 'Продолжить',
              child: Icon(
                state.playingIntent ? Icons.pause : Icons.play_arrow,
                size: 36,
              ),
            ),
          ),
        ),
        const SizedBox(width: 8),
        icon('Следующий трек', Icons.skip_next, controller.next),
      ],
    );
    final shuffle = icon(
      'Перемешать',
      Icons.shuffle,
      controller.toggleShuffle,
      selected: state.shuffle,
    );
    final repeat = icon(
      switch (state.repeat) {
        QueueRepeat.off => 'Повтор выключен',
        QueueRepeat.all => 'Повтор очереди',
        QueueRepeat.one => 'Повтор трека',
      },
      state.repeat == QueueRepeat.one ? Icons.repeat_one : Icons.repeat,
      controller.cycleRepeat,
      selected: state.repeat != QueueRepeat.off,
    );
    if (width < 310 || width >= 580) {
      return Column(
        children: [
          central,
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [shuffle, const SizedBox(width: 16), repeat],
          ),
        ],
      );
    }
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [shuffle, central, repeat],
    );
  }

  Widget _feedback(BuildContext context, bool large) {
    final signal = controller.preference.signal;
    Widget action(
      String label,
      IconData icon,
      VoidCallback? tap,
      bool selected,
    ) => Semantics(
      selected: selected,
      button: true,
      enabled: tap != null,
      child: MusicTapTarget(
        onTap: tap,
        child: Padding(
          padding: const EdgeInsets.all(8),
          child: large
              ? Row(
                  children: [
                    Icon(icon, color: selected ? MusicColors.primary : null),
                    const SizedBox(width: 12),
                    Expanded(child: Text(label)),
                  ],
                )
              : Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(icon, color: selected ? MusicColors.primary : null),
                    const SizedBox(height: 8),
                    Text(
                      label,
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.labelMedium,
                    ),
                  ],
                ),
        ),
      ),
    );
    final like = action(
      'Нравится',
      signal == PreferenceSignal.like ? Icons.favorite : Icons.favorite_border,
      controller.canPrefer && !controller.busy
          ? () => controller.feedback(PreferenceSignal.like)
          : null,
      signal == PreferenceSignal.like,
    );
    final radio = action(
      'В волну',
      Icons.radio,
      controller.callbacks.onRadio == null || controller.busy
          ? null
          : () => _radio(context),
      false,
    );
    final dislike = action(
      'Не нравится',
      Icons.thumb_down_outlined,
      controller.canPrefer && !controller.busy
          ? () => controller.feedback(PreferenceSignal.dislike)
          : null,
      signal == PreferenceSignal.dislike,
    );
    final actions = [
      like,
      if (controller.callbacks.onRadio != null) radio,
      dislike,
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (large)
          ...actions
        else
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [for (final item in actions) Expanded(child: item)],
          ),
        if (!controller.canPrefer)
          const Padding(
            padding: EdgeInsets.only(top: 8),
            child: Text('Для оценки трека нужна сеть.'),
          ),
      ],
    );
  }

  Widget _sections(BuildContext context, bool large) {
    final callbacks = controller.callbacks;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            if (onOpenQueue != null)
              TextButton.icon(
                onPressed: onOpenQueue,
                icon: const Icon(Icons.queue_music),
                label: const Text('Открыть очередь'),
              ),
            if (callbacks.onLyrics != null)
              TextButton(
                onPressed: controller.busy
                    ? null
                    : () => controller.invoke(callbacks.onLyrics!),
                child: const Text('Текст'),
              ),
            if (callbacks.onRelated != null)
              TextButton(
                onPressed: controller.busy
                    ? null
                    : () => controller.invoke(callbacks.onRelated!),
                child: const Text('Похожее'),
              ),
          ],
        ),
        for (final entry
            in controller.orderedEntries
                .skipWhile(
                  (e) => e.entryId != controller.snapshot.currentEntryId,
                )
                .skip(1)
                .take(3))
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Text('${entry.track.title} · ${entry.track.artist}'),
          ),
      ],
    );
  }

  Future<void> _radio(BuildContext context) async {
    final target = controller.captureTrack();
    if (target == null) return;
    final confirmed = await showDialog<bool>(
      context: context,
      useRootNavigator: true,
      builder: (context) => AlertDialog(
        title: const Text('Запустить волну по этому треку?'),
        content: const Text('Текущая очередь будет заменена.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Отмена'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Запустить'),
          ),
        ],
      ),
    );
    if (confirmed == true) {
      await controller.invoke(controller.callbacks.onRadio!, target: target);
    }
  }

  Future<void> _actions(BuildContext context) {
    final target = controller.captureTrack();
    if (target == null) return Future.value();
    final cb = controller.callbacks;
    MusicAction route(
      String id,
      String label,
      IconData icon,
      PlayerTrackAction action,
    ) => MusicAction(
      id: id,
      label: label,
      icon: icon,
      onSelected: () => controller.invoke(action, target: target),
    );
    return MusicActionSheet.show(context, [
      MusicAction(
        id: 'volume',
        label: 'Громкость',
        icon: Icons.volume_up,
        onSelected: () async {
          if (context.mounted && target.isCurrent) {
            await showModalBottomSheet<void>(
              context: context,
              useRootNavigator: true,
              isScrollControlled: true,
              useSafeArea: true,
              builder: (_) =>
                  _VolumeSheet(controller: controller, target: target),
            );
          }
        },
      ),
      if (cb.onAlbum != null && target.track.albumId != null)
        route('album', 'Открыть альбом', Icons.album, cb.onAlbum!),
      if (cb.onArtist != null && target.track.artistId != null)
        route('artist', 'Открыть исполнителя', Icons.person, cb.onArtist!),
      if (cb.onDownload != null)
        route(
          'download',
          'Скачать на устройство',
          Icons.download,
          cb.onDownload!,
        ),
      if (cb.onAddToPlaylist != null)
        route(
          'playlist',
          'Добавить в плейлист',
          Icons.playlist_add,
          cb.onAddToPlaylist!,
        ),
      if (cb.onShare != null &&
          target.track.ref is LibraryTrackRef &&
          target.track.playable)
        route('share', 'Поделиться', Icons.share, cb.onShare!),
      if (cb.onSettings != null)
        route(
          'settings',
          'Настройки воспроизведения',
          Icons.settings,
          cb.onSettings!,
        ),
    ], title: 'Действия трека');
  }
}

String playerTime(Duration duration) {
  final seconds = duration.inSeconds.clamp(0, 359999);
  final minutes = seconds ~/ 60;
  return '$minutes:${(seconds % 60).toString().padLeft(2, '0')}';
}

class PlayerSeekBar extends StatefulWidget {
  const PlayerSeekBar({super.key, required this.controller});
  final PlayerController controller;
  @override
  State<PlayerSeekBar> createState() => _PlayerSeekBarState();
}

class _PlayerSeekBarState extends State<PlayerSeekBar> {
  double? _preview;
  PlayerTrackTarget? _target;
  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    final state = controller.snapshot;
    final duration = state.duration;
    final max = (duration?.inMilliseconds ?? 0).toDouble();
    final known = max > 0;
    final value = (_preview ?? state.position.inMilliseconds.toDouble()).clamp(
      0.0,
      known ? max : 1.0,
    );
    return Column(
      children: [
        Semantics(
          key: const ValueKey('player-seek-semantics'),
          label: 'Позиция воспроизведения',
          value: playerTime(Duration(milliseconds: value.round())),
          increasedValue: playerTime(
            Duration(
              milliseconds: (state.position.inMilliseconds + 10000).clamp(
                0,
                max.toInt(),
              ),
            ),
          ),
          decreasedValue: playerTime(
            Duration(
              milliseconds: (state.position.inMilliseconds - 10000).clamp(
                0,
                max.toInt(),
              ),
            ),
          ),
          slider: true,
          enabled: known && !controller.busy,
          excludeSemantics: true,
          onIncrease: known && !controller.busy
              ? () => controller.seek(
                  Duration(
                    milliseconds: (state.position.inMilliseconds + 10000).clamp(
                      0,
                      max.toInt(),
                    ),
                  ),
                )
              : null,
          onDecrease: known && !controller.busy
              ? () => controller.seek(
                  Duration(
                    milliseconds: (state.position.inMilliseconds - 10000).clamp(
                      0,
                      max.toInt(),
                    ),
                  ),
                )
              : null,
          child: Slider(
            key: const ValueKey('player-seek'),
            label: playerTime(Duration(milliseconds: value.round())),
            min: 0,
            max: known ? max : 1,
            value: value,
            secondaryTrackValue: known
                ? state.bufferedPosition.inMilliseconds.toDouble().clamp(
                    value,
                    max,
                  )
                : null,
            semanticFormatterCallback: (value) =>
                '${playerTime(Duration(milliseconds: value.round()))} из ${known ? playerTime(duration!) : 'неизвестно'}',
            onChangeStart: known && !controller.busy
                ? (_) => _target = controller.captureTrack()
                : null,
            onChanged: known && !controller.busy
                ? (value) => setState(() => _preview = value)
                : null,
            onChangeEnd: known && !controller.busy
                ? (value) {
                    final target = _target;
                    setState(() {
                      _preview = null;
                      _target = null;
                    });
                    if (target != null) {
                      controller.seek(
                        Duration(milliseconds: value.round()),
                        target: target,
                      );
                    }
                  }
                : null,
          ),
        ),
        Row(
          children: [
            Expanded(
              child: Text(playerTime(Duration(milliseconds: value.round()))),
            ),
            Flexible(
              child: Text(
                known ? playerTime(duration!) : 'Длительность неизвестна',
                textAlign: TextAlign.right,
              ),
            ),
          ],
        ),
      ],
    );
  }
}

class _VolumeSheet extends StatefulWidget {
  const _VolumeSheet({required this.controller, required this.target});
  final PlayerController controller;
  final PlayerTrackTarget target;
  @override
  State<_VolumeSheet> createState() => _VolumeSheetState();
}

class _VolumeSheetState extends State<_VolumeSheet> {
  double? _preview;
  PlayerController get controller => widget.controller;
  PlayerTrackTarget get target => widget.target;
  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: controller,
    builder: (context, _) => SafeArea(
      child: SingleChildScrollView(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  const Expanded(child: Text('Громкость плеера')),
                  MusicIconButton(
                    label: 'Закрыть',
                    icon: Icons.close,
                    onPressed: () => Navigator.pop(context),
                  ),
                ],
              ),
              const Text(
                'Уровень звука приложения. Общая громкость устройства регулируется системными кнопками.',
              ),
              Slider(
                value: _preview ?? controller.snapshot.volume,
                min: 0,
                max: 1,
                label:
                    '${((_preview ?? controller.snapshot.volume) * 100).round()}%',
                onChanged: !target.isCurrent || controller.busy
                    ? null
                    : (value) => setState(() => _preview = value),
                onChangeEnd: !target.isCurrent || controller.busy
                    ? null
                    : (value) {
                        setState(() => _preview = null);
                        controller.setVolume(value, target: target);
                      },
              ),
              TextButton.icon(
                onPressed: !target.isCurrent || controller.busy
                    ? null
                    : () => controller.toggleMute(target: target),
                icon: const Icon(Icons.volume_off),
                label: Text(
                  controller.snapshot.volume > 0
                      ? 'Выключить звук'
                      : 'Включить звук',
                ),
              ),
            ],
          ),
        ),
      ),
    ),
  );
}
