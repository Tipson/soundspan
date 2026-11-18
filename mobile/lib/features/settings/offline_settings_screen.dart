import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/network/stored_network_policy.dart';
import '../../downloads/download_network_rules.dart';
import '../downloads/downloads_controller.dart';
import '../downloads/storage_status_card.dart';
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
    _loadDownloadPreferencesAfterBuild();
  }

  @override
  void didUpdateWidget(OfflineSettingsScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.downloads != downloads) {
      _loadDownloadPreferencesAfterBuild();
    }
  }

  void _loadDownloadPreferencesAfterBuild() {
    final controller = downloads;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && identical(controller, downloads) && controller.isCurrent) {
        unawaited(controller.loadNetworkRules());
        unawaited(controller.loadQuota());
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

  List<Widget> _quotaSettings() {
    if (downloads.offlineQuota == null) return const [];
    final usage = downloads.quotaUsage;
    final enabled =
        downloads.isCurrent && !downloads.busy && !downloads.quotaLoading;
    final options = <int>{
      512 * 1024 * 1024,
      1024 * 1024 * 1024,
      2 * 1024 * 1024 * 1024,
      if (usage != null) usage.limitBytes,
    }.toList()..sort();
    String label(int bytes) => bytes % (1024 * 1024 * 1024) == 0
        ? '${bytes ~/ (1024 * 1024 * 1024)} ГБ'
        : '${bytes ~/ (1024 * 1024)} МБ';
    return [
      const Divider(height: 32),
      Text(
        'Память для офлайн-микса',
        style: Theme.of(context).textTheme.titleLarge,
      ),
      const SizedBox(height: 8),
      const Text(
        'Отдельные загрузки и Любимое в этот лимит не входят. Готовый микс остаётся доступен, если для обновления не хватает места.',
      ),
      const SizedBox(height: 12),
      if (downloads.quotaLoading) const LinearProgressIndicator(),
      if (downloads.quotaFailure case final failure?) ...[
        SettingsFailure(failure.message),
        TextButton(
          onPressed: enabled ? () => downloads.loadQuota() : null,
          child: const Text('Прочитать лимит снова'),
        ),
      ],
      if (usage != null) ...[
        Semantics(
          label: 'Лимит офлайн-микса',
          child: InputDecorator(
            decoration: const InputDecoration(
              border: OutlineInputBorder(),
              contentPadding: EdgeInsets.symmetric(horizontal: 16, vertical: 4),
            ),
            child: DropdownButtonHideUnderline(
              child: DropdownButton<int>(
                key: const ValueKey('offline-mix-quota-limit'),
                value: usage.limitBytes,
                isExpanded: true,
                itemHeight: 56,
                items: options
                    .map(
                      (bytes) => DropdownMenuItem(
                        value: bytes,
                        child: Text(label(bytes)),
                      ),
                    )
                    .toList(),
                onChanged: enabled
                    ? (bytes) {
                        if (bytes != null) {
                          unawaited(downloads.setQuotaLimit(bytes));
                        }
                      }
                    : null,
              ),
            ),
          ),
        ),
        const SizedBox(height: 8),
        Text(
          'Использовано лимита: ${downloadBytes(usage.usedBytes)}. Включая текущие загрузки.',
          style: Theme.of(context).textTheme.bodySmall,
        ),
      ],
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
            ..._quotaSettings(),
            const SizedBox(height: 20),
            OutlinedButton.icon(
              onPressed: widget.onDownloads,
              icon: const Icon(Icons.download_done),
              label: const Text('Управлять загрузками'),
            ),
            const SizedBox(height: 16),
            Text(
              downloads.offlineQuota == null
                  ? 'Удаление отдельных файлов и состояние памяти доступны в загрузках. Автоматического удаления музыки нет.'
                  : 'Отдельно сохранённые треки удаляются только вручную. Для офлайн-микса защищены текущая и предыдущая готовые версии.',
            ),
          ],
        ),
      ),
    ),
  );
}
