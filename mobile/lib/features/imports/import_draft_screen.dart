import 'dart:async';

import 'package:flutter/material.dart';

import '../../app/native_documents.dart';
import '../../design_system/design_system.dart';
import 'import_draft_controller.dart';
import 'import_draft_models.dart';

class ImportDraftScreen extends StatefulWidget {
  const ImportDraftScreen({
    super.key,
    required this.controller,
    required this.pickDocument,
    required this.onOpenPlaylist,
    this.refreshAvailability,
  });
  final ImportDraftController controller;
  final Future<PlaylistDocument?> Function() pickDocument;
  final ValueChanged<String> onOpenPlaylist;
  final Future<void> Function()? refreshAvailability;
  @override
  State<ImportDraftScreen> createState() => _ImportDraftScreenState();
}

class _ImportDraftScreenState extends State<ImportDraftScreen>
    with WidgetsBindingObserver {
  final _content = TextEditingController(), _name = TextEditingController();
  String _format = 'text', _category = 'playlists';
  bool _resumed = true, _visible = true, _editing = false, _picking = false;
  Timer? _poll;
  ImportDraftController get c => widget.controller;
  @override
  void initState() {
    super.initState();
    final state = WidgetsBinding.instance.lifecycleState;
    _resumed = state == null || state == AppLifecycleState.resumed;
    WidgetsBinding.instance.addObserver(this);
    c.addListener(_changed);
    if (c.repository.networkPolicy case Listenable policy) {
      policy.addListener(_changed);
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && c.isCurrent && c.job == null) unawaited(_refresh());
    });
  }

  @override
  void didUpdateWidget(ImportDraftScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.controller, c)) {
      oldWidget.controller.removeListener(_changed);
      if (oldWidget.controller.repository.networkPolicy
          case Listenable policy) {
        policy.removeListener(_changed);
      }
      c.addListener(_changed);
      if (c.repository.networkPolicy case Listenable policy) {
        policy.addListener(_changed);
      }
      _content.clear();
      _name.clear();
      _format = 'text';
      _category = 'playlists';
      _editing = false;
      _picking = false;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && c.isCurrent && c.job == null) unawaited(_refresh());
      });
    }
    _sync();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _visible =
        (ModalRoute.isCurrentOf(context) ?? true) &&
        TickerMode.valuesOf(context).enabled;
    _sync();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _resumed = state == AppLifecycleState.resumed;
    _sync();
  }

  void _changed() {
    if (mounted) {
      setState(() {});
      _sync();
    }
  }

  void _sync() {
    if (!_resumed ||
        !_visible ||
        !c.available ||
        c.busy ||
        c.job?.working != true ||
        c.failure != null) {
      _poll?.cancel();
      _poll = null;
      return;
    }
    _poll ??= Timer(const Duration(seconds: 5), () {
      _poll = null;
      if (mounted && _resumed && _visible) unawaited(c.refresh());
    });
  }

  bool _owns(ImportDraftController original) =>
      mounted &&
      identical(c, original) &&
      c.isCurrent &&
      (ModalRoute.of(context)?.isCurrent ?? true);
  void _sourceChanged() {
    c.sourceEdited();
  }

  Future<void> _refresh() async {
    final original = c;
    await widget.refreshAvailability?.call();
    if (_owns(original)) await original.refresh();
  }

  Future<void> _pick() async {
    if (_picking || !c.available || c.busy) return;
    final original = c;
    setState(() => _picking = true);
    try {
      final selected = await widget.pickDocument();
      if (!_owns(original) || selected == null) return;
      _content.text = selected.content;
      _name.text = selected.name;
      setState(() {
        _format = selected.format ?? 'text';
        _editing = true;
      });
      c.sourceEdited();
    } catch (error) {
      if (_owns(original)) original.showFailure(error);
    } finally {
      if (mounted && identical(c, original)) setState(() => _picking = false);
    }
  }

  void _prepare() {
    FocusScope.of(context).unfocus();
    setState(() => _editing = false);
    unawaited(
      c.prepare(
        content: _content.text,
        format: _format,
        name: _name.text.trim().isEmpty
            ? (_format == 'text' ? 'Импорт текста' : 'Импорт Spotify')
            : _name.text,
        textCategory: _category,
      ),
    );
  }

  @override
  void dispose() {
    _poll?.cancel();
    c.removeListener(_changed);
    if (c.repository.networkPolicy case Listenable policy) {
      policy.removeListener(_changed);
    }
    WidgetsBinding.instance.removeObserver(this);
    _content.dispose();
    _name.dispose();
    super.dispose();
  }

  Widget _form() => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      const Text(
        'Вставьте список «Исполнитель — Песня» или выберите текстовый файл либо JSON-экспорт Spotify. До 512 КБ, UTF-8.',
      ),
      const SizedBox(height: 12),
      Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          for (final format in {
            'text': 'Текст',
            'spotify-json': 'Экспорт Spotify',
          }.entries)
            ChoiceChip(
              label: Text(format.value),
              selected: _format == format.key,
              onSelected: c.busy
                  ? null
                  : (_) {
                      setState(() => _format = format.key);
                      _sourceChanged();
                    },
            ),
        ],
      ),
      const SizedBox(height: 12),
      TextField(
        controller: _name,
        enabled: !c.busy && !_picking,
        maxLength: 200,
        onChanged: (_) => _sourceChanged(),
        decoration: const InputDecoration(
          labelText: 'Название',
          border: OutlineInputBorder(),
        ),
      ),
      const SizedBox(height: 8),
      TextField(
        controller: _content,
        enabled: !c.busy && !_picking,
        minLines: 5,
        maxLines: 10,
        onChanged: (_) => _sourceChanged(),
        decoration: InputDecoration(
          labelText: _format == 'text'
              ? 'Список треков'
              : 'Содержимое экспорта Spotify',
          alignLabelWithHint: true,
          border: const OutlineInputBorder(),
        ),
      ),
      const SizedBox(height: 12),
      OutlinedButton.icon(
        onPressed: c.busy || _picking ? null : _pick,
        icon: const Icon(Icons.upload_file_outlined),
        label: const Text('Выбрать файл'),
      ),
      if (_format == 'text') ...[
        const SizedBox(height: 12),
        const Text('Какой список вы переносите?'),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final category in {
              'playlists': 'Плейлист',
              'likes': 'Любимое',
              'dislikes': 'Не нравится',
            }.entries)
              ChoiceChip(
                label: Text(category.value),
                selected: _category == category.key,
                onSelected: c.busy
                    ? null
                    : (_) {
                        setState(() => _category = category.key);
                        _sourceChanged();
                      },
              ),
          ],
        ),
      ],
      const SizedBox(height: 12),
      MusicButton(
        label: 'Найти совпадения',
        icon: Icons.search,
        onPressed: c.busy || _picking ? null : _prepare,
      ),
    ],
  );

  Widget _summary(ImportDraftJob job) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      Text(job.name, style: Theme.of(context).textTheme.headlineSmall),
      const SizedBox(height: 8),
      Text(job.statusLabel),
      if (job.working) ...[
        const SizedBox(height: 12),
        LinearProgressIndicator(value: job.progress / 100),
      ],
      if (job.canConfirm && !c.dirty) ...[
        const SizedBox(height: 20),
        const Text(
          'Что добавить в медиатеку?',
          style: TextStyle(fontWeight: FontWeight.w700),
        ),
        const SizedBox(height: 8),
        const Text(
          'Ничего не выбрано заранее. Любимые треки и «Не нравится» переносятся только по вашему выбору.',
        ),
        for (final category in ImportDraftCategory.values)
          if (job.count(category) > 0)
            CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(category.label),
              subtitle: Text('Записей: ${job.count(category)}'),
              value: c.selection.contains(category),
              onChanged: c.busy
                  ? null
                  : (value) => c.choose(category, value == true),
            ),
      ],
      if (job.result case final result?) ...[
        const SizedBox(height: 16),
        for (final value in result.counts.entries)
          if (value.value > 0) Text('${value.key.label}: ${value.value}'),
        if (result.unresolved > 0)
          Text(
            'Не удалось сопоставить: ${result.unresolved}. Эти позиции сохранены в результате импорта.',
          ),
        if (result.preservedPreferences > 0)
          Text(
            'Ваш прежний выбор сохранён для ${result.preservedPreferences} записей.',
          ),
        for (final id in result.playlistIds)
          OutlinedButton(
            onPressed: () => widget.onOpenPlaylist(id),
            child: Text(
              result.playlistIds.length == 1
                  ? 'Открыть плейлист'
                  : 'Открыть плейлист ${result.playlistIds.indexOf(id) + 1}',
            ),
          ),
      ],
      if (job.editable && !_editing && !c.dirty)
        TextButton(
          onPressed: c.busy
              ? null
              : () {
                  setState(() => _editing = true);
                  c.sourceEdited();
                },
          child: const Text('Изменить исходные данные'),
        ),
      if (job.canRetryConfirmed)
        OutlinedButton(
          onPressed: c.busy ? null : c.retry,
          child: const Text('Повторить этот импорт'),
        ),
      if (job.cancellable)
        TextButton(
          onPressed: c.busy ? null : c.cancel,
          child: const Text('Отменить импорт'),
        ),
      if (!job.working)
        TextButton(
          onPressed: c.busy
              ? null
              : () {
                  c.newDraft();
                  _content.clear();
                  _name.clear();
                  setState(() => _editing = false);
                },
          child: const Text('Новый импорт'),
        ),
    ],
  );

  @override
  Widget build(BuildContext context) {
    final job = c.job, preview = job?.preview;
    final form =
        c.available && (job == null || job.editable && (_editing || c.dirty));
    return Scaffold(
      appBar: AppBar(
        title: const Text(
          'Импорт',
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        actions: [
          MusicIconButton(
            label: 'Обновить импорт',
            icon: Icons.refresh,
            onPressed: c.busy ? null : () => unawaited(_refresh()),
          ),
        ],
      ),
      bottomNavigationBar: c.available && job?.canConfirm == true && !c.dirty
          ? SafeArea(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: MusicButton(
                  label: 'Добавить выбранное',
                  onPressed: c.canConfirm ? () => unawaited(c.confirm()) : null,
                ),
              ),
            )
          : null,
      body: SafeArea(
        top: false,
        child: CustomScrollView(
          key: const PageStorageKey('text-export-import'),
          keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
          slivers: [
            SliverPadding(
              padding: const EdgeInsets.all(16),
              sliver: SliverToBoxAdapter(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (!c.isCurrent)
                      const MusicStatus(
                        message: 'Аккаунт изменился. Откройте импорт заново.',
                      )
                    else if (!c.available)
                      const MusicStatus(
                        message: 'Текст и экспорт доступны при подключении к обновлённому серверу.',
                      )
                    else ...[
                      if (job != null) _summary(job),
                      if (form) ...[const SizedBox(height: 12), _form()],
                    ],
                    if (c.failure case final failure?)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 12),
                        child: MusicStatus(
                          message: failure.message,
                          error: true,
                        ),
                      ),
                    if (c.busy && job?.working != true)
                      const Padding(
                        padding: EdgeInsets.symmetric(vertical: 12),
                        child: LinearProgressIndicator(),
                      ),
                    if (job == null && c.history.isNotEmpty) ...[
                      const SizedBox(height: 24),
                      Text(
                        'Ваши импорты',
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                    ],
                    if (job != null && preview != null && !form) ...[
                      const SizedBox(height: 20),
                      Text(
                        'Состав · ${job.entries.length}',
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                    ],
                  ],
                ),
              ),
            ),
            if (c.isCurrent && job == null)
              SliverList.builder(
                itemCount: c.history.length,
                itemBuilder: (context, index) {
                  final item = c.history[index];
                  return ListTile(
                    title: Text(item.name),
                    subtitle: Text(item.statusLabel),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: c.busy ? null : () => unawaited(c.open(item.id)),
                  );
                },
              ),
            if (c.isCurrent && job != null && preview != null && !form)
              SliverList.builder(
                itemCount: job.entries.length,
                itemBuilder: (context, index) {
                  final entry = job.entries[index], row = preview.rows[index];
                  return Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 16,
                      vertical: 8,
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '${index + 1}. ${entry.title}',
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                        if (entry.artist.isNotEmpty) Text(entry.artist),
                        Text(
                          row.unresolved
                              ? 'Точное совпадение не подтверждено'
                              : row.matchedTitle != null
                              ? '${row.matchedArtist ?? entry.artist} — ${row.matchedTitle} · ${row.confidence.round()}%'
                              : 'Сохранённая ссылка',
                          style: Theme.of(context).textTheme.bodySmall
                              ?.copyWith(color: MusicColors.textSecondary),
                        ),
                      ],
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
