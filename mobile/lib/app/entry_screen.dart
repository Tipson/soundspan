import 'dart:async';

import 'package:flutter/material.dart';

import '../design_system/design_system.dart';
import 'entry_controller.dart';

/// Credentials remain transient; the root owns the injected broker controller.
class EntryScreen extends StatefulWidget {
  const EntryScreen({
    super.key,
    required this.controller,
    this.onBrowserLogin,
    this.onRegistration,
    this.autoLoad = true,
  });
  final EntryController controller;
  final Future<void> Function()? onBrowserLogin;
  final VoidCallback? onRegistration;
  final bool autoLoad;
  @override
  State<EntryScreen> createState() => _EntryScreenState();
}

class _EntryScreenState extends State<EntryScreen> {
  final _username = TextEditingController();
  final _password = TextEditingController();
  final _code = TextEditingController();
  late final _server = TextEditingController(
    text: widget.controller.state.origin.toString(),
  );
  bool _showPassword = false, _changeServer = false;
  String? _browserFailure;
  @override
  void initState() {
    super.initState();
    if (widget.autoLoad) unawaited(widget.controller.loadConfig());
  }

  @override
  void didUpdateWidget(EntryScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      _password.clear();
      _username.clear();
      _code.clear();
      _server.text = widget.controller.state.origin.toString();
      _browserFailure = null;
      _changeServer = false;
      if (widget.autoLoad) unawaited(widget.controller.loadConfig());
    }
  }

  Future<void> _submit() async {
    final owner = widget.controller;
    FocusManager.instance.primaryFocus?.unfocus();
    if (owner.state.requiresTwoFactor) {
      await owner.verify(_code.text);
    } else {
      await owner.login(_username.text, _password.text);
    }
    if (mounted && owner == widget.controller && owner.state.authenticated) {
      _password.clear();
      _code.clear();
    }
  }

  Future<void> _cancel() async {
    _password.clear();
    _code.clear();
    FocusManager.instance.primaryFocus?.unfocus();
    await widget.controller.cancel();
  }

  Future<void> _connect() async {
    final owner = widget.controller;
    _password.clear();
    _code.clear();
    await owner.changeServer(_server.text);
    if (mounted && owner == widget.controller && owner.state.failure == null) {
      setState(() => _changeServer = false);
    }
  }

  Future<void> _browser() async {
    final owner = widget.controller;
    final origin = owner.state.origin;
    try {
      await widget.onBrowserLogin!();
    } catch (_) {
      if (mounted &&
          owner == widget.controller &&
          origin == owner.state.origin) {
        setState(
          () =>
              _browserFailure = 'Не удалось завершить вход. Повторите попытку.',
        );
      }
    }
  }

  @override
  void dispose() {
    _password.dispose();
    _username.dispose();
    _code.dispose();
    _server.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.controller,
    builder: (context, _) {
      final state = widget.controller.state;
      final secondFactor = state.requiresTwoFactor;
      return PopScope(
        canPop: !secondFactor,
        onPopInvokedWithResult: (didPop, _) {
          if (!didPop && secondFactor) unawaited(_cancel());
        },
        child: Scaffold(
          body: SafeArea(
            child: LayoutBuilder(
              builder: (context, viewport) => SingleChildScrollView(
                keyboardDismissBehavior:
                    ScrollViewKeyboardDismissBehavior.onDrag,
                child: ConstrainedBox(
                  constraints: BoxConstraints(minHeight: viewport.maxHeight),
                  child: Center(
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 480),
                      child: Padding(
                        padding: EdgeInsets.symmetric(
                          horizontal: MusicSpace.gutter(viewport.maxWidth),
                          vertical: 32,
                        ),
                        child: AutofillGroup(
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              Row(
                                children: [
                                  Image.asset(
                                    'assets/brand-mark.png',
                                    width: 44,
                                    height: 44,
                                    excludeFromSemantics: true,
                                  ),
                                  const SizedBox(width: 12),
                                  const Expanded(
                                    child: Text(
                                      'Soundspan',
                                      style: TextStyle(
                                        fontSize: 24,
                                        fontWeight: FontWeight.w700,
                                        letterSpacing: -.6,
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 40),
                              Semantics(
                                header: true,
                                child: Text(
                                  secondFactor
                                      ? 'Ещё один шаг'
                                      : 'Музыка в вашем ритме',
                                  style: Theme.of(context)
                                      .textTheme
                                      .displaySmall,
                                ),
                              ),
                              const SizedBox(height: 12),
                              Text(
                                secondFactor
                                    ? 'Введите код из приложения-аутентификатора или резервный код.'
                                    : 'Войдите, чтобы слушать свою Волну, открывать музыку и сохранять любимое.',
                                style: Theme.of(context).textTheme.bodyLarge
                                    ?.copyWith(
                                      color: MusicColors.textSecondary,
                                    ),
                              ),
                              const SizedBox(height: 32),
                              if (_changeServer) ...[
                                TextField(
                                  key: const ValueKey('entry-server'),
                                  controller: _server,
                                  enabled: !state.busy,
                                  keyboardType: TextInputType.url,
                                  autocorrect: false,
                                  textCapitalization: TextCapitalization.none,
                                  decoration: const InputDecoration(
                                    labelText: 'Адрес сервера',
                                    hintText: 'https://music.example',
                                  ),
                                  onSubmitted: (_) => _connect(),
                                ),
                                const SizedBox(height: 16),
                                MusicButton(
                                  label: 'Подключиться',
                                  busy: state.busy,
                                  onPressed: state.busy ? null : _connect,
                                ),
                                TextButton(
                                  onPressed: state.busy
                                      ? null
                                      : () => setState(
                                          () => _changeServer = false,
                                        ),
                                  child: const Text('Отмена'),
                                ),
                              ] else if (state.config == null) ...[
                                if (state.busy)
                                  const MusicLoadingState(
                                    label: 'Подключаемся к вашему серверу',
                                  )
                                else
                                  MusicButton(
                                    label: 'Повторить подключение',
                                    onPressed: widget.controller.canRequest
                                        ? widget.controller.loadConfig
                                        : null,
                                  ),
                              ] else if (secondFactor) ...[
                                TextField(
                                  key: const ValueKey('entry-code'),
                                  controller: _code,
                                  enabled: !state.busy,
                                  autofocus: true,
                                  autocorrect: false,
                                  autofillHints: const [
                                    AutofillHints.oneTimeCode,
                                  ],
                                  textInputAction: TextInputAction.done,
                                  decoration: const InputDecoration(
                                    labelText: 'Код подтверждения',
                                    helperText: '6 цифр или резервный код из 8 символов',
                                  ),
                                  onSubmitted: (_) => _submit(),
                                ),
                                const SizedBox(height: 24),
                                MusicButton(
                                  key: const ValueKey('entry-submit'),
                                  label: 'Подтвердить',
                                  busy: state.busy,
                                  onPressed: widget.controller.canRequest
                                      ? _submit
                                      : null,
                                ),
                                const SizedBox(height: 8),
                                TextButton(
                                  onPressed: _cancel,
                                  child: const Text('Вернуться ко входу'),
                                ),
                              ] else ...[
                                if (state.config!.localLoginEnabled) ...[
                                  TextField(
                                    key: const ValueKey('entry-username'),
                                    controller: _username,
                                    enabled: !state.busy,
                                    autofillHints: const [
                                      AutofillHints.username,
                                    ],
                                    autocorrect: false,
                                    textInputAction: TextInputAction.next,
                                    decoration: const InputDecoration(
                                      labelText: 'Логин',
                                    ),
                                  ),
                                  const SizedBox(height: 16),
                                  TextField(
                                    key: const ValueKey('entry-password'),
                                    controller: _password,
                                    enabled: !state.busy,
                                    obscureText: !_showPassword,
                                    autocorrect: false,
                                    enableSuggestions: false,
                                    autofillHints: const [
                                      AutofillHints.password,
                                    ],
                                    textInputAction: TextInputAction.done,
                                    decoration: InputDecoration(
                                      labelText: 'Пароль',
                                      suffixIcon: MusicIconButton(
                                        label: _showPassword
                                            ? 'Скрыть пароль'
                                            : 'Показать пароль',
                                        icon: _showPassword
                                            ? Icons.visibility_off_outlined
                                            : Icons.visibility_outlined,
                                        onPressed: () => setState(
                                          () => _showPassword = !_showPassword,
                                        ),
                                      ),
                                    ),
                                    onSubmitted: (_) => _submit(),
                                  ),
                                  const SizedBox(height: 24),
                                  MusicButton(
                                    key: const ValueKey('entry-submit'),
                                    label: 'Войти',
                                    icon: Icons.arrow_forward_rounded,
                                    busy: state.busy,
                                    onPressed: widget.controller.canRequest
                                        ? _submit
                                        : null,
                                  ),
                                ],
                                if (state.config!.oidcEnabled) ...[
                                  const SizedBox(height: 16),
                                  if (widget.onBrowserLogin != null)
                                    MusicButton(
                                      label:
                                          'Войти через ${state.config!.oidcProviderName}',
                                      tonal: true,
                                      onPressed: state.busy ? null : _browser,
                                    )
                                  else
                                    const MusicStatus(
                                      message: 'Этот сервер использует единый вход, который недоступен в этой сборке. Выберите сервер с входом по паролю.',
                                    ),
                                ],
                                if (!state.config!.localLoginEnabled &&
                                    !state.config!.oidcEnabled)
                                  const MusicStatus(
                                    message: 'Сервер отключил все способы входа. Выберите другой сервер.',
                                  ),
                                if (widget.onRegistration != null)
                                  TextButton(
                                    onPressed: state.busy
                                        ? null
                                        : widget.onRegistration,
                                    child: const Text(
                                      'Есть приглашение? Создать аккаунт',
                                    ),
                                  ),
                              ],
                              if (state.failure != null)
                                MusicStatus(
                                  message: state.failure!.message,
                                  error: true,
                                ),
                              if (widget.controller.retryRemaining >
                                  Duration.zero)
                                MusicStatus(
                                  message:
                                      'Повторить можно через ${widget.controller.retryRemaining.inSeconds + 1} с.',
                                ),
                              if (_browserFailure != null)
                                MusicStatus(
                                  message: _browserFailure!,
                                  error: true,
                                ),
                              if (!secondFactor && !_changeServer) ...[
                                const SizedBox(height: 24),
                                TextButton(
                                  onPressed: state.busy
                                      ? null
                                      : () => setState(
                                          () => _changeServer = true,
                                        ),
                                  child: Column(
                                    children: [
                                      const Text('Изменить сервер'),
                                      const SizedBox(height: 4),
                                      Text(
                                        state.origin.host,
                                        maxLines: 2,
                                        overflow: TextOverflow.ellipsis,
                                        style: Theme.of(context)
                                            .textTheme
                                            .bodySmall
                                            ?.copyWith(
                                              color: MusicColors.textMuted,
                                            ),
                                      ),
                                    ],
                                  ),
                                ),
                              ],
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    },
  );
}
