import 'package:flutter/material.dart';

import 'settings_controller.dart';
import 'settings_models.dart';
import 'settings_screen.dart';

class ProfileScreen extends StatefulWidget {
  const ProfileScreen({
    super.key,
    required this.controller,
    this.pickAvatar,
    this.avatar,
    this.onAccount,
  });
  final SettingsController controller;
  final Future<AvatarInput?> Function()? pickAvatar;
  final Widget? avatar;
  final VoidCallback? onAccount;
  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  late final TextEditingController name;
  String? _inputError, _photoError;
  bool _picking = false, _dirty = false;
  SettingsController get c => widget.controller;
  @override
  void initState() {
    super.initState();
    name = TextEditingController(text: c.settings?.displayName ?? '');
    c.addListener(_sync);
    if (c.settings == null) c.load();
  }

  void _sync() {
    if (!_dirty && mounted) name.text = c.settings?.displayName ?? '';
  }

  @override
  void dispose() {
    c.removeListener(_sync);
    name.dispose();
    super.dispose();
  }

  Future<void> _pick() async {
    if (_picking || !c.canEdit) return;
    setState(() {
      _picking = true;
      _photoError = null;
    });
    try {
      final image = await widget.pickAvatar!();
      if (mounted && image != null && c.isCurrent) await c.uploadAvatar(image);
    } catch (_) {
      if (mounted) {
        setState(
          () => _photoError =
              'Не удалось открыть фото. Выберите JPEG, PNG или WebP до 5 МБ.',
        );
      }
    } finally {
      if (mounted) setState(() => _picking = false);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) {
      final settings = c.settings;
      return Scaffold(
        appBar: AppBar(title: const Text('Профиль')),
        body: SafeArea(
          child: ListView(
            padding: const EdgeInsets.all(20),
            children: [
              if (c.loading) const LinearProgressIndicator(),
              if (c.failure != null)
                SettingsFailure(
                  c.failure!.message,
                  retry: settings == null ? c.load : null,
                ),
              if (settings != null) ...[
                Center(
                  child:
                      widget.avatar ??
                      CircleAvatar(
                        radius: 44,
                        child: Text(
                          (settings.displayName?.isNotEmpty ?? false)
                              ? settings.displayName!.substring(0, 1)
                              : '♪',
                          style: Theme.of(context).textTheme.headlineMedium,
                        ),
                      ),
                ),
                const SizedBox(height: 12),
                if (widget.pickAvatar != null && c.canUpload)
                  Center(
                    child: OutlinedButton.icon(
                      onPressed: c.canEdit && !_picking ? _pick : null,
                      icon: const Icon(Icons.add_a_photo_outlined),
                      label: Text(
                        _picking ? 'Подготовка фото…' : 'Выбрать фото',
                      ),
                    ),
                  ),
                if (settings.hasProfilePicture)
                  Center(
                    child: TextButton(
                      onPressed: c.canEdit
                          ? () async {
                              final yes = await showDialog<bool>(
                                context: context,
                                builder: (context) => AlertDialog(
                                  title: const Text('Удалить фото?'),
                                  content: const Text(
                                    'В профиле останется значок с первой буквой имени.',
                                  ),
                                  actions: [
                                    TextButton(
                                      onPressed: () =>
                                          Navigator.pop(context, false),
                                      child: const Text('Отмена'),
                                    ),
                                    TextButton(
                                      onPressed: () =>
                                          Navigator.pop(context, true),
                                      child: const Text('Удалить'),
                                    ),
                                  ],
                                ),
                              );
                              if (yes == true && mounted) {
                                await c.removeAvatar();
                              }
                            }
                          : null,
                      child: const Text('Удалить фото'),
                    ),
                  ),
                if (_photoError != null) SettingsFailure(_photoError!),
                const SizedBox(height: 24),
                TextField(
                  controller: name,
                  enabled: c.canEdit,
                  maxLength: 80,
                  textInputAction: TextInputAction.done,
                  decoration: InputDecoration(
                    labelText: 'Имя профиля',
                    helperText: 'Латиница, цифры, пробел, точка и дефис. До 80 символов.',
                    helperMaxLines: 5,
                    errorText: _inputError,
                  ),
                  onChanged: (value) {
                    _dirty = true;
                    setState(() => _inputError = validateDisplayName(value));
                  },
                  onSubmitted: (_) => _save(),
                ),
                const SizedBox(height: 12),
                FilledButton(
                  onPressed: c.canEdit && _inputError == null ? _save : null,
                  child: Text(c.busy ? 'Сохраняем…' : 'Сохранить имя'),
                ),
                const SizedBox(height: 32),
                Text(
                  'Приватность',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('Показывать, что я онлайн'),
                  subtitle: const Text(
                    'Другие слушатели смогут видеть ваш статус.',
                  ),
                  value: settings.shareOnlinePresence,
                  onChanged: c.canEdit
                      ? (v) =>
                            c.update(UserSettingsPatch(shareOnlinePresence: v))
                      : null,
                ),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('Показывать, что я слушаю'),
                  subtitle: const Text(
                    'Разрешить отображение прослушиваемой музыки.',
                  ),
                  value: settings.shareListeningStatus,
                  onChanged: c.canEdit
                      ? (v) =>
                            c.update(UserSettingsPatch(shareListeningStatus: v))
                      : null,
                ),
                if (widget.onAccount != null)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('Почта и пароль'),
                    subtitle: const Text('Открыть настройки безопасности'),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: widget.onAccount,
                  ),
              ],
            ],
          ),
        ),
      );
    },
  );
  Future<void> _save() async {
    setState(() => _inputError = validateDisplayName(name.text));
    if (_inputError != null) return;
    FocusScope.of(context).unfocus();
    final saved = await c.update(UserSettingsPatch(displayName: name.text));
    if (saved && mounted) {
      _dirty = false;
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Имя сохранено')));
    }
  }
}
