import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';

import '../../design_system/design_system.dart';
import 'offline_mix_controller.dart';
import 'offline_mix_watch.dart';

class OfflineMixCard extends StatelessWidget {
  const OfflineMixCard({
    super.key,
    required this.controller,
    required this.onOpen,
    this.onChoose,
    this.visible,
  });
  final OfflineMixController controller;
  final VoidCallback onOpen;
  final VoidCallback? onChoose;
  final ValueListenable<bool>? visible;
  @override
  Widget build(BuildContext context) => OfflineMixWatch(
    controller: controller,
    visible: visible,
    builder: (context) {
      if (!controller.isCurrent) return const SizedBox.shrink();
      final state = controller.state;
      final active = state.active, pending = state.pending;
      final shown = active ?? pending;
      final total = pending?.items.length ?? 0;
      final ready = state.pendingReadyCount.clamp(0, total);
      return Padding(
        padding: const EdgeInsets.only(bottom: 20),
        child: Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: MusicColors.surface1,
            borderRadius: BorderRadius.circular(16),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  const Icon(
                    Icons.offline_pin_outlined,
                    color: MusicColors.primary,
                    size: 22,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      'Сохранённый микс',
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              if (shown == null) ...[
                const Text(
                  'Сохраните подборку целиком и слушайте её без интернета.',
                ),
                if (onChoose != null)
                  Align(
                    alignment: Alignment.centerLeft,
                    child: TextButton(
                      onPressed: onChoose,
                      child: const Text('Выбрать подборку'),
                    ),
                  ),
              ] else ...[
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Artwork(
                      uri: shown.tracks.first.artwork,
                      trackRef: shown.tracks.first.ref,
                      size: 64,
                      radius: 12,
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            shown.title,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: Theme.of(context).textTheme.titleMedium,
                          ),
                          const SizedBox(height: 4),
                          Text(
                            active == null
                                ? 'Подготавливаем для офлайна'
                                : '${musicQuantity(active.items.length, one: 'трек', few: 'трека', many: 'треков')} · без сети',
                            style: Theme.of(context).textTheme.bodySmall
                                ?.copyWith(color: MusicColors.textSecondary),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
                if (pending != null) ...[
                  const SizedBox(height: 16),
                  if (active != null &&
                      active.sourceIdentity != pending.sourceIdentity)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Text('Новая подборка: ${pending.title}'),
                    ),
                  LinearProgressIndicator(
                    value: total == 0 ? 0 : ready / total,
                    minHeight: 4,
                    borderRadius: BorderRadius.circular(4),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'Загружено $ready из $total',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                  if (active != null)
                    const Padding(
                      padding: EdgeInsets.only(top: 4),
                      child: Text(
                        'Готовый микс доступен, пока обновляется новый.',
                      ),
                    ),
                ],
                Wrap(
                  spacing: 12,
                  children: [
                    if (active != null)
                      TextButton(
                        onPressed: onOpen,
                        child: const Text('Открыть'),
                      ),
                    if (pending != null)
                      TextButton(
                        onPressed: controller.busy ? null : controller.retry,
                        child: const Text('Продолжить сохранение'),
                      ),
                  ],
                ),
              ],
              if (controller.failure case final failure?)
                MusicStatus(message: failure.message, error: true),
              if (controller.notice case final notice?)
                MusicStatus(message: notice),
            ],
          ),
        ),
      );
    },
  );
}
