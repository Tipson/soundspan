import 'package:flutter/material.dart';

import '../../design_system/design_system.dart';
import 'apk_update_controller.dart';

class AppUpdateScreen extends StatefulWidget {
  const AppUpdateScreen({
    super.key,
    required this.controller,
    this.visibilityChanges,
    this.isExposed,
  });
  final ApkUpdateController controller;
  final Listenable? visibilityChanges;
  final bool Function()? isExposed;
  @override
  State<AppUpdateScreen> createState() => _AppUpdateScreenState();
}

class _AppUpdateScreenState extends State<AppUpdateScreen>
    with WidgetsBindingObserver {
  bool _foreground = true;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.visibilityChanges?.addListener(_visibility);
  }

  void _visibility() {
    if (!mounted) return;
    final visible =
        _foreground &&
        (ModalRoute.of(context)?.isCurrent ?? true) &&
        widget.isExposed?.call() != false;
    if (visible) {
      widget.controller.open();
    } else {
      widget.controller.leave();
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _visibility();
  }

  @override
  void didUpdateWidget(covariant AppUpdateScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.visibilityChanges != widget.visibilityChanges) {
      oldWidget.visibilityChanges?.removeListener(_visibility);
      widget.visibilityChanges?.addListener(_visibility);
    }
    _visibility();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    _visibility();
  }

  @override
  void dispose() {
    widget.controller.leave();
    widget.visibilityChanges?.removeListener(_visibility);
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (_, _) {
      final c = widget.controller;
      final text = switch (c.phase) {
        AppUpdatePhase.idle =>
          'Проверьте, доступна ли новая версия приложения.',
        AppUpdatePhase.checking => 'Проверяем обновление…',
        AppUpdatePhase.unsupported =>
          'Обновления на этом сервере не настроены.',
        AppUpdatePhase.noRelease => 'В этом канале пока нет обновлений.',
        AppUpdatePhase.current => 'Более новой доступной версии нет.',
        AppUpdatePhase.available =>
          'Доступна версия ${c.manifest?.versionName}.',
        AppUpdatePhase.incompatible => 'Это обновление несовместимо с приложением, устройством или сервером.',
        AppUpdatePhase.downloading => 'Скачиваем и проверяем обновление…',
        AppUpdatePhase.ready => 'Обновление скачано и проверено. Установка потребует подтверждения Android.',
        AppUpdatePhase.needsPermission => 'Android пока не разрешает установку из Soundspan. Разрешение можно изменить в системных настройках.',
        AppUpdatePhase.installing => 'Готовим системную установку…',
        AppUpdatePhase.pending => 'Результат установки пока не подтверждён. Проверьте установленную версию после завершения действий Android.',
        AppUpdatePhase.failed => c.message ?? 'Обновление недоступно.',
      };
      return ScreenScaffold(
        title: 'Обновление приложения',
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (c.installed case final info?) ...[
              Text(
                'Установлена версия ${info.versionName} (${info.versionCode})',
              ),
              const SizedBox(height: 16),
            ],
            Semantics(liveRegion: true, child: Text(text)),
            const SizedBox(height: 20),
            if (c.busy) ...[
              LinearProgressIndicator(
                value:
                    c.phase == AppUpdatePhase.downloading && c.manifest != null
                    ? (c.received / c.manifest!.bytes).clamp(0, 1)
                    : null,
              ),
              const SizedBox(height: 16),
              OutlinedButton(
                onPressed: c.cancel,
                child: const Text('Отменить'),
              ),
            ],
            FilledButton(
              key: const Key('update-check'),
              onPressed: c.busy ? null : c.check,
              child: const Text('Проверить обновление'),
            ),
            if (c.canDownload) ...[
              const SizedBox(height: 12),
              OutlinedButton(
                key: const Key('update-download'),
                onPressed: c.download,
                child: Text(
                  'Скачать ${c.manifest!.versionName} (${(c.manifest!.bytes / (1024 * 1024)).toStringAsFixed(1)} МБ)',
                ),
              ),
            ],
            if (c.phase == AppUpdatePhase.needsPermission) ...[
              const SizedBox(height: 12),
              OutlinedButton(
                key: const Key('update-permission'),
                onPressed: c.openInstallSettings,
                child: const Text('Открыть системные настройки'),
              ),
            ],
            if (c.canInstall) ...[
              const SizedBox(height: 12),
              OutlinedButton(
                key: const Key('update-install'),
                onPressed: c.install,
                child: const Text('Установить'),
              ),
            ],
            if (c.phase == AppUpdatePhase.pending) ...[
              const SizedBox(height: 12),
              OutlinedButton(
                onPressed: c.cancelPendingInstall,
                child: const Text('Отменить подготовленную установку'),
              ),
            ],
          ],
        ),
      );
    },
  );
}
