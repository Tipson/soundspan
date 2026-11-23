import 'package:flutter/material.dart';

import '../../design_system/design_system.dart';

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
    this.onUpdates,
  });
  final VoidCallback onProfile,
      onTaste,
      onPlayback,
      onOffline,
      onAccount,
      onHistory;
  final VoidCallback? onShares, onInbox;
  final VoidCallback? onUpdates;
  @override
  Widget build(BuildContext context) => ScreenScaffold(
    title: 'Настройки',
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _group(context, 'Для вас', [
          _entry(
            context,
            Icons.person_outline,
            'Профиль',
            'Имя, фото и приватность',
            onProfile,
          ),
          _entry(
            context,
            Icons.tune,
            'Музыкальные вкусы',
            'Жанры и исполнители для рекомендаций',
            onTaste,
          ),
        ]),
        _group(context, 'Музыка', [
          _entry(
            context,
            Icons.graphic_eq,
            'Воспроизведение',
            'Качество и ровная громкость',
            onPlayback,
          ),
          _entry(
            context,
            Icons.offline_pin_outlined,
            'Офлайн и загрузки',
            'Музыка в памяти устройства',
            onOffline,
          ),
          _entry(
            context,
            Icons.history,
            'История прослушиваний',
            'Просмотр и очистка истории',
            onHistory,
          ),
        ]),
        _group(context, 'Аккаунт', [
          _entry(
            context,
            Icons.shield_outlined,
            'Аккаунт и безопасность',
            'Вход, почта и защита аккаунта',
            onAccount,
          ),
          if (onShares != null)
            _entry(
              context,
              Icons.link,
              'Мои ссылки',
              'Доступ к музыке по ссылкам',
              onShares!,
            ),
          if (onInbox != null)
            _entry(
              context,
              Icons.inbox_outlined,
              'Входящие',
              'События серверной библиотеки',
              onInbox!,
            ),
        ]),
        if (onUpdates != null)
          _group(context, 'Приложение', [
            _entry(
              context,
              Icons.system_update_outlined,
              'Обновление приложения',
              'Проверить новую версию',
              onUpdates!,
            ),
          ]),
      ],
    ),
  );

  Widget _group(BuildContext context, String title, List<Widget> entries) =>
      Padding(
        padding: const EdgeInsets.only(bottom: 24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 0, 4, 10),
              child: Semantics(
                header: true,
                child: Text(
                  title,
                  style: Theme.of(context).textTheme.labelMedium
                      ?.copyWith(color: MusicColors.textSecondary),
                ),
              ),
            ),
            Material(
              color: MusicColors.surface1,
              borderRadius: BorderRadius.circular(MusicRadius.card),
              clipBehavior: Clip.antiAlias,
              child: Column(
                children: [
                  for (final (index, entry) in entries.indexed) ...[
                    if (index > 0)
                      const Padding(
                        padding: EdgeInsets.only(left: 56),
                        child: Divider(),
                      ),
                    entry,
                  ],
                ],
              ),
            ),
          ],
        ),
      );

  Widget _entry(
    BuildContext context,
    IconData icon,
    String title,
    String subtitle,
    VoidCallback action,
  ) => ListTile(
    contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
    minVerticalPadding: 8,
    minLeadingWidth: 24,
    horizontalTitleGap: 12,
    leading: Icon(icon, size: 24, color: MusicColors.textSecondary),
    title: Text(title, style: Theme.of(context).textTheme.titleMedium),
    subtitle: Text(
      subtitle,
      style: Theme.of(context).textTheme.bodySmall
          ?.copyWith(color: MusicColors.textSecondary),
    ),
    trailing: const Icon(
      Icons.chevron_right,
      size: 20,
      color: MusicColors.textMuted,
    ),
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
