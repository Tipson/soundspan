import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'account_controller.dart';
import 'account_repository.dart';

class AccountPage extends StatelessWidget {
  const AccountPage({
    super.key,
    required this.controller,
    required this.title,
    required this.children,
  });
  final AccountController controller;
  final String title;
  final List<Widget> Function() children;
  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: controller,
    builder: (context, _) => Scaffold(
      appBar: AppBar(
        title: Text(title),
        actions: [
          IconButton(
            tooltip: 'Обновить данные',
            onPressed:
                controller.active && !controller.busy && !controller.loading
                ? controller.load
                : null,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: SafeArea(
        child: ListView(
          padding: EdgeInsets.all(
            MediaQuery.sizeOf(context).width < 360 ? 16 : 20,
          ),
          children: [
            if (controller.loading || controller.busy)
              const LinearProgressIndicator(),
            if (controller.message != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 16),
                child: Semantics(
                  liveRegion: true,
                  child: Text(controller.message!),
                ),
              ),
            if (!controller.repository.interactive)
              const Text('Войдите с паролем для управления безопасностью.'),
            if (!controller.repository.networkPolicy.networkAllowed)
              const Text('В офлайн-режиме настройки безопасности недоступны.'),
            if (controller.active)
              ...children()
            else
              const Text('Этот экран относится к завершённому сеансу.'),
          ],
        ),
      ),
    ),
  );
}

class AccountField {
  const AccountField(
    this.name,
    this.label, {
    this.secret = false,
    this.maxLength,
    this.keyboardType,
  });
  final String name, label;
  final bool secret;
  final int? maxLength;
  final TextInputType? keyboardType;
}

/// Every modal observes the original controller and removes its own route only.
Future<void> showAccountForm(
  BuildContext context,
  AccountController controller, {
  required String title,
  required List<AccountField> fields,
  required AccountAction action,
  Map<String, Object?> fixed = const {},
  String? explanation,
}) async {
  if (!controller.canMutate) return;
  await showDialog<void>(
    context: context,
    builder: (_) => _AccountDialog(
      controller: controller,
      title: title,
      fields: fields,
      action: action,
      fixed: fixed,
      explanation: explanation,
    ),
  );
}

Future<void> showAccountSecret(
  BuildContext context,
  AccountController controller,
) async {
  if (!controller.canRevealSecret) return;
  await showDialog<void>(
    context: context,
    barrierDismissible: false,
    builder: (_) => _AccountDialog(
      controller: controller,
      title: 'Сохраните секрет',
      fields: const [],
      secretMode: true,
    ),
  );
}

class _AccountDialog extends StatefulWidget {
  const _AccountDialog({
    required this.controller,
    required this.title,
    required this.fields,
    this.action,
    this.fixed = const {},
    this.explanation,
    this.secretMode = false,
  });
  final AccountController controller;
  final String title;
  final List<AccountField> fields;
  final AccountAction? action;
  final Map<String, Object?> fixed;
  final String? explanation;
  final bool secretMode;
  @override
  State<_AccountDialog> createState() => _AccountDialogState();
}

class _AccountDialogState extends State<_AccountDialog>
    with WidgetsBindingObserver {
  final formKey = GlobalKey<FormState>();
  late final Map<String, TextEditingController> fields;
  final token = TextEditingController();
  bool _closing = false;
  late bool _showSecret;
  @override
  void initState() {
    super.initState();
    _showSecret = widget.secretMode;
    fields = {for (final f in widget.fields) f.name: TextEditingController()};
    widget.controller.addListener(_changed);
    WidgetsBinding.instance.addObserver(this);
  }

  void _changed() {
    if (!mounted || _closing) return;
    if (!widget.controller.active ||
        (_showSecret && widget.controller.secret == null)) {
      for (final field in fields.values) {
        field.clear();
      }
      token.clear();
      _closing = true;
      final route = ModalRoute.of(context);
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && route != null && route.isActive) {
          Navigator.of(context).removeRoute(route);
        }
      });
    }
    setState(() {});
  }

  void _beginClosing() {
    if (_closing) return;
    // PopScope runs on successful route dismissal, before reverse animation
    // disposal. Revoke the pending operation's reveal permission immediately.
    _closing = true;
    widget.controller.clearSecret(notify: false);
    for (final field in fields.values) {
      field.clear();
    }
    token.clear();
    setState(() {});
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) {
      widget.controller.clearSecret();
      for (final field in fields.values) {
        field.clear();
      }
      token.clear();
    }
  }

  @override
  void dispose() {
    widget.controller.removeListener(_changed);
    WidgetsBinding.instance.removeObserver(this);
    for (final field in fields.values) {
      field.dispose();
    }
    token.dispose();
    widget.controller.clearSecret(notify: false);
    super.dispose();
  }

  Future<void> submit() async {
    if (!(formKey.currentState?.validate() ?? false)) return;
    final input = <String, Object?>{
      ...widget.fixed,
      for (final f in widget.fields) f.name: fields[f.name]!.text,
    };
    if (input.containsKey('confirmPassword')) {
      if (input['newPassword'] != input.remove('confirmPassword')) {
        setState(() {
          widget.controller.message = 'Пароли не совпадают';
        });
        return;
      }
    }
    final ok = await widget.controller.perform(widget.action!, input);
    if (!mounted || _closing) return;
    for (final field in fields.values) {
      field.clear();
    }
    if (!mounted || !widget.controller.active || !ok) return;
    if (widget.controller.secret != null) {
      setState(() {
        _showSecret = true;
      });
      return;
    }
    final route = ModalRoute.of(context)!;
    if (route.isCurrent) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    final secret = !_closing && c.canRevealSecret ? c.secret : null;
    return PopScope<void>(
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) _beginClosing();
      },
      child: AlertDialog(
        scrollable: true,
        title: Text(
          _showSecret && secret?['kind'] == 'setup'
              ? 'Добавьте в аутентификатор'
              : widget.title,
        ),
        content: SizedBox(
          width: 440,
          child: Form(
            key: formKey,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (widget.explanation != null)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 16),
                    child: Text(widget.explanation!),
                  ),
                if (_showSecret && secret != null) ...[
                  const Text(
                    'Показывается только сейчас. Сохраните в надёжном месте перед закрытием.',
                  ),
                  const SizedBox(height: 16),
                  Text(
                    secret['value'] as String,
                    style: Theme.of(context).textTheme.bodyLarge,
                  ),
                  TextButton.icon(
                    onPressed: () {
                      if (c.canRevealSecret) {
                        Clipboard.setData(
                          ClipboardData(text: c.secret!['value'] as String),
                        );
                      }
                    },
                    icon: const Icon(Icons.copy),
                    label: const Text('Копировать'),
                  ),
                  if (secret['kind'] == 'setup') ...[
                    TextFormField(
                      controller: token,
                      decoration: const InputDecoration(
                        labelText: 'Код из приложения',
                      ),
                      keyboardType: TextInputType.number,
                      autocorrect: false,
                      enableSuggestions: false,
                      maxLength: 6,
                      validator: (v) => RegExp(r'^\d{6}$').hasMatch(v ?? '')
                          ? null
                          : 'Введите 6 цифр',
                    ),
                    FilledButton(
                      onPressed: c.canMutate
                          ? () async {
                              if (formKey.currentState!.validate()) {
                                await c.perform(AccountAction.enable2fa, {
                                  'secret': c.secret!['value'],
                                  'token': token.text,
                                });
                                if (!mounted || _closing || !c.foreground) {
                                  return;
                                }
                                token.clear();
                              }
                            }
                          : null,
                      child: const Text('Подтвердить и включить'),
                    ),
                  ],
                ],
                for (final f
                    in (_showSecret ? <AccountField>[] : widget.fields))
                  Padding(
                    padding: const EdgeInsets.only(bottom: 16),
                    child: TextFormField(
                      controller: fields[f.name],
                      obscureText: f.secret,
                      enableSuggestions: !f.secret,
                      autocorrect: !f.secret,
                      keyboardType: f.keyboardType,
                      maxLength: f.maxLength,
                      decoration: InputDecoration(labelText: f.label),
                      validator: (value) {
                        if (value == null || value.trim().isEmpty) {
                          return 'Заполните поле';
                        }
                        if (f.name == 'newPassword' && value.length < 6) {
                          return 'Не менее 6 символов';
                        }
                        if (f.name == 'email' &&
                            !RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$')
                                .hasMatch(value)) {
                          return 'Проверьте адрес';
                        }
                        return null;
                      },
                    ),
                  ),
                if (c.message != null)
                  Semantics(liveRegion: true, child: Text(c.message!)),
                if (c.busy) const LinearProgressIndicator(),
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () {
              c.clearSecret();
              Navigator.of(context).pop();
            },
            child: const Text('Закрыть'),
          ),
          if (!_showSecret)
            FilledButton(
              onPressed: c.canMutate ? submit : null,
              child: const Text('Подтвердить'),
            ),
        ],
      ),
    );
  }
}

Widget accountTile(
  String title,
  String subtitle,
  IconData icon,
  VoidCallback? onTap,
) => Padding(
  padding: const EdgeInsets.only(bottom: 8),
  child: ListTile(
    minTileHeight: 64,
    contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
    leading: Icon(icon),
    title: Text(title),
    subtitle: Text(subtitle),
    trailing: const Icon(Icons.chevron_right),
    onTap: onTap,
  ),
);
