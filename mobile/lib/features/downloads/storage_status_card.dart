import 'package:flutter/material.dart';

import '../../design_system/design_system.dart';
import '../../downloads/download_models.dart';

String downloadBytes(int bytes) => bytes < 1024 * 1024
    ? '${(bytes / 1024).toStringAsFixed(0)} КБ'
    : '${(bytes / (1024 * 1024)).toStringAsFixed(1)} МБ';

/// Counts committed manifest bytes. This is not OS disk capacity/free space.
class StorageStatusCard extends StatelessWidget {
  const StorageStatusCard({super.key, required this.jobs, required this.ready});
  final List<DeviceDownload> jobs;
  final bool ready;
  @override
  Widget build(BuildContext context) {
    final complete = jobs.where((j) => j.state == DownloadState.ready).toList();
    final bytes = complete.fold<int>(0, (sum, j) => sum + j.bytes);
    final summary =
        '${musicQuantity(complete.length, one: 'готовая загрузка', few: 'готовые загрузки', many: 'готовых загрузок')} · ${downloadBytes(bytes)}';
    return Container(
      decoration: BoxDecoration(
        color: MusicColors.surface1,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ExpansionTile(
            tilePadding: const EdgeInsets.symmetric(horizontal: 16),
            childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            shape: const Border(),
            collapsedShape: const Border(),
            title: Semantics(
              label: ready ? 'На этом устройстве' : null,
              child: Text(
                ready ? summary : 'Хранилище недоступно',
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ),
            subtitle: ready ? null : Text(summary),
            children: const [
              Text(
                'Объём по данным загрузок приложения. Свободное место смотрите в настройках устройства. Серверная музыка и файлы на других устройствах сюда не входят.',
              ),
            ],
          ),
          if (!ready)
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: 16),
              child: MusicStatus(
                message: 'Проверьте доступ к памяти. Готовые записи остаются в списке; доступность файла проверяется при воспроизведении.',
                error: true,
              ),
            ),
        ],
      ),
    );
  }
}

String downloadStatus(DeviceDownload job) {
  if (job.errorCode == 'download_cancelled') return 'Отменено';
  if (const {
    'download_storage_error',
    'download_storage_full',
  }.contains(job.errorCode)) {
    return 'Ошибка хранилища. Проверьте свободное место и доступ к памяти.';
  }
  return switch (job.state) {
    DownloadState.queued => 'Ожидает загрузки',
    DownloadState.downloading =>
      job.totalBytes == null
          ? 'Загружается · ${downloadBytes(job.bytes)}'
          : 'Загружается · ${downloadBytes(job.bytes)} из ${downloadBytes(job.totalBytes!)}',
    DownloadState.paused => 'Приостановлено',
    DownloadState.verifying => 'Проверяем файл',
    DownloadState.ready => 'На устройстве · ${downloadBytes(job.bytes)}',
    DownloadState.failed => 'Не удалось загрузить. Можно повторить.',
    DownloadState.removing => 'Удаляем с устройства',
  };
}
