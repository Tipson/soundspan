import 'package:flutter/material.dart';

import 'account_controller.dart';
import 'account_repository.dart';
import 'account_widgets.dart';

class CredentialsScreen extends StatelessWidget {
  const CredentialsScreen({super.key, required this.controller});
  final AccountController controller;
  @override
  Widget build(BuildContext context) => AccountPage(
    controller: controller,
    title: 'Доступ приложений',
    children: () => [
      const Text(
        'Создавайте отдельные данные доступа для каждого устройства. Отзывайте те, которыми больше не пользуетесь. Секрет показывается один раз.',
      ),
      const SizedBox(height: 24),
      for (final app in [true, false]) ...[
        Text(
          app ? 'Пароли приложений' : 'API-ключи',
          style: Theme.of(context).textTheme.titleLarge,
        ),
        const SizedBox(height: 12),
        ..._rows(context, app),
        FilledButton.tonal(
          onPressed: controller.canMutate
              ? () => showAccountForm(
                  context,
                  controller,
                  title: app ? 'Новый пароль приложения' : 'Новый API-ключ',
                  fields: [
                    AccountField(
                      app ? 'displayName' : 'deviceName',
                      'Название устройства',
                      maxLength: app ? 64 : null,
                    ),
                  ],
                  action: app
                      ? AccountAction.createAppPassword
                      : AccountAction.createApiKey,
                )
              : null,
          child: Text(app ? 'Создать пароль приложения' : 'Создать API-ключ'),
        ),
        const SizedBox(height: 28),
      ],
    ],
  );
  List<Widget> _rows(BuildContext context, bool app) {
    final key = app ? 'appPasswords' : 'apiKeys';
    final values = controller.data[key]?[key];
    if (values is! List) {
      return [const Text('Загрузите список, чтобы проверить доступ.')];
    }
    if (values.isEmpty) {
      return [
        const Padding(
          padding: EdgeInsets.only(bottom: 12),
          child: Text('Пока нет'),
        ),
      ];
    }
    return values
        .whereType<Map>()
        .map(
          (row) => Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    row[app ? 'displayName' : 'name'] as String? ??
                        'Устройство',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  Text('Создан: ${row['createdAt'] ?? '—'}'),
                  Text(
                    'Использован: ${row[app ? 'lastUsedAt' : 'lastUsed'] ?? 'никогда'}',
                  ),
                  if (!app) Text('Срок: ${row['expiresAt'] ?? '—'}'),
                  TextButton(
                    onPressed: controller.canMutate
                        ? () async {
                            await showAccountForm(
                              context,
                              controller,
                              title: 'Отозвать доступ?',
                              explanation: 'Это устройство больше не сможет подключаться с этим ключом.',
                              fields: const [],
                              fixed: {'id': row['id']},
                              action: app
                                  ? AccountAction.revokeAppPassword
                                  : AccountAction.revokeApiKey,
                            );
                            await controller.load();
                          }
                        : null,
                    child: const Text('Отозвать'),
                  ),
                ],
              ),
            ),
          ),
        )
        .toList();
  }
}
