import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/network/stored_network_policy.dart';
import '../../downloads/download_network_rules.dart';
import '../downloads/downloads_controller.dart';
import 'settings_screen.dart';

class OfflineSettingsScreen extends StatefulWidget {
  const OfflineSettingsScreen({
    super.key,
    required this.policy,
    required this.downloads,
    required this.onDownloads,
  });
  final StoredNetworkPolicy policy;
  final DownloadsController downloads;
  final VoidCallback onDownloads;
  @override
  State<OfflineSettingsScreen> createState() => _OfflineSettingsScreenState();
}

class _OfflineSettingsScreenState extends State<OfflineSettingsScreen> {
  StoredNetworkPolicy get policy => widget.policy;
  DownloadsController get downloads => widget.downloads;
  @override
  void initState() {
    super.initState();
    _loadNetworkRulesAfterBuild();
  }

  @override
  void didUpdateWidget(OfflineSettingsScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.downloads != downloads) {
      _loadNetworkRulesAfterBuild();
    }
  }

  void _loadNetworkRulesAfterBuild() {
    final controller = downloads;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && identical(controller, downloads) && controller.isCurrent) {
        unawaited(controller.loadNetworkRules());
      }
    });
  }

  List<Widget> _networkSettings() {
    if (downloads.networkAccess == null) return const [];
    final rules = downloads.networkRules;
    final enabled =
        downloads.isCurrent &&
        !downloads.busy &&
        !downloads.networkRulesLoading;
    return [
      Text('Сеть загрузок', style: Theme.of(context).textTheme.titleLarge),
      const SizedBox(height: 8),
      const Text(
        'Wi-Fi тоже может расходовать платный трафик. Эта настройка не меняет текущее воспроизведение.',
      ),
      if (downloads.networkRulesLoading)
        const Padding(
          padding: EdgeInsets.symmetric(vertical: 12),
          child: LinearProgressIndicator(),
        ),
      if (downloads.networkRulesFailure case final failure?) ...[
        SettingsFailure(failure.message),
        TextButton(
          style: TextButton.styleFrom(minimumSize: const Size(44, 44)),
          onPressed: enabled ? () => downloads.loadNetworkRules() : null,
          child: const Text('Прочитать настройку снова'),
        ),
      ],
      RadioGroup<DownloadNetworkMode>(
        groupValue: rules?.mode,
        onChanged: (mode) {
          if (enabled && mode != null) {
            unawaited(
              downloads.setNetworkRules(
                DownloadNetworkRules(
                  mode: mode,
                  allowRoaming: rules?.allowRoaming ?? false,
                ),
              ),
            );
          }
        },
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final option in const {
              DownloadNetworkMode.unmetered: 'Без тарификации',
              DownloadNetworkMode.wifi: 'Wi-Fi',
              DownloadNetworkMode.any: 'Любая сеть',
            }.entries)
              RadioListTile<DownloadNetworkMode>(
                contentPadding: EdgeInsets.zero,
                title: Text(option.value),
                subtitle: option.key == DownloadNetworkMode.unmetered
                    ? const Text('По умолчанию')
                    : null,
                value: option.key,
                enabled: enabled,
              ),
          ],
        ),
      ),
      SwitchListTile(
        contentPadding: EdgeInsets.zero,
        title: const Text('Разрешить роуминг'),
        subtitle: const Text('Действует отдельно от выбранной сети.'),
        value: rules?.allowRoaming ?? false,
        onChanged: !enabled || rules == null
            ? null
            : (value) => downloads.setNetworkRules(
                DownloadNetworkRules(mode: rules.mode, allowRoaming: value),
              ),
      ),
      const Divider(height: 32),
    ];
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([policy, downloads]),
    builder: (context, _) => Scaffold(
      appBar: AppBar(title: const Text('Офлайн и загрузки')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(20),
          children: [
            Text(
              'Музыка с собой',
              style: Theme.of(context).textTheme.headlineMedium,
            ),
            const SizedBox(height: 8),
            const Text(
              'Загруженные записи доступны без интернета. Файлы принадлежат текущему аккаунту на этом устройстве.',
            ),
            const SizedBox(height: 20),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('Офлайн-режим'),
              subtitle: const Text(
                'Использовать только загруженную музыку. Сетевые запросы и новые загрузки приостановятся.',
              ),
              value: policy.offline,
              onChanged: !policy.busy && downloads.isCurrent
                  ? (value) async {
                      try {
                        await policy.setOffline(value);
                      } catch (_) {
                        /* Policy publishes actionable failure. */
                      }
                    }
                  : null,
            ),
            if (policy.failure != null)
              SettingsFailure(policy.failure!.message),
            const Divider(height: 32),
            ..._networkSettings(),
            if (downloads.automation != null)
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Автозагрузка Любимого'),
                subtitle: const Text(
                  'Сохранять понравившиеся треки при доступной сети и памяти. Выключение не удаляет готовые файлы.',
                ),
                value: !downloads.automation!.paused,
                onChanged: downloads.isCurrent && !downloads.busy
                    ? (v) => downloads.setAutomationPaused(!v)
                    : null,
              ),
            if (downloads.failure != null)
              SettingsFailure(downloads.failure!.message),
            const SizedBox(height: 20),
            OutlinedButton.icon(
              onPressed: widget.onDownloads,
              icon: const Icon(Icons.download_done),
              label: const Text('Управлять загрузками'),
            ),
            const SizedBox(height: 16),
            const Text(
              'Удаление отдельных файлов и состояние памяти доступны в загрузках. Автоматического удаления музыки нет.',
            ),
          ],
        ),
      ),
    ),
  );
}
