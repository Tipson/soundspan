import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../../app/native_documents.dart';
import 'import_controller.dart';
import 'import_models.dart';
import 'import_job_screen.dart';

class ImportScreen extends StatefulWidget {
  const ImportScreen({
    super.key,
    required this.controller,
    required this.pickDocument,
    required this.onOpenPlaylist,
    this.onOpenLibrary,
    this.foreground,
    this.initialUrl,
    this.autoLoad = true,
    this.jobId,
    this.draftBuilder,
  });
  final ImportController controller;
  final Future<PlaylistDocument?> Function() pickDocument;
  final ValueChanged<String> onOpenPlaylist;
  final VoidCallback? onOpenLibrary;
  final ValueListenable<bool>? foreground;
  final String? initialUrl, jobId;
  final bool autoLoad;
  final WidgetBuilder? draftBuilder;
  @override
  State<ImportScreen> createState() => _ImportScreenState();
}

class _ImportScreenState extends State<ImportScreen>
    with WidgetsBindingObserver {
  late final TextEditingController _url, _name;
  Timer? _poll;
  bool _resumed = true, _tickers = true, _routeCurrent = true, _picking = false;
  @override
  void initState() {
    super.initState();
    _url = TextEditingController(text: widget.initialUrl ?? '');
    _name = TextEditingController();
    WidgetsBinding.instance.addObserver(this);
    final life = WidgetsBinding.instance.lifecycleState;
    _resumed = life == null || life == AppLifecycleState.resumed;
    _listen();
    if (widget.autoLoad) _initialLoad();
  }

  void _initialLoad() {
    final controller = widget.controller;
    final jobId = widget.jobId;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted &&
          controller == widget.controller &&
          jobId == widget.jobId &&
          controller.isCurrent) {
        unawaited(_load());
      }
    });
  }

  void _listen() {
    widget.controller.addListener(_changed);
    widget.foreground?.addListener(_changed);
    final policy = widget.controller.repository.networkPolicy;
    if (policy is Listenable) (policy as Listenable).addListener(_changed);
  }

  void _unlisten(ImportScreen old) {
    old.controller.removeListener(_changed);
    old.foreground?.removeListener(_changed);
    final policy = old.controller.repository.networkPolicy;
    if (policy is Listenable) (policy as Listenable).removeListener(_changed);
  }

  @override
  void didUpdateWidget(ImportScreen old) {
    super.didUpdateWidget(old);
    _unlisten(old);
    _listen();
    if (old.controller != widget.controller) {
      _picking = false;
      _url.text = widget.initialUrl ?? '';
      _name.clear();
      if (widget.autoLoad) _initialLoad();
    }
    _schedule();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _tickers = TickerMode.valuesOf(context).enabled;
    _routeCurrent = ModalRoute.isCurrentOf(context) ?? true;
    _schedule();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _resumed = state == AppLifecycleState.resumed;
    _schedule();
  }

  bool get _visible =>
      mounted &&
      _resumed &&
      _tickers &&
      _routeCurrent &&
      widget.foreground?.value != false &&
      widget.controller.isCurrent;
  void _changed() {
    if (mounted) {
      setState(() {});
      _schedule();
    }
  }

  void _schedule() {
    _poll?.cancel();
    _poll = null;
    final c = widget.controller;
    if (!_visible ||
        !c.canRead ||
        !c.hasActiveJobs ||
        c.state.failure != null) {
      return;
    }
    _poll = Timer(const Duration(seconds: 5), () {
      if (_visible && c == widget.controller && c.canRead) unawaited(_load());
    });
  }

  Future<void> _load() => widget.jobId == null
      ? widget.controller.refresh()
      : widget.controller.openJob(widget.jobId!);
  @override
  void dispose() {
    _poll?.cancel();
    _unlisten(widget);
    WidgetsBinding.instance.removeObserver(this);
    _url.dispose();
    _name.dispose();
    super.dispose();
  }

  bool _owns(ImportController c, ModalRoute<dynamic>? route) =>
      mounted &&
      c == widget.controller &&
      c.isCurrent &&
      (route == null || route.isCurrent);
  Future<void> _pick() async {
    final c = widget.controller;
    final route = ModalRoute.of(context);
    if (_picking || !c.canMutate) return;
    setState(() => _picking = true);
    try {
      final document = await widget.pickDocument();
      if (!_owns(c, route) || document == null) return;
      await c.previewM3u(document.content, name: document.name);
      if (!_owns(c, route)) return;
      _name.text = c.state.preview?.name ?? '';
    } catch (error) {
      if (_owns(c, route)) c.showFailure(error);
    } finally {
      if (mounted && c == widget.controller) setState(() => _picking = false);
    }
  }

  Future<void> _acknowledge() async {
    final c = widget.controller;
    final route = ModalRoute.of(context);
    final accepted = await showDialog<bool>(
      context: context,
      builder: (dialog) => AlertDialog(
        title: const Text('Проверьте плейлисты'),
        content: const SingleChildScrollView(
          child: Text(
            'Предыдущая операция могла завершиться на сервере. Сначала проверьте плейлисты и задания. Продолжение разрешит новый импорт: повтор тех же записей может создать дубликат. Предыдущая операция автоматически не повторяется.',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialog).pop(false),
            child: const Text('Назад'),
          ),
          TextButton(
            onPressed: () => Navigator.of(dialog).pop(true),
            child: const Text('Проверил, продолжить'),
          ),
        ],
      ),
    );
    if (accepted == true && _owns(c, route)) await c.acknowledgeDuplicateRisk();
  }

  void _openPlaylist(String id) {
    if (_visible) widget.onOpenPlaylist(id);
  }

  Widget _button(String text, VoidCallback? action) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: OutlinedButton(
      onPressed: action,
      style: OutlinedButton.styleFrom(
        minimumSize: const Size(double.infinity, 48),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      ),
      child: Text(text, textAlign: TextAlign.center),
    ),
  );
  Widget _jobInfo(ImportJob job) {
    final c = widget.controller;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(job.name, style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 8),
        Text('${providerLabel(job.sourceType)} · ${job.statusLabel}'),
        const SizedBox(height: 8),
        Semantics(
          label: 'Прогресс ${job.progress} процентов',
          child: LinearProgressIndicator(value: job.progress / 100),
        ),
        const SizedBox(height: 8),
        Text(
          'Обработано: ${job.processed} из ${job.summary.total}. ${job.summary.description}',
        ),
        if (job.remainingSeconds != null && job.active)
          Text('Осталось примерно ${job.remainingSeconds} сек.'),
        if (job.status == 'failed')
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 8),
            child: Text(
              'Импорт не завершён. Источник может быть закрыт, удалён, пуст или временно недоступен.',
            ),
          ),
        if (job.playlistId != null)
          _button('Открыть плейлист', () => _openPlaylist(job.playlistId!)),
        if (job.canCancel)
          _button(
            'Отменить задание',
            c.canMutate ? () => unawaited(c.cancel(job)) : null,
          ),
        if (job.canRetry)
          _button(
            'Повторить поиск ненайденных записей',
            c.canMutate ? () => unawaited(c.retry(job)) : null,
          ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    final state = c.state;
    final preview = state.preview;
    final job = widget.jobId == null
        ? null
        : state.selected?.id == widget.jobId
        ? state.selected
        : null;
    final enabled = c.canMutate && !_picking;
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.jobId == null ? 'Импорт музыки' : 'Задание импорта'),
      ),
      body: SafeArea(
        child: CustomScrollView(
          key: PageStorageKey('import:${widget.jobId ?? 'input'}'),
          keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
          slivers: [
            SliverPadding(
              padding: const EdgeInsets.all(16),
              sliver: SliverToBoxAdapter(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Text(
                      'Задания продолжаются на сервере после закрытия приложения. Возвращайтесь сюда, чтобы увидеть результат.',
                    ),
                    const SizedBox(height: 16),
                    if (widget.jobId == null && widget.draftBuilder != null)
                      _button(
                        'Текст или экспорт',
                        enabled
                            ? () {
                                Navigator.of(context).push(
                                  MaterialPageRoute<void>(
                                    builder: widget.draftBuilder!,
                                  ),
                                );
                              }
                            : null,
                      ),
                    if (!c.repository.networkPolicy.networkAllowed)
                      const Padding(
                        padding: EdgeInsets.only(bottom: 16),
                        child: Text(
                          'Импорт доступен при подключении к сети. Включён офлайн-режим.',
                        ),
                      ),
                    if (state.uncertain) ...[
                      Text(
                        '${state.pendingLabel ?? 'Импорт'}: результат не подтверждён.',
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const Text(
                        'Не отправляйте операцию повторно. Обновите задания и проверьте плейлисты: сервер мог выполнить запрос.',
                      ),
                      if (widget.onOpenLibrary != null)
                        _button('Открыть плейлисты', widget.onOpenLibrary),
                      _button(
                        'Я проверил результат',
                        !state.busy && !state.loading ? _acknowledge : null,
                      ),
                    ],
                    if (state.failure != null)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 12),
                        child: Semantics(
                          liveRegion: true,
                          child: Text(state.failure!.message),
                        ),
                      ),
                    if (state.loading || state.busy || _picking)
                      const Padding(
                        padding: EdgeInsets.symmetric(vertical: 12),
                        child: LinearProgressIndicator(),
                      ),
                    if (state.outcome != null) ...[
                      Text(
                        'Плейлист создан. ${state.outcome!.summary.description}',
                      ),
                      _button(
                        'Открыть созданный плейлист',
                        () => _openPlaylist(state.outcome!.playlistId),
                      ),
                    ],
                    if (widget.jobId == null && preview == null) ...[
                      Text(
                        'По ссылке',
                        style: Theme.of(context).textTheme.headlineSmall,
                      ),
                      const SizedBox(height: 8),
                      const Text(
                        'Яндекс Музыка, Spotify, Deezer и YouTube. Плейлист должен быть публичным.',
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: _url,
                        enabled: enabled,
                        keyboardType: TextInputType.url,
                        autocorrect: false,
                        decoration: const InputDecoration(
                          labelText: 'Ссылка на плейлист',
                          hintText: 'https://music.yandex.ru/…',
                          border: OutlineInputBorder(),
                        ),
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: _name,
                        enabled: enabled,
                        maxLength: 200,
                        decoration: const InputDecoration(
                          labelText: 'Название (необязательно)',
                          border: OutlineInputBorder(),
                        ),
                      ),
                      _button(
                        'Начать импорт',
                        enabled
                            ? () => unawaited(
                                c.submit(_url.text, name: _name.text),
                              )
                            : null,
                      ),
                      _button(
                        'Предпросмотр по ссылке',
                        enabled
                            ? () => unawaited(c.previewUrl(_url.text))
                            : null,
                      ),
                      _button(
                        'Найти активное задание по ссылке',
                        c.canRead
                            ? () => unawaited(c.reconnect(_url.text))
                            : null,
                      ),
                      const SizedBox(height: 16),
                      Text(
                        'Из файла',
                        style: Theme.of(context).textTheme.headlineSmall,
                      ),
                      const Text(
                        'M3U или M3U8, UTF-8, до 512 КБ. Файл сопоставляется с библиотекой сервера.',
                      ),
                      const SizedBox(height: 8),
                      _button('Выбрать файл M3U', enabled ? _pick : null),
                    ],
                    if (widget.jobId != null && job != null) _jobInfo(job),
                    if (widget.jobId != null && job == null && !state.loading)
                      const Text('Данные задания пока недоступны.'),
                    if (widget.jobId == null && preview != null) ...[
                      Text(
                        'Предпросмотр: ${preview.name}',
                        style: Theme.of(context).textTheme.headlineSmall,
                      ),
                      const SizedBox(height: 8),
                      Text(preview.summary.description),
                      const Text(
                        'В плейлист попадут только найденные записи библиотеки и YouTube. Ненайденные и устаревшие записи Tidal будут пропущены.',
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: _name,
                        enabled: enabled,
                        maxLength: 200,
                        decoration: const InputDecoration(
                          labelText: 'Название плейлиста',
                          border: OutlineInputBorder(),
                        ),
                      ),
                      _button(
                        'Создать плейлист · ${preview.summary.importable} записей',
                        enabled && preview.summary.importable > 0
                            ? () => unawaited(c.execute(name: _name.text))
                            : null,
                      ),
                      _button(
                        'Вернуться к выбору',
                        enabled ? c.dismissPreview : null,
                      ),
                      if (preview.tracks.isEmpty)
                        const Text('В файле нет записей.'),
                    ],
                    if (widget.jobId == null && preview == null) ...[
                      const SizedBox(height: 16),
                      Text(
                        'Мои задания',
                        style: Theme.of(context).textTheme.headlineSmall,
                      ),
                    ],
                    _button(
                      'Обновить состояние',
                      c.canRead ? () => unawaited(_load()) : null,
                    ),
                    if (widget.jobId == null &&
                        preview == null &&
                        state.jobs.isEmpty &&
                        !state.loading)
                      const Text(
                        'Заданий пока нет. Вставьте ссылку или выберите файл.',
                      ),
                  ],
                ),
              ),
            ),
            if (widget.jobId == null && preview != null)
              SliverList.builder(
                itemCount: preview.tracks.length,
                itemBuilder: (context, index) {
                  final track = preview.tracks[index];
                  return ListTile(
                    minVerticalPadding: 12,
                    title: Text('${index + 1}. ${track.title}'),
                    subtitle: Text(
                      '${track.artist}\n${providerLabel(track.source)}',
                    ),
                    isThreeLine: true,
                  );
                },
              ),
            if (widget.jobId == null && preview == null)
              SliverList.builder(
                itemCount: state.jobs.length,
                itemBuilder: (context, index) {
                  final job = state.jobs[index];
                  return ListTile(
                    minVerticalPadding: 12,
                    enabled: c.canRead,
                    title: Text(job.name),
                    subtitle: Text(
                      '${providerLabel(job.sourceType)} · ${job.statusLabel}\n${job.summary.description}',
                    ),
                    isThreeLine: true,
                    trailing: const Icon(Icons.chevron_right),
                    onTap: !c.canRead
                        ? null
                        : () => Navigator.of(context).push(
                            MaterialPageRoute<void>(
                              builder: (_) => ImportJobScreen(
                                controller: c,
                                jobId: job.id,
                                onOpenPlaylist: widget.onOpenPlaylist,
                                foreground: widget.foreground,
                                onOpenLibrary: widget.onOpenLibrary,
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
  }
}
