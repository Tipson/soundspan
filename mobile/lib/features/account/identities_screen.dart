import 'package:flutter/material.dart';

import 'account_controller.dart';
import 'account_repository.dart';
import 'account_widgets.dart';

class IdentitiesScreen extends StatelessWidget {
  const IdentitiesScreen({super.key, required this.controller});
  final AccountController controller;
  @override
  Widget build(BuildContext context) => AccountPage(
    controller: controller,
    title: 'Связанные аккаунты',
    children: () => [
      const Text(
        'Последний способ входа удалить нельзя. Подключение новых SSO-аккаунтов для этого сервера недоступно.',
      ),
      const SizedBox(height: 20),
      if (controller.data['identities']?['identities']
          case final List rows) ...[
        if (rows.isEmpty) const Text('Связанных аккаунтов нет'),
        for (final row in rows.whereType<Map>())
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    row['displayName'] as String? ??
                        row['provider'] as String? ??
                        'Аккаунт',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  if (row['email'] != null) Text(row['email'] as String),
                  Text(row['subjectHint'] as String? ?? ''),
                  TextButton(
                    onPressed: controller.canMutate
                        ? () async {
                            await showAccountForm(
                              context,
                              controller,
                              title: 'Отвязать аккаунт?',
                              explanation: 'Убедитесь, что можете войти другим способом.',
                              fields: const [],
                              fixed: {'id': row['id']},
                              action: AccountAction.unlinkIdentity,
                            );
                            await controller.load();
                          }
                        : null,
                    child: const Text('Отвязать'),
                  ),
                ],
              ),
            ),
          ),
      ] else
        const Text('Обновите данные для просмотра способов входа.'),
    ],
  );
}
