import 'package:flutter/material.dart';

import '../../core/model/track.dart';
import '../../design_system/design_system.dart';
import '../../downloads/download_models.dart';
import 'downloads_controller.dart';

abstract final class DownloadActionsSheet {
  /// An explicit manual exception applies only to the selected jobs, never to
  /// the durable network setting or an automatic collection.
  static Future<bool> confirmNetworkUse(
    BuildContext context,
    int count,
  ) async =>
      await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          scrollable: true,
          title: const Text('Разрешить расход трафика?'),
          content: Text(
            'Выбрано треков: $count. Текущая сеть не подходит под настройку загрузок и может расходовать трафик. Разрешение действует только для выбранных загрузок; настройка сети не изменится.',
          ),
          actions: [
            TextButton(
              style: TextButton.styleFrom(minimumSize: const Size(44, 44)),
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Отмена'),
            ),
            TextButton(
              style: TextButton.styleFrom(minimumSize: const Size(44, 44)),
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Скачать выбранное'),
            ),
          ],
        ),
      ) ??
      false;

  /// Each callback captures both the exact row generation and its owner.
  static Future<void> show(
    BuildContext context,
    DownloadsController controller,
    DeviceDownload job, {
    bool Function()? stillMounted,
  }) {
    Future<void> guarded(Future<void> Function() body) async {
      if (controller.isCurrent && (stillMounted?.call() ?? true)) await body();
    }

    final active = const {
      DownloadState.queued,
      DownloadState.downloading,
      DownloadState.verifying,
    }.contains(job.state);
    final reason = controller.busy
        ? 'Изменение сохраняется.'
        : job.retryNotBefore > controller.repository.now
        ? 'Сервер попросил подождать. Повтор доступен позже.'
        : !controller.canDownload
        ? 'Для новой загрузки нужны сеть и доступное хранилище.'
        : null;
    return MusicActionSheet.show(context, [
      if (active)
        MusicAction(
          id: 'pause',
          label: 'Приостановить',
          icon: Icons.pause,
          onSelected: () => guarded(() => controller.pause(job)),
        ),
      if (job.state == DownloadState.paused)
        MusicAction(
          id: 'resume',
          label: 'Продолжить загрузку',
          icon: Icons.download_outlined,
          disabledReason: reason,
          onSelected: () => guarded(() => controller.resume(job)),
        ),
      if (job.state == DownloadState.failed)
        MusicAction(
          id: 'retry',
          label: 'Повторить загрузку',
          icon: Icons.refresh,
          disabledReason: reason,
          onSelected: () => guarded(() => controller.retry(job)),
        ),
      if (job.state != DownloadState.ready &&
          job.errorCode != 'download_cancelled')
        MusicAction(
          id: 'cancel',
          label: 'Отменить загрузку',
          icon: Icons.close,
          onSelected: () => guarded(() => controller.cancel(job)),
        ),
      MusicAction(
        id: 'remove',
        label: 'Удалить с устройства',
        icon: Icons.delete_outline,
        destructive: true,
        onSelected: () => guarded(() async {
          if (!context.mounted) return;
          final confirmed = await showDialog<bool>(
            context: context,
            builder: (context) => AlertDialog(
              title: const Text('Удалить загрузку?'),
              content: Text(
                '«${job.track.title}» будет удалён только с этого устройства.',
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(context, false),
                  child: const Text('Оставить'),
                ),
                TextButton(
                  onPressed: () => Navigator.pop(context, true),
                  child: const Text('Удалить'),
                ),
              ],
            ),
          );
          if (confirmed == true &&
              controller.isCurrent &&
              (stillMounted?.call() ?? true)) {
            await controller.remove(job);
          }
        }),
      ),
    ], title: job.track.title);
  }

  /// This receives the original visible collection, never an implicit crawl.
  /// Duplicate positions remain selectable; the repository owns job deduplication.
  static Future<void> confirmSelection(
    BuildContext context,
    DownloadsController controller,
    List<Track> tracks, {
    String quality = 'original',
    Future<void> Function()? beforeDownload,
  }) async {
    final original = List<Track>.unmodifiable(tracks);
    final selected = await showModalBottomSheet<List<Track>>(
      context: context,
      useSafeArea: true,
      useRootNavigator: true,
      isScrollControlled: true,
      builder: (_) => _Selection(tracks: original),
    );
    if (selected != null && selected.isNotEmpty && controller.isCurrent) {
      await beforeDownload?.call();
      if (!controller.isCurrent ||
          !context.mounted ||
          !(ModalRoute.of(context)?.isCurrent ?? true)) {
        return;
      }
      await controller.downloadTracks(selected, quality: quality);
    }
  }
}

class _Selection extends StatefulWidget {
  const _Selection({required this.tracks});
  final List<Track> tracks;
  @override
  State<_Selection> createState() => _SelectionState();
}

class _SelectionState extends State<_Selection> {
  late final Set<int> selected = {
    for (final (i, track) in widget.tracks.indexed)
      if (track.playable) i,
  };
  @override
  Widget build(BuildContext context) => SizedBox(
    height: MediaQuery.sizeOf(context).height * .85,
    child: Padding(
      padding: EdgeInsets.fromLTRB(
        16,
        16,
        16,
        MediaQuery.viewInsetsOf(context).bottom + 16,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(
            child: ListView.builder(
              itemCount: widget.tracks.length + 1,
              itemBuilder: (_, row) {
                if (row == 0) {
                  return Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Text(
                          'Скачать выбранную музыку',
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                        const SizedBox(height: 8),
                        Text(
                          'Показано ${widget.tracks.length} позиций. Выбрано ${selected.length}. Другие страницы коллекции не загружаются.',
                        ),
                      ],
                    ),
                  );
                }
                final i = row - 1;
                final track = widget.tracks[i];
                return CheckboxListTile(
                  value: selected.contains(i),
                  title: Text(
                    track.title,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                  subtitle: Text(
                    track.playable ? track.artist : 'Запись недоступна',
                  ),
                  onChanged: !track.playable
                      ? null
                      : (value) => setState(() {
                          if (value == true) {
                            selected.add(i);
                          } else {
                            selected.remove(i);
                          }
                        }),
                );
              },
            ),
          ),
          const SizedBox(height: 8),
          MusicButton(
            label: 'Скачать ${selected.length} треков',
            icon: Icons.download_outlined,
            onPressed: selected.isEmpty
                ? null
                : () => Navigator.pop(context, [
                    for (final (i, track) in widget.tracks.indexed)
                      if (selected.contains(i)) track,
                  ]),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Отмена'),
          ),
        ],
      ),
    ),
  );
}
