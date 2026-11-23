import 'package:flutter/material.dart';

import 'account_controller.dart';
import 'account_repository.dart';
import 'account_widgets.dart';

class TwoFactorScreen extends StatelessWidget {
  const TwoFactorScreen({super.key, required this.controller});
  final AccountController controller;
  @override
  Widget build(BuildContext context) => AccountPage(
    controller: controller,
    title: 'Двухэтапная проверка',
    children: () => [
      Icon(
        controller.data['twoFactor']?['enabled'] == true
            ? Icons.verified_user
            : Icons.shield_outlined,
        size: 56,
      ),
      const SizedBox(height: 20),
      Text(
        controller.data['twoFactor']?['enabled'] == true
            ? 'Защита включена'
            : 'Защитите вход в аккаунт',
        style: Theme.of(context).textTheme.headlineSmall,
      ),
      const SizedBox(height: 12),
      const Text(
        'Кроме пароля при входе потребуется код из приложения-аутентификатора. Резервные коды выдаются при включении; каждый подходит для одного входа. Повторно посмотреть или перевыпустить их на сервере нельзя.',
      ),
      const SizedBox(height: 24),
      if (controller.data['twoFactor']?['enabled'] == true)
        OutlinedButton(
          onPressed: controller.canMutate
              ? () => showAccountForm(
                  context,
                  controller,
                  title: 'Отключить 2FA',
                  explanation: 'Вход останется защищён только паролем. Нужен текущий код из аутентификатора, не резервный код.',
                  fields: const [
                    AccountField('password', 'Текущий пароль', secret: true),
                    AccountField(
                      'token',
                      'Текущий код',
                      maxLength: 6,
                      keyboardType: TextInputType.number,
                    ),
                  ],
                  action: AccountAction.disable2fa,
                )
              : null,
          child: const Text('Отключить 2FA'),
        )
      else
        FilledButton(
          onPressed: controller.canMutate
              ? () async {
                  await controller.perform(AccountAction.setup2fa);
                  if (context.mounted &&
                      controller.canRevealSecret &&
                      (ModalRoute.of(context)?.isCurrent ?? false)) {
                    await showAccountSecret(context, controller);
                  } else {
                    controller.clearSecret();
                  }
                }
              : null,
          child: const Text('Настроить 2FA'),
        ),
    ],
  );
}
