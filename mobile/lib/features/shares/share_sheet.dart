import 'dart:async';

import 'package:flutter/material.dart';

import 'native_share_actions.dart';
import 'share_controller.dart';
import 'share_models.dart';

/// Opening this route only reads links. Creating a bearer grant is explicit.
class ShareSheet extends StatefulWidget {
  const ShareSheet({
    super.key,
    required this.controller,
    this.resource,
    this.assertTarget,
    this.targetCurrent,
    this.actions = const NativeShareActions(),
    this.autoLoad = true,
  });
  final ShareController controller;
  final ShareResource? resource;
  final Future<void> Function()? assertTarget;
  final bool Function()? targetCurrent;
  final NativeShareActions actions;
  final bool autoLoad;
  @override
  State<ShareSheet> createState() => _ShareSheetState();
}

class _ShareSheetState extends State<ShareSheet> {
  final _max = TextEditingController();
  int _days = 7;
  String? _localMessage;
  bool get _current =>
      mounted &&
      widget.controller.isCurrent &&
      (ModalRoute.of(context)?.isCurrent ?? true);
  @override
  void initState() {
    super.initState();
    if (widget.autoLoad) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_current) {
          unawaited(widget.controller.load(current: () => _current));
        }
      });
    }
  }

  @override
  void dispose() {
    _max.dispose();
    unawaited(widget.controller.close());
    super.dispose();
  }

  Future<bool> _confirm(String title, String message, String action) async =>
      await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(title),
          content: SingleChildScrollView(child: Text(message)),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Отмена'),
            ),
            TextButton(
              onPressed: () => Navigator.pop(context, true),
              child: Text(action),
            ),
          ],
        ),
      ) ==
      true;
  Future<void> _create() async {
    final c = widget.controller, resource = widget.resource;
    if (!_current || c.busy || resource == null) return;
    final raw = _max.text.trim(), limit = int.tryParse(_max.text.trim());
    if (raw.isNotEmpty && (limit == null || limit < 1 || limit > 2147483647)) {
      setState(() => _localMessage = invalidShareOptions.message);
      return;
    }
    try {
      await widget.assertTarget?.call();
      if (!_current || c != widget.controller) return;
      await c.create(
        ShareDraft(
          resource,
          maxPlays: limit,
          expiresAt: _days == 0
              ? null
              : DateTime.now().add(Duration(days: _days)),
        ),
        current: () =>
            _current &&
            c == widget.controller &&
            widget.targetCurrent?.call() != false,
      );
    } catch (_) {
      if (_current) {
        setState(
          () => _localMessage = 'Объект изменился. Откройте действие снова.',
        );
      }
    }
  }

  Future<void> _revoke(ShareLink link) async {
    final c = widget.controller;
    if (!_current || c.busy) return;
    if (await _confirm(
          'Отозвать ссылку?',
          'Ссылка перестанет открывать эту музыку для получателей.',
          'Отозвать',
        ) &&
        _current) {
      await c.revoke(link, current: () => _current && c == widget.controller);
    }
  }

  Future<void> _acknowledge() async {
    final c = widget.controller;
    if (!_current || !c.canAcknowledge) return;
    if (await _confirm(
          'Разрешить новую попытку?',
          'Проверьте список ссылок. Предыдущая попытка могла завершиться на сервере; новая может создать дополнительную ссылку. Ничего не создаётся автоматически.',
          'Я проверил список',
        ) &&
        _current) {
      await c.acknowledgeUncertainty(
        current: () => _current && c == widget.controller,
      );
    }
  }

  Future<void> _use(
    ShareLink link,
    Future<void> Function(Uri) action,
    String message,
  ) async {
    final c = widget.controller;
    if (!_current || c.busy) return;
    await c.useLink(
      link,
      action,
      current: () => _current && c == widget.controller,
    );
    if (_current && c.failure == null) setState(() => _localMessage = message);
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final c = widget.controller;
      final enabled = c.canRead && !c.busy;
      return Scaffold(
        appBar: AppBar(
          title: Text(
            widget.resource == null ? 'Мои ссылки' : 'Поделиться музыкой',
          ),
        ),
        body: SafeArea(
          child: CustomScrollView(
            slivers: [
              SliverPadding(
                padding: const EdgeInsets.all(20),
                sliver: SliverToBoxAdapter(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Text(
                        widget.resource?.title ?? 'Музыка по ссылке',
                        style: Theme.of(context).textTheme.headlineMedium,
                      ),
                      const SizedBox(height: 12),
                      const Text(
                        'Любой получивший ссылку сможет открыть музыку. Ссылку можно отозвать здесь. Открытие в браузере может расходовать сеанс доступа.',
                      ),
                      if (widget.resource != null) ...[
                        const SizedBox(height: 20),
                        DropdownButtonFormField<int>(
                          initialValue: _days,
                          isExpanded: true,
                          decoration: const InputDecoration(
                            labelText: 'Срок ссылки',
                          ),
                          items: const [
                            DropdownMenuItem(value: 1, child: Text('1 день')),
                            DropdownMenuItem(value: 7, child: Text('7 дней')),
                            DropdownMenuItem(value: 30, child: Text('30 дней')),
                            DropdownMenuItem(
                              value: 0,
                              child: Text('Без срока'),
                            ),
                          ],
                          onChanged: enabled
                              ? (v) => setState(() => _days = v ?? 7)
                              : null,
                        ),
                        const SizedBox(height: 16),
                        TextField(
                          controller: _max,
                          enabled: enabled,
                          keyboardType: TextInputType.number,
                          decoration: const InputDecoration(
                            labelText: 'Лимит сеансов доступа',
                            helperText: 'Необязательно. Сервер объединяет обращения в часовые сеансы.',
                            helperMaxLines: 4,
                          ),
                        ),
                        const SizedBox(height: 16),
                        FilledButton(
                          onPressed: enabled && !c.uncertain ? _create : null,
                          child: const Text('Создать ссылку'),
                        ),
                      ],
                      if (!c.canRead)
                        const Padding(
                          padding: EdgeInsets.only(top: 12),
                          child: Text(
                            'Для управления ссылками нужна сеть и действующий сеанс.',
                          ),
                        ),
                      if (c.busy)
                        const Padding(
                          padding: EdgeInsets.symmetric(vertical: 12),
                          child: LinearProgressIndicator(),
                        ),
                      for (final text in [
                        ?_localMessage,
                        if (c.message != null) c.message!,
                        if (c.failure != null) c.failure!.message,
                      ])
                        Padding(
                          padding: const EdgeInsets.only(top: 12),
                          child: Text(text),
                        ),
                      const SizedBox(height: 12),
                      OutlinedButton.icon(
                        onPressed: enabled
                            ? () => c.load(current: () => _current)
                            : null,
                        icon: const Icon(Icons.refresh),
                        label: const Text('Обновить мои ссылки'),
                      ),
                      if (c.canAcknowledge)
                        TextButton(
                          onPressed: enabled ? _acknowledge : null,
                          child: const Text('Разрешить новую попытку'),
                        ),
                      const Divider(height: 32),
                      Text(
                        'Существующие ссылки',
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                      if (c.links.isEmpty && !c.busy)
                        const Padding(
                          padding: EdgeInsets.only(top: 16),
                          child: Text('Ссылок пока нет.'),
                        ),
                    ],
                  ),
                ),
              ),
              SliverList.builder(
                itemCount: c.links.length,
                itemBuilder: (context, index) {
                  final link = c.links[index],
                      available = linkAvailable(c.links[index]);
                  return Padding(
                    padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
                    child: Card(
                      child: Padding(
                        padding: const EdgeInsets.all(16),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            Text(
                              '${switch (link.kind) {
                                ShareResourceKind.track => 'Трек',
                                ShareResourceKind.album => 'Альбом',
                                ShareResourceKind.playlist => 'Плейлист',
                              }} · ${link.resourceId}',
                              style: Theme.of(context).textTheme.titleMedium,
                            ),
                            const SizedBox(height: 8),
                            Text(
                              link.expiresAt == null
                                  ? 'Без срока действия'
                                  : 'До ${link.expiresAt!.toLocal().toString().substring(0, 16)}',
                            ),
                            Text(
                              link.maxPlays == null
                                  ? 'Без лимита сеансов'
                                  : 'Сеансы: ${link.playCount} из ${link.maxPlays}',
                            ),
                            if (!available)
                              const Text(
                                'Ссылка недоступна: срок или лимит исчерпан. Текущий сеанс сервера может ещё действовать.',
                              ),
                            const SizedBox(height: 8),
                            TextButton.icon(
                              onPressed: enabled && available
                                  ? () => _use(
                                      link,
                                      widget.actions.copy,
                                      'Ссылка скопирована.',
                                    )
                                  : null,
                              icon: const Icon(Icons.copy),
                              label: const Text('Копировать ссылку'),
                            ),
                            if (widget.actions.supportsNative) ...[
                              TextButton.icon(
                                onPressed: enabled && available
                                    ? () => _use(
                                        link,
                                        widget.actions.share,
                                        'Открыт выбор приложения. Отправку выполняете вы.',
                                      )
                                    : null,
                                icon: const Icon(Icons.share_outlined),
                                label: const Text('Поделиться ссылкой'),
                              ),
                              TextButton.icon(
                                onPressed: enabled && available
                                    ? () => _use(
                                        link,
                                        widget.actions.open,
                                        'Открыт браузер.',
                                      )
                                    : null,
                                icon: const Icon(Icons.open_in_browser),
                                label: const Text('Открыть в браузере'),
                              ),
                            ],
                            TextButton.icon(
                              onPressed: enabled ? () => _revoke(link) : null,
                              icon: const Icon(Icons.link_off),
                              label: const Text('Отозвать ссылку'),
                            ),
                          ],
                        ),
                      ),
                    ),
                  );
                },
              ),
              const SliverToBoxAdapter(child: SizedBox(height: 24)),
            ],
          ),
        ),
      );
    },
  );
  bool linkAvailable(ShareLink link) => link.available(DateTime.now());
}
