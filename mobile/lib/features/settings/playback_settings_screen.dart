import 'package:flutter/material.dart';

import 'settings_controller.dart';
import 'settings_models.dart';
import 'settings_screen.dart';

class PlaybackSettingsScreen extends StatelessWidget {
  const PlaybackSettingsScreen({
    super.key,
    required this.controller,
    this.gainAvailable = false,
  });
  final SettingsController controller;
  final bool gainAvailable;
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) {
      final c = controller;
      return Scaffold(
        appBar: AppBar(title: const Text('Воспроизведение')),
        body: SafeArea(
          child: ListView(
            padding: const EdgeInsets.all(20),
            children: [
              Text(
                'Качество на устройстве',
                style: Theme.of(context).textTheme.titleLarge,
              ),
              const SizedBox(height: 8),
              const Text(
                'Выбор применяется к следующим потокам. Доступность качества зависит от источника; оригинал не всегда означает lossless.',
              ),
              const SizedBox(height: 16),
              for (final item in const {
                'original': 'Оригинальное',
                'high': 'Высокое · 320 кбит/с',
                'medium': 'Среднее · 192 кбит/с',
                'low': 'Экономное · 128 кбит/с',
              }.entries)
                _choice(
                  context,
                  item.value,
                  c.quality.value == item.key,
                  c.canEdit ? () => c.changeQuality(item.key) : null,
                ),
              const Divider(height: 40),
              Text(
                'Ровная громкость',
                style: Theme.of(context).textTheme.titleLarge,
              ),
              const SizedBox(height: 8),
              const Text(
                'Выравнивание по измеренной громкости трека или альбома. Для записей без измерений звук остаётся без изменений.',
              ),
              if (!gainAvailable)
                const SettingsFailure(
                  'Нормализация недоступна на этой платформе.',
                ),
              if (c.loading) const LinearProgressIndicator(),
              if (c.settings != null)
                for (final mode in LoudnessMode.values)
                  _choice(
                    context,
                    switch (mode) {
                      LoudnessMode.off => 'Выключено',
                      LoudnessMode.track => 'По треку',
                      LoudnessMode.album => 'По альбому',
                      LoudnessMode.auto => 'Автоматически',
                    },
                    c.loudnessMode == mode,
                    c.canEdit && gainAvailable
                        ? () => c.update(UserSettingsPatch(loudnessMode: mode))
                        : null,
                  ),
              const SizedBox(height: 8),
              const Text(
                'Автоматический режим сохраняет динамику альбома при воспроизведении по порядку.',
              ),
              if (c.failure != null)
                SettingsFailure(
                  c.failure!.message,
                  retry: c.settings == null ? c.load : null,
                ),
            ],
          ),
        ),
      );
    },
  );
  Widget _choice(
    BuildContext context,
    String title,
    bool selected,
    VoidCallback? action,
  ) => Semantics(
    selected: selected,
    child: ListTile(
      contentPadding: EdgeInsets.zero,
      title: Text(title),
      trailing: Icon(
        selected ? Icons.radio_button_checked : Icons.radio_button_off,
        color: selected ? Theme.of(context).colorScheme.primary : null,
      ),
      onTap: action,
      enabled: action != null,
    ),
  );
}
