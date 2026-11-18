import 'package:flutter/material.dart';

import '../../core/model/app_failure.dart';
import '../../core/model/play_context.dart';
import '../../design_system/design_system.dart';
import '../../downloads/offline_mix_repository.dart';
import '../library/library_models.dart';
import 'offline_mix_controller.dart';
import 'offline_mix_watch.dart';

class OfflineMixScreen extends StatefulWidget {
  const OfflineMixScreen({
    super.key,
    required this.controller,
    required this.onPlay,
    this.generation,
  });
  final OfflineMixController controller;
  final int? generation;
  final Future<void> Function(CollectionPlaybackRequest) onPlay;
  @override
  State<OfflineMixScreen> createState() => _OfflineMixScreenState();
}

class _OfflineMixScreenState extends State<OfflineMixScreen> {
  AppFailure? _failure;
  Future<void> _run(Future<void> Function() action) async {
    if (!widget.controller.isCurrent) return;
    setState(() => _failure = null);
    try {
      await action();
    } catch (error) {
      if (mounted && widget.controller.isCurrent) {
        setState(() => _failure = collectionFailure(error));
      }
    }
  }

  Future<void> _play(
    OfflineMixSnapshot snapshot,
    int index, {
    bool shuffle = false,
  }) => _run(
    () => widget.onPlay(
      CollectionPlaybackRequest(
        tracks: snapshot.tracks,
        startIndex: index,
        shuffle: shuffle,
        fence: widget.controller.repository.fence,
        context: PlayContext(
          surface: PlaySurface.library,
          offlineMixGeneration: snapshot.generation,
        ),
      ),
    ),
  );
  Future<void> _actions(OfflineMixItem item) => MusicActionSheet.show(context, [
    MusicAction(
      id: 'pin',
      label: 'Оставить на устройстве',
      icon: Icons.push_pin_outlined,
      onSelected: () => _run(() => widget.controller.pin(item)),
    ),
  ], title: item.track.title);

  @override
  Widget build(BuildContext context) => OfflineMixWatch(
    controller: widget.controller,
    builder: (context) {
      final state = widget.controller.state;
      OfflineMixSnapshot? snapshot;
      for (final candidate in [state.active, state.previous].nonNulls) {
        if (widget.generation == null ||
            candidate.generation == widget.generation) {
          snapshot = candidate;
          break;
        }
      }
      final current = snapshot;
      return Scaffold(
        appBar: AppBar(title: const Text('Офлайн-микс')),
        body: SafeArea(
          top: false,
          bottom: false,
          child: current == null
              ? const Center(
                  child: Padding(
                    padding: EdgeInsets.all(24),
                    child: MusicStatus(
                      message: 'Эта версия подборки больше не сохранена. Откройте готовый микс в загрузках.',
                    ),
                  ),
                )
              : CustomScrollView(
                  slivers: [
                    SliverPadding(
                      padding: const EdgeInsets.fromLTRB(20, 16, 20, 20),
                      sliver: SliverToBoxAdapter(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            Row(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Artwork(
                                  uri: current.tracks.first.artwork,
                                  trackRef: current.tracks.first.ref,
                                  size: 80,
                                  radius: 12,
                                ),
                                const SizedBox(width: 16),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        current.title,
                                        style: Theme.of(context)
                                            .textTheme
                                            .headlineSmall,
                                      ),
                                      const SizedBox(height: 8),
                                      Text(
                                        musicQuantity(
                                          current.items.length,
                                          one: 'трек',
                                          few: 'трека',
                                          many: 'треков',
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 20),
                            if (MediaQuery.textScalerOf(context).scale(16) >=
                                24) ...[
                              MusicButton(
                                label: 'Слушать',
                                icon: Icons.play_arrow_rounded,
                                onPressed: () => _play(current, 0),
                              ),
                              Align(
                                alignment: Alignment.centerLeft,
                                child: MusicIconButton(
                                  label: 'Перемешать офлайн-микс',
                                  icon: Icons.shuffle_rounded,
                                  onPressed: () =>
                                      _play(current, 0, shuffle: true),
                                ),
                              ),
                            ] else
                              Row(
                                children: [
                                  Expanded(
                                    child: MusicButton(
                                      label: 'Слушать',
                                      icon: Icons.play_arrow_rounded,
                                      onPressed: () => _play(current, 0),
                                    ),
                                  ),
                                  const SizedBox(width: 12),
                                  MusicIconButton(
                                    label: 'Перемешать офлайн-микс',
                                    icon: Icons.shuffle_rounded,
                                    onPressed: () =>
                                        _play(current, 0, shuffle: true),
                                  ),
                                ],
                              ),
                            if (_failure case final failure?)
                              MusicStatus(
                                message: failure.message,
                                error: true,
                              ),
                            if (widget.controller.failure case final failure?)
                              MusicStatus(
                                message: failure.message,
                                error: true,
                              ),
                            if (widget.controller.notice case final notice?)
                              MusicStatus(message: notice),
                          ],
                        ),
                      ),
                    ),
                    SliverPadding(
                      padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
                      sliver: SliverList.builder(
                        itemCount: current.items.length,
                        itemBuilder: (context, index) {
                          final item = current.items[index];
                          return Row(
                            children: [
                              Expanded(
                                child: TrackRow(
                                  track: item.track,
                                  downloaded: true,
                                  onPlay: () => _play(current, index),
                                ),
                              ),
                              MusicIconButton(
                                label:
                                    'Действия с офлайн-треком «${item.track.title}»',
                                icon: Icons.more_horiz,
                                onPressed: () => _actions(item),
                              ),
                            ],
                          );
                        },
                      ),
                    ),
                  ],
                ),
        ),
      );
    },
  );
}
