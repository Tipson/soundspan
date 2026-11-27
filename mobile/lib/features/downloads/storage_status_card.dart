import 'package:flutter/material.dart';

import '../../design_system/design_system.dart';
import '../../downloads/download_models.dart';

String downloadBytes(int bytes) => bytes < 1024 * 1024
    ? '${(bytes / 1024).toStringAsFixed(0)} КБ'
    : '${(bytes / (1024 * 1024)).toStringAsFixed(1)} МБ';

/// Counts committed manifest bytes. This is not OS disk capacity/free space.
class StorageStatusCard extends StatelessWidget {
  const StorageStatusCard({
    super.key,
    required this.jobs,
    required this.ready,
    this.settings = const [],
  });
  final List<Widget> settings;
  final List<DeviceDownload> jobs;
  final bool ready;
  @override
  Widget build(BuildContext context) {
    final complete = jobs.where((j) => j.state == DownloadState.ready).toList();
    final bytes = complete.fold<int>(0, (sum, j) => sum + j.bytes);
    final summary =
        '${musicQuantity(complete.length, one: 'готовая загрузка', few: 'готовые загрузки', many: 'готовых загрузок')} · ${downloadBytes(bytes)}';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ExpansionTile(
          key: const PageStorageKey('device-downloads-storage'),
          tilePadding: EdgeInsets.zero,
          childrenPadding: const EdgeInsets.only(bottom: 12),
          shape: const Border(),
          collapsedShape: const Border(),
          title: Semantics(
            label: ready ? 'На этом устройстве' : null,
            child: Text(
              ready ? summary : 'Хранилище недоступно',
              style: Theme.of(context).textTheme.titleMedium,
            ),
          ),
          subtitle: !ready
              ? Text(summary)
              : settings.isEmpty
              ? null
              : const Text('Память и автозагрузка'),
          children: [
            const Text(
              'Объём по данным загрузок приложения. Свободное место смотрите в настройках устройства. Серверная музыка и файлы на других устройствах сюда не входят.',
            ),
            ...settings,
          ],
        ),
        if (!ready)
          const MusicStatus(
            message: 'Проверьте доступ к памяти. Готовые записи остаются в списке; доступность файла проверяется при воспроизведении.',
            error: true,
          ),
      ],
    );
  }
}

String downloadStatus(DeviceDownload job, {int? now}) {
  if (job.errorCode == 'download_cancelled') return 'Отменено';
  if ((job.state == DownloadState.queued ||
          job.state == DownloadState.failed) &&
      job.retryNotBefore > (now ?? DateTime.now().millisecondsSinceEpoch)) {
    return 'Сервер попросил подождать. Повтор доступен позже.';
  }
  final reason = switch (job.errorCode) {
    'offline_mix_quota_exceeded' =>
      'Лимит офлайн-микса. Измените его в настройках и повторите сохранение.',
    'download_storage_full' => 'Недостаточно свободного места.',
    'download_storage_error' =>
      'Ошибка хранилища. Проверьте свободное место и доступ к памяти.',
    'download_network_restricted' =>
      'Загрузка ждёт сеть, разрешённую в настройках.',
    'offline_mode' => 'Для загрузки выключите офлайн-режим.',
    'network_unavailable' => 'Нет связи с сервером.',
    'network_timeout' ||
    'media_idle_timeout' => 'Время ожидания аудио истекло. Можно повторить.',
    'media_network_error' => 'Передача аудио прервалась. Можно повторить.',
    'download_corrupt' => 'Файл повреждён. Можно скачать заново.',
    'download_schedule_unconfirmed' =>
      'Не удалось подтвердить запуск загрузки. Можно повторить.',
    'recording_unavailable' => 'Аудиозапись недоступна.',
    'media_restricted' => 'Источник ограничил доступ к записи.',
    'unauthorized' => 'Войдите в аккаунт заново.',
    'tls_failed' => 'Не удалось проверить защищённое соединение.',
    'http_error' => 'Сервер вернул ошибку. Можно повторить вручную.',
    'invalid_media' => 'Не удалось проверить аудиопоток.',
    _ => null,
  };
  if (reason != null) return reason;
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
