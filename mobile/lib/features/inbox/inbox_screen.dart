import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'inbox_controller.dart';
import 'inbox_models.dart';

class InboxScreen extends StatefulWidget {
  const InboxScreen({
    super.key,
    required this.controller,
    this.onOpen,
    this.foreground,
    this.autoLoad = true,
  });
  final InboxController controller;
  final Future<void> Function(InboxDestination)? onOpen;
  final ValueListenable<bool>? foreground;
  final bool autoLoad;
  @override
  State<InboxScreen> createState() => _InboxScreenState();
}

class _InboxScreenState extends State<InboxScreen> with WidgetsBindingObserver {
  bool _resumed = true, _wasVisible = false;
  bool get _visible =>
      mounted &&
      _resumed &&
      widget.controller.isCurrent &&
      widget.foreground?.value != false &&
      TickerMode.valuesOf(context).enabled &&
      (ModalRoute.of(context)?.isCurrent ?? true);
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _resumed =
        WidgetsBinding.instance.lifecycleState == null ||
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
    widget.foreground?.addListener(_exposure);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    ModalRoute.isCurrentOf(context);
    _exposure();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _resumed = state == AppLifecycleState.resumed;
    _exposure();
  }

  void _exposure() {
    final visible = _visible;
    if (visible && !_wasVisible && widget.autoLoad) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_visible && !widget.controller.busy) {
          unawaited(widget.controller.load(current: () => _visible));
        }
      });
      WidgetsBinding.instance.ensureVisualUpdate();
    }
    _wasVisible = visible;
  }

  @override
  void dispose() {
    widget.foreground?.removeListener(_exposure);
    WidgetsBinding.instance.removeObserver(this);
    unawaited(widget.controller.close());
    super.dispose();
  }

  Future<void> _mutate(InboxAction action, [String? id]) async {
    final c = widget.controller;
    if (!_visible || c.busy) return;
    if (action == InboxAction.clear || action == InboxAction.clearAll) {
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(
            action == InboxAction.clearAll
                ? 'Очистить все уведомления?'
                : 'Скрыть уведомление?',
          ),
          content: const Text(
            'Уведомления исчезнут из входящих на сервере. Музыка и загрузки останутся.',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Отмена'),
            ),
            TextButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Очистить'),
            ),
          ],
        ),
      );
      if (confirmed != true || !_visible || c != widget.controller) return;
    }
    await c.mutate(
      action,
      id: id,
      current: () => _visible && c == widget.controller,
    );
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final c = widget.controller, enabled = c.canRead && !c.busy;
      return Scaffold(
        appBar: AppBar(title: const Text('Входящие')),
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
                        'События вашей библиотеки',
                        style: Theme.of(context).textTheme.headlineMedium,
                      ),
                      const SizedBox(height: 12),
                      const Text(
                        'Последние 100 неочищенных уведомлений сервера. Обновляются при открытии и возвращении в приложение.',
                      ),
                      const SizedBox(height: 8),
                      Text('Непрочитанных на сервере: ${c.unread}'),
                      OutlinedButton.icon(
                        onPressed: enabled
                            ? () => c.load(current: () => _visible)
                            : null,
                        icon: const Icon(Icons.refresh),
                        label: const Text('Обновить'),
                      ),
                      TextButton(
                        onPressed: enabled && !c.needsRefresh
                            ? () => _mutate(InboxAction.readAll)
                            : null,
                        child: const Text('Прочитать все'),
                      ),
                      TextButton(
                        onPressed: enabled && !c.needsRefresh
                            ? () => _mutate(InboxAction.clearAll)
                            : null,
                        child: const Text('Очистить все'),
                      ),
                      if (c.busy) const LinearProgressIndicator(),
                      if (!c.canRead)
                        const Text(
                          'Для входящих нужна сеть и действующий сеанс.',
                        ),
                      if (c.message != null) Text(c.message!),
                      if (c.failure != null) Text(c.failure!.message),
                      if (c.skipped > 0)
                        Text(
                          'Часть записей не удалось прочитать: ${c.skipped}.',
                        ),
                      if (c.entries.isEmpty && !c.busy)
                        const Padding(
                          padding: EdgeInsets.symmetric(vertical: 24),
                          child: Text('Здесь пока тихо.'),
                        ),
                    ],
                  ),
                ),
              ),
              SliverList.builder(
                itemCount: c.entries.length,
                itemBuilder: (context, index) {
                  final entry = c.entries[index];
                  return Padding(
                    padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
                    child: Card(
                      child: Padding(
                        padding: const EdgeInsets.all(16),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            Text(
                              entry.title,
                              style: Theme.of(context).textTheme.titleMedium,
                            ),
                            Text(entry.read ? 'Прочитано' : 'Новое'),
                            if (entry.message != null)
                              Padding(
                                padding: const EdgeInsets.symmetric(
                                  vertical: 8,
                                ),
                                child: Text(entry.message!),
                              ),
                            if (entry.serverAcquisition)
                              const Text(
                                'Готово в библиотеке на сервере. Чтобы слушать без сети на телефоне, скачайте музыку в Загрузках.',
                              ),
                            Text(
                              entry.createdAt?.toLocal().toString().substring(
                                    0,
                                    16,
                                  ) ??
                                  'Дата неизвестна',
                            ),
                            if (entry.destination != null &&
                                widget.onOpen != null)
                              TextButton.icon(
                                onPressed: enabled
                                    ? () => c
                                          .open(
                                            entry,
                                            widget.onOpen!,
                                            current: () => _visible,
                                          )
                                          .catchError((Object _) {})
                                    : null,
                                icon: const Icon(Icons.open_in_new),
                                label: const Text('Открыть в библиотеке'),
                              ),
                            if (!entry.read)
                              TextButton(
                                onPressed: enabled && !c.needsRefresh
                                    ? () => _mutate(InboxAction.read, entry.id)
                                    : null,
                                child: const Text('Отметить прочитанным'),
                              ),
                            TextButton(
                              onPressed: enabled && !c.needsRefresh
                                  ? () => _mutate(InboxAction.clear, entry.id)
                                  : null,
                              child: const Text('Скрыть уведомление'),
                            ),
                          ],
                        ),
                      ),
                    ),
                  );
                },
              ),
            ],
          ),
        ),
      );
    },
  );
}
