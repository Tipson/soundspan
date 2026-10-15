import 'package:flutter/material.dart';

import '../../design_system/design_system.dart';
import '../../playback/wave_selection.dart';

String waveModeLabel(WaveMode mode) => switch (mode) {
  WaveMode.forYou => 'Для вас',
  WaveMode.newMusic => 'Новое',
  WaveMode.familiar => 'Знакомое',
};
String waveMoodLabel(WaveMood? mood) => switch (mood) {
  null => 'Без настроения',
  WaveMood.calm => 'Спокойно',
  WaveMood.energetic => 'Энергично',
  WaveMood.focus => 'Сосредоточиться',
  WaveMood.workout => 'Тренировка',
  WaveMood.favorites => 'Любимое',
  WaveMood.forgotten => 'Забытое',
};
String waveLanguageLabel(WaveLanguage language) => switch (language) {
  WaveLanguage.any => 'Любой язык',
  WaveLanguage.ru => 'Русский',
  WaveLanguage.foreign => 'Иностранный',
};

/// Local draft only. Dismiss, Back and Escape return null without a service call.
class WaveDirectionSheet extends StatefulWidget {
  const WaveDirectionSheet({super.key, required this.initial});
  final WaveSelection initial;
  static Future<WaveSelection?> show(
    BuildContext context,
    WaveSelection initial,
  ) => showModalBottomSheet<WaveSelection>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (_) => WaveDirectionSheet(initial: initial),
  );
  @override
  State<WaveDirectionSheet> createState() => _WaveDirectionSheetState();
}

class _WaveDirectionSheetState extends State<WaveDirectionSheet> {
  late WaveSelection _draft;
  @override
  void initState() {
    super.initState();
    _draft = widget.initial;
  }

  Widget _choices<T>(
    String title,
    List<T> values,
    T current,
    String Function(T) label,
    void Function(T) select,
  ) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      Semantics(
        header: true,
        child: Text(title, style: Theme.of(context).textTheme.titleLarge),
      ),
      const SizedBox(height: 12),
      Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          for (final item in values)
            ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 48),
              child: ChoiceChip(
                label: Text(label(item)),
                selected: item == current,
                onSelected: (_) => setState(() => select(item)),
              ),
            ),
        ],
      ),
      const SizedBox(height: 24),
    ],
  );
  @override
  Widget build(BuildContext context) => FractionallySizedBox(
    heightFactor: .92,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 12, 12, 8),
          child: Row(
            children: [
              Expanded(
                child: Semantics(
                  header: true,
                  child: Text(
                    'Настроить волну',
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                ),
              ),
              MusicIconButton(
                label: 'Закрыть без изменений',
                icon: Icons.close,
                onPressed: () => Navigator.pop(context),
              ),
            ],
          ),
        ),
        Expanded(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 0),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _choices(
                  'Направление',
                  WaveMode.values,
                  _draft.mode,
                  waveModeLabel,
                  (mode) => _draft = WaveSelection(
                    mode: mode,
                    mood: _draft.mood,
                    language: _draft.language,
                  ),
                ),
                _choices<WaveMood?>(
                  'Настроение и контекст',
                  [null, ...WaveMood.values],
                  _draft.mood,
                  waveMoodLabel,
                  (mood) => _draft = WaveSelection(
                    mode: _draft.mode,
                    mood: mood,
                    language: _draft.language,
                  ),
                ),
                _choices(
                  'Язык песен',
                  WaveLanguage.values,
                  _draft.language,
                  waveLanguageLabel,
                  (language) => _draft = WaveSelection(
                    mode: _draft.mode,
                    mood: _draft.mood,
                    language: language,
                  ),
                ),
                const Text(
                  'Изменения начнут новую подборку после нажатия «Применить».',
                ),
                const SizedBox(height: 16),
              ],
            ),
          ),
        ),
        SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(20, 12, 20, 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                MusicButton(
                  label: 'Применить',
                  onPressed: () => Navigator.pop(context, _draft),
                ),
                TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('Отмена'),
                ),
              ],
            ),
          ),
        ),
      ],
    ),
  );
}
