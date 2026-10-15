import 'package:flutter/material.dart';

import '../../core/network/api_transport.dart';
import '../../core/network/network_policy.dart';
import '../../core/session/session_authority.dart';
import 'registration_controller.dart';

class RegistrationScreen extends StatefulWidget {
  const RegistrationScreen({
    super.key,
    required this.transport,
    required this.authority,
    required this.networkPolicy,
    required this.origin,
    required this.onRegistered,
    this.enabled = true,
  });
  final ApiTransport transport;
  final SessionAuthority authority;
  final NetworkPolicy networkPolicy;
  final Uri origin;
  final VoidCallback onRegistered;
  final bool enabled;
  @override
  State<RegistrationScreen> createState() => _RegistrationScreenState();
}

class _RegistrationScreenState extends State<RegistrationScreen>
    with WidgetsBindingObserver {
  late final RegistrationController controller;
  final form = GlobalKey<FormState>();
  static const labels = {
    'inviteCode': 'Код приглашения',
    'username': 'Имя пользователя',
    'displayName': 'Отображаемое имя',
    'email': 'Электронная почта',
    'password': 'Пароль',
    'confirmPassword': 'Повторите пароль',
  };
  final fields = {for (final key in labels.keys) key: TextEditingController()};
  @override
  void initState() {
    super.initState();
    controller = RegistrationController(
      transport: widget.transport,
      authority: widget.authority,
      networkPolicy: widget.networkPolicy,
      origin: widget.origin,
      enabled: widget.enabled,
    );
    controller.addListener(changed);
    WidgetsBinding.instance.addObserver(this);
  }

  void clear() {
    for (final field in fields.values) {
      field.clear();
    }
  }

  void changed() {
    if (!mounted) return;
    if (!controller.active) clear();
    setState(() {});
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) {
      fields['password']!.clear();
      fields['confirmPassword']!.clear();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    controller.removeListener(changed);
    controller.dispose();
    for (final f in fields.values) {
      f.dispose();
    }
    super.dispose();
  }

  Future<void> submit() async {
    if (!form.currentState!.validate()) return;
    FocusScope.of(context).unfocus();
    final success = await controller.register({
      for (final e in fields.entries) e.key: e.value.text,
    });
    if (!mounted) return;
    fields['password']!.clear();
    fields['confirmPassword']!.clear();
    if (!mounted || !controller.active) return;
    if (success) {
      clear();
      widget.onRegistered();
    }
  }

  String? validate(String key, String? value) {
    if (value == null || value.trim().isEmpty) return 'Заполните поле';
    if (key == 'username' && !RegExp(r'^[a-zA-Z0-9_]{3,32}$').hasMatch(value)) {
      return '3–32: латиница, цифры, подчёркивание';
    }
    if (key == 'email' &&
        !RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$').hasMatch(value)) {
      return 'Проверьте адрес';
    }
    if (key == 'password' && (value.length < 6 || value.length > 128)) {
      return 'От 6 до 128 символов';
    }
    if (key == 'confirmPassword' && value != fields['password']!.text) {
      return 'Пароли не совпадают';
    }
    return null;
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('По приглашению')),
    body: SafeArea(
      child: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Text(
            'Присоединиться к Soundspan',
            style: Theme.of(context).textTheme.headlineSmall,
          ),
          const SizedBox(height: 12),
          const Text(
            'Укажите приглашение и данные для входа. После создания аккаунта вернитесь ко входу.',
          ),
          const SizedBox(height: 24),
          if (!controller.active)
            const Text('Регистрация недоступна в этом сеансе.')
          else
            Form(
              key: form,
              child: Column(
                children: [
                  for (final entry in labels.entries)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 16),
                      child: TextFormField(
                        controller: fields[entry.key],
                        enabled:
                            !controller.busy &&
                            !controller.uncertain &&
                            !controller.completed,
                        decoration: InputDecoration(labelText: entry.value),
                        obscureText: entry.key.toLowerCase().contains(
                          'password',
                        ),
                        enableSuggestions: false,
                        autocorrect: false,
                        maxLength: switch (entry.key) {
                          'username' => 32,
                          'displayName' => 64,
                          'password' || 'confirmPassword' => 128,
                          _ => null,
                        },
                        keyboardType: entry.key == 'email'
                            ? TextInputType.emailAddress
                            : null,
                        validator: (v) => validate(entry.key, v),
                      ),
                    ),
                  if (controller.busy) const LinearProgressIndicator(),
                  if (controller.message != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 16),
                      child: Semantics(
                        liveRegion: true,
                        child: Text(controller.message!),
                      ),
                    ),
                  SizedBox(
                    width: double.infinity,
                    child: FilledButton(
                      onPressed:
                          controller.busy ||
                              controller.uncertain ||
                              controller.completed
                          ? null
                          : submit,
                      child: const Text('Создать аккаунт'),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    ),
  );
}
