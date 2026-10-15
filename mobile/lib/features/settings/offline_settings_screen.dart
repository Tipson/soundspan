import 'package:flutter/material.dart';

import '../../core/network/stored_network_policy.dart';
import '../downloads/downloads_controller.dart';
import 'settings_screen.dart';

class OfflineSettingsScreen extends StatelessWidget {
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
              onPressed: onDownloads,
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
