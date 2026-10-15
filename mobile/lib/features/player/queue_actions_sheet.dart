import 'package:flutter/material.dart';

import '../../design_system/music_action_sheet.dart';
import 'player_controller.dart';

abstract final class QueueActionsSheet {
  static Future<void> show(BuildContext context, PlayerController controller) {
    final target = controller.captureQueue();
    if (target == null) return Future.value();
    return MusicActionSheet.show(context, [
      if (controller.callbacks.onSaveQueue != null)
        MusicAction(
          id: 'save',
          label: 'Сохранить плейлист',
          icon: Icons.playlist_add,
          onSelected: () => controller.saveQueue(target: target),
        ),
      MusicAction(
        id: 'clear',
        label: 'Очистить очередь',
        icon: Icons.delete_outline,
        destructive: true,
        onSelected: () async {
          if (!context.mounted || !target.isCurrent) return;
          final confirmed = await showDialog<bool>(
            context: context,
            useRootNavigator: true,
            builder: (context) => AlertDialog(
              title: const Text('Очистить очередь?'),
              content: const Text(
                'Воспроизведение остановится. Сохранённая музыка останется в библиотеке.',
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(context, false),
                  child: const Text('Отмена'),
                ),
                TextButton(
                  onPressed: () => Navigator.pop(context, true),
                  child: const Text('Очистить'),
                ),
              ],
            ),
          );
          if (confirmed == true) await controller.clear(target: target);
        },
      ),
    ], title: 'Действия очереди');
  }

  static Future<void> entry(
    BuildContext context,
    PlayerController controller,
    String entryId,
  ) {
    final target = controller.captureQueue();
    if (target == null) return Future.value();
    return MusicActionSheet.show(context, [
      if (entryId != target.snapshot.currentEntryId)
        MusicAction(
          id: 'next',
          label: 'Слушать следующим',
          icon: Icons.playlist_play,
          disabledReason: target.snapshot.shuffle
              ? 'Выключите перемешивание для ручного порядка.'
              : null,
          onSelected: () => controller.playNext(entryId, target: target),
        ),
      MusicAction(
        id: 'remove',
        label: 'Удалить из очереди',
        icon: Icons.remove_circle_outline,
        destructive: true,
        onSelected: () => controller.remove(entryId, target: target),
      ),
    ], title: 'Трек в очереди');
  }
}
