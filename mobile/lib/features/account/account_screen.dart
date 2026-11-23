import 'package:flutter/material.dart';

import 'account_controller.dart';
import 'account_repository.dart';
import 'account_widgets.dart';
import 'two_factor_screen.dart';
import 'credentials_screen.dart';
import 'identities_screen.dart';

class AccountScreen extends StatefulWidget {
  const AccountScreen({
    super.key,
    required this.controller,
    this.onProfile,
    this.onSettings,
  });
  final AccountController controller;
  final VoidCallback? onProfile;
  final VoidCallback? onSettings;
  @override
  State<AccountScreen> createState() => _AccountScreenState();
}

class _AccountScreenState extends State<AccountScreen> {
  @override
  void initState() {
    super.initState();
    widget.controller.load();
  }

  void open(Widget screen) {
    if (widget.controller.active) {
      Navigator.of(context)
          .push(MaterialPageRoute<void>(builder: (_) => screen));
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    return AccountPage(
      controller: c,
      title: 'Аккаунт',
      children: () => [
        Text(
          c.data['profile']?['username'] as String? ?? 'Ваш аккаунт',
          style: Theme.of(context).textTheme.headlineMedium,
        ),
        const SizedBox(height: 16),
        if (widget.onProfile != null)
          accountTile(
            'Профиль',
            'Имя и музыкальные вкусы',
            Icons.person_outline,
            widget.onProfile,
          ),
        accountTile(
          'Электронная почта',
          c.data['profile']?['email'] as String? ?? 'Изменить адрес',
          Icons.mail_outline,
          c.canMutate
              ? () => showAccountForm(
                  context,
                  c,
                  title: 'Электронная почта',
                  fields: const [
                    AccountField(
                      'email',
                      'Новая почта',
                      keyboardType: TextInputType.emailAddress,
                    ),
                  ],
                  action: AccountAction.changeEmail,
                )
              : null,
        ),
        accountTile(
          'Изменить пароль',
          'Потребуется повторный вход',
          Icons.lock_outline,
          c.canMutate
              ? () => showAccountForm(
                  context,
                  c,
                  title: 'Изменить пароль',
                  fields: const [
                    AccountField(
                      'currentPassword',
                      'Текущий пароль',
                      secret: true,
                    ),
                    AccountField('newPassword', 'Новый пароль', secret: true),
                    AccountField(
                      'confirmPassword',
                      'Повторите пароль',
                      secret: true,
                    ),
                  ],
                  action: AccountAction.changePassword,
                  explanation: 'После изменения все текущие токены перестанут действовать.',
                )
              : null,
        ),
        accountTile(
          'Двухэтапная проверка',
          c.data['twoFactor']?['enabled'] == true
              ? 'Включена'
              : 'Защита кодом из приложения',
          Icons.verified_user_outlined,
          () => open(TwoFactorScreen(controller: c)),
        ),
        accountTile(
          'Пароли приложений и ключи',
          'Управление доступом других устройств',
          Icons.key_outlined,
          () => open(CredentialsScreen(controller: c)),
        ),
        accountTile(
          'Связанные аккаунты',
          'Способы входа',
          Icons.link,
          () => open(IdentitiesScreen(controller: c)),
        ),
        if (widget.onSettings != null)
          accountTile(
            'Настройки',
            'Воспроизведение и загрузки',
            Icons.tune,
            widget.onSettings,
          ),
      ],
    );
  }
}
