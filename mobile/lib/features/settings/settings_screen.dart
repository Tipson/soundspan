import 'package:flutter/material.dart';

/// Root owns navigation and constructs the owner-bound destination controllers.
class SettingsScreen extends StatelessWidget {
  const SettingsScreen({
    super.key,
    required this.onProfile,
    required this.onTaste,
    required this.onPlayback,
    required this.onOffline,
    required this.onAccount,
    required this.onHistory,
    this.onShares,
    this.onInbox,
  });
  final VoidCallback onProfile,
      onTaste,
      onPlayback,
      onOffline,
      onAccount,
      onHistory;
  final VoidCallback? onShares, onInbox;
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Настройки')),
    body: SafeArea(
      child: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Text(
            'Музыка по-вашему',
            style: Theme.of(context).textTheme.headlineMedium,
          ),
          const SizedBox(height: 8),
          const Text('Профиль, звучание и музыка с собой.'),
          const SizedBox(height: 24),
          _entry(
            Icons.person_outline,
            'Профиль',
            'Имя, фото и приватность',
            onProfile,
          ),
          _entry(
            Icons.tune,
            'Музыкальные вкусы',
            'Жанры и исполнители для рекомендаций',
            onTaste,
          ),
          const Divider(height: 32),
          _entry(
            Icons.graphic_eq,
            'Воспроизведение',
            'Качество и ровная громкость',
            onPlayback,
          ),
          _entry(
            Icons.offline_pin_outlined,
            'Офлайн и загрузки',
            'Музыка в памяти устройства',
            onOffline,
          ),
          _entry(
            Icons.history,
            'История прослушиваний',
            'Просмотр и очистка истории',
            onHistory,
          ),
          const Divider(height: 32),
          _entry(
            Icons.shield_outlined,
            'Аккаунт и безопасность',
            'Вход, почта и защита аккаунта',
            onAccount,
          ),
          if (onShares != null)
            _entry(
              Icons.link,
              'Мои ссылки',
              'Доступ к музыке по ссылкам',
              onShares!,
            ),
          if (onInbox != null)
            _entry(
              Icons.inbox_outlined,
              'Входящие',
              'События серверной библиотеки',
              onInbox!,
            ),
        ],
      ),
    ),
  );
  Widget _entry(
    IconData icon,
    String title,
    String subtitle,
    VoidCallback action,
  ) => ListTile(
    contentPadding: const EdgeInsets.symmetric(vertical: 8),
    leading: Icon(icon),
    title: Text(title),
    subtitle: Text(subtitle),
    trailing: const Icon(Icons.chevron_right),
    onTap: action,
  );
}

class SettingsFailure extends StatelessWidget {
  const SettingsFailure(this.message, {super.key, this.retry});
  final String message;
  final VoidCallback? retry;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 12),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Semantics(
          liveRegion: true,
          child: Text(
            message,
            style: TextStyle(color: Theme.of(context).colorScheme.error),
          ),
        ),
        if (retry != null)
          TextButton(onPressed: retry, child: const Text('Повторить')),
      ],
    ),
  );
}
