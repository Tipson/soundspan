import 'package:flutter/material.dart';
import 'package:soundspan/design_system/theme.dart';
import 'package:soundspan/features/shares/native_share_actions.dart';

// Synthetic chooser acceptance only: no account, HTTP or share creation.
void main() =>
    runApp(MaterialApp(theme: SoundspanTheme.dark(), home: const _Preview()));

class _Preview extends StatelessWidget {
  const _Preview();
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Проверка системного выбора')),
    body: Center(
      child: FilledButton(
        onPressed: () => const NativeShareActions().share(
          Uri.parse('https://share-fixture.invalid/share/${'a' * 64}'),
        ),
        child: const Text('Открыть выбор приложения'),
      ),
    ),
  );
}
