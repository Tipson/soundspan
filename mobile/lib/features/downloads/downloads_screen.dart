import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../../design_system/design_system.dart';
import '../../downloads/download_models.dart';
import '../library/library_models.dart';
import 'download_actions_sheet.dart';
import 'downloads_controller.dart';
import 'storage_status_card.dart';
import 'offline_mix_controller.dart';
import 'offline_mix_card.dart';

class DownloadsScreen extends StatefulWidget {
  const DownloadsScreen({
    super.key,
    required this.controller,
    required this.onPlay,
    this.autoLoad = true,
    this.visible,
    this.offlineMix,
    this.onOpenOfflineMix,
    this.onChooseMix,
  });
  final DownloadsController controller;
  final Future<void> Function(CollectionPlaybackRequest) onPlay;
  final bool autoLoad;
  final ValueListenable<bool>? visible;
  final OfflineMixController? offlineMix;
  final VoidCallback? onOpenOfflineMix, onChooseMix;
  @override
  State<DownloadsScreen> createState() => _DownloadsScreenState();
}

class _DownloadsScreenState extends State<DownloadsScreen>
    with WidgetsBindingObserver {
  final _search = TextEditingController();
  bool _foreground = true;
  bool _ticker = true;
  @override
  void initState() {
    super.initState();
    final lifecycle = WidgetsBinding.instance.lifecycleState;
    _foreground = lifecycle == null || lifecycle == AppLifecycleState.resumed;
    WidgetsBinding.instance.addObserver(this);
    widget.visible?.addListener(_visibility);
    if (widget.autoLoad) unawaited(widget.controller.refresh());
  }

  void _visibility() => widget.controller.setVisible(
    _foreground && _ticker && (widget.visible?.value ?? true),
  );
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _ticker = TickerMode.valuesOf(context).enabled;
    if (widget.autoLoad) _visibility();
  }

  @override
  void didUpdateWidget(DownloadsScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller.setVisible(false);
      _search.clear();
    }
    oldWidget.visible?.removeListener(_visibility);
    widget.visible?.addListener(_visibility);
    if (widget.autoLoad) _visibility();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    if (widget.autoLoad) _visibility();
  }

  @override
  void dispose() {
    widget.controller.setVisible(false);
    widget.visible?.removeListener(_visibility);
    WidgetsBinding.instance.removeObserver(this);
    _search.dispose();
    super.dispose();
  }

  Future<void> _play(DeviceDownload job) async {
    final controller = widget.controller;
    if (!controller.isCurrent) return;
    try {
      await widget.onPlay(controller.play(job));
    } catch (error) {
      if (mounted &&
          identical(controller, widget.controller) &&
          controller.isCurrent) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(collectionFailure(error).message)),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.controller,
    builder: (context, _) {
      final controller = widget.controller;
      final rows = controller.visible;
      final automation = controller.automation;
      return Scaffold(
        backgroundColor: MusicColors.canvas,
        appBar: AppBar(
          title: const Text('Загрузки'),
          actions: [
            MusicIconButton(
              label: 'Обновить загрузки',
              icon: Icons.refresh,
              onPressed: controller.loading ? null : controller.refresh,
            ),
          ],
        ),
        body: SafeArea(
          top: false,
          child: !controller.isCurrent
              ? const Center(
                  child: Padding(
                    padding: EdgeInsets.all(24),
                    child: Text('Аккаунт изменился. Откройте раздел снова.'),
                  ),
                )
              : ListView.builder(
                  key: const PageStorageKey('device-downloads'),
                  keyboardDismissBehavior:
                      ScrollViewKeyboardDismissBehavior.onDrag,
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                  itemCount: rows.length + 1,
                  itemBuilder: (context, index) {
                    if (index == 0) {
                      return Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          if (widget.offlineMix != null &&
                              widget.onOpenOfflineMix != null)
                            OfflineMixCard(
                              controller: widget.offlineMix!,
                              onOpen: widget.onOpenOfflineMix!,
                              onChoose: widget.onChooseMix,
                              visible: widget.visible,
                            ),
                          StorageStatusCard(
                            jobs: controller.jobs,
                            ready: controller.storageReady(),
                            settings: [
                              if (automation != null)
                                SwitchListTile(
                                  contentPadding: EdgeInsets.zero,
                                  title: const Text('Автозагрузка Любимого'),
                                  subtitle: Text(
                                    automation.paused
                                        ? 'Приостановлена'
                                        : 'Включена',
                                  ),
                                  value: !automation.paused,
                                  onChanged: controller.busy
                                      ? null
                                      : (enabled) => controller
                                            .setAutomationPaused(!enabled),
                                ),
                            ],
                          ),
                          if (automation?.notice != null)
                            MusicStatus(message: automation!.notice!),
                          const SizedBox(height: 16),
                          TextField(
                            key: const PageStorageKey(
                              'device-downloads-search',
                            ),
                            controller: _search,
                            onChanged: controller.setQuery,
                            decoration: const InputDecoration(
                              labelText: 'Поиск в загрузках',
                              prefixIcon: Icon(Icons.search),
                            ),
                          ),
                          const SizedBox(height: 8),
                          SingleChildScrollView(
                            key: const PageStorageKey(
                              'device-downloads-filters',
                            ),
                            scrollDirection: Axis.horizontal,
                            child: Row(
                              children: [
                                for (final filter in DownloadsFilter.values)
                                  Padding(
                                    padding: const EdgeInsets.only(right: 8),
                                    child: ConstrainedBox(
                                      constraints: const BoxConstraints(
                                        minHeight: 48,
                                      ),
                                      child: ChoiceChip(
                                        showCheckmark: false,
                                        label: Text(switch (filter) {
                                          DownloadsFilter.all => 'Все',
                                          DownloadsFilter.ready => 'Готовые',
                                          DownloadsFilter.active =>
                                            'В процессе',
                                          DownloadsFilter.failed => 'Ошибки',
                                        }),
                                        selected: controller.filter == filter,
                                        onSelected: (_) =>
                                            controller.setFilter(filter),
                                      ),
                                    ),
                                  ),
                              ],
                            ),
                          ),
                          if (controller.hasRetryableFailures)
                            MusicButton(
                              label: 'Повторить доступные',
                              icon: Icons.refresh,
                              busy: controller.busy,
                              onPressed: controller.canDownload
                                  ? controller.retryAvailable
                                  : null,
                            ),
                          if (controller.failure != null)
                            MusicStatus(
                              message: controller.failure!.message,
                              error: true,
                            ),
                          if (controller.notice != null)
                            MusicStatus(message: controller.notice!),
                          if (controller.loading && controller.jobs.isEmpty)
                            const LinearProgressIndicator(),
                          if (rows.isEmpty && !controller.loading)
                            Padding(
                              padding: const EdgeInsets.symmetric(vertical: 32),
                              child: Text(
                                controller.jobs.isEmpty
                                    ? 'Скачайте любимую музыку, чтобы слушать без сети.'
                                    : 'По выбранным условиям загрузок нет.',
                              ),
                            ),
                          const SizedBox(height: 4),
                        ],
                      );
                    }
                    final job = rows[index - 1];
                    return Padding(
                      key: ValueKey(job.id),
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          TrackRow(
                            track: job.track,
                            downloaded: job.state == DownloadState.ready,
                            subtitle:
                                '${job.track.artist} · ${downloadStatus(job, now: controller.repository.now)}',
                            onPlay: job.state == DownloadState.ready
                                ? () => _play(job)
                                : null,
                            onMore: () => DownloadActionsSheet.show(
                              context,
                              controller,
                              job,
                              stillMounted: () =>
                                  mounted &&
                                  identical(controller, widget.controller),
                            ),
                          ),
                          if (job.state == DownloadState.downloading ||
                              job.state == DownloadState.verifying)
                            LinearProgressIndicator(
                              value:
                                  job.state == DownloadState.verifying ||
                                      job.totalBytes == null
                                  ? null
                                  : (job.bytes / job.totalBytes!).clamp(
                                      0.0,
                                      1.0,
                                    ),
                            ),
                        ],
                      ),
                    );
                  },
                ),
        ),
      );
    },
  );
}
