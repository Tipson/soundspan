import 'dart:async';

import 'package:flutter/material.dart';

import '../lyrics/lyrics_sheet.dart';
import 'radio_controller.dart';
import 'radio_repository.dart';

class RadioScreen extends StatefulWidget {
  const RadioScreen({
    super.key,
    required this.controller,
    this.seed,
    this.onTrackActions,
  });
  final RadioController controller;
  final RadioSeed? seed;
  final ExtrasTrackAction? onTrackActions;
  @override
  State<RadioScreen> createState() => _RadioScreenState();
}

class _RadioScreenState extends State<RadioScreen> {
  final genre = TextEditingController();
  @override
  void initState() {
    super.initState();
    if (widget.seed != null) widget.controller.select(widget.seed!);
  }

  @override
  void didUpdateWidget(RadioScreen old) {
    super.didUpdateWidget(old);
    if (widget.seed != null &&
        (old.controller != widget.controller ||
            old.seed?.identity != widget.seed!.identity)) {
      widget.controller.select(widget.seed!);
    }
  }

  @override
  void dispose() {
    genre.dispose();
    super.dispose();
  }

  Future<void> _regenerate() async {
    final c = widget.controller, value = c.revision;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Пересобрать радио?'),
        content: const Text(
          'Состав сохранённой радиостанции изменится. Текущая очередь продолжит играть.',
        ),
        scrollable: true,
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Отмена'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Пересобрать'),
          ),
        ],
      ),
    );
    if (mounted && confirmed == true && c.current(value)) await c.regenerate();
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    return ExtrasFrame(
      controller: c,
      title: 'Радио',
      contents: (context) {
        final tracks = c.station?.tracks ?? [];
        return ExtrasContents(
          header: [
            if (c.seed == null) ...[
              Text(
                'Музыка под настроение',
                style: Theme.of(context).textTheme.headlineSmall,
              ),
              const SizedBox(height: 16),
              TextField(
                controller: genre,
                decoration: const InputDecoration(labelText: 'Жанр'),
              ),
              TextButton(
                onPressed: () {
                  final value = genre.text.trim();
                  if (value.isNotEmpty) c.select(RadioSeed.genre(value));
                },
                child: const Text('Выбрать жанр'),
              ),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final decade in ['1980', '1990', '2000', '2010', '2020'])
                    OutlinedButton(
                      onPressed: () => c.select(
                        RadioSeed.station(RadioSeedKind.decade, value: decade),
                      ),
                      child: Text('$decade-е'),
                    ),
                  for (final kind in [
                    RadioSeedKind.discovery,
                    RadioSeedKind.favorites,
                    RadioSeedKind.workout,
                  ])
                    OutlinedButton(
                      onPressed: () => c.select(RadioSeed.station(kind)),
                      child: Text(RadioSeed.station(kind).title),
                    ),
                ],
              ),
            ] else ...[
              Text(
                c.seed!.title,
                style: Theme.of(context).textTheme.headlineSmall,
              ),
              const SizedBox(height: 16),
              if (c.uncertain) ...[
                const Text(
                  'Результат запроса неизвестен. Повторная отправка отключена, чтобы не изменить радио дважды.',
                ),
                if (c.canReconcile)
                  TextButton(
                    onPressed: () => unawaited(c.reconcile()),
                    child: const Text('Проверить сохранённое радио'),
                  )
                else
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 12),
                    child: Text(
                      'Сервер не вернул идентификатор станции. Автоматически проверить результат невозможно.',
                    ),
                  ),
              ] else if (c.station == null)
                FilledButton(
                  onPressed: c.canMutate ? () => unawaited(c.generate()) : null,
                  child: const Text('Собрать радио'),
                ),
              if (c.station != null) ...[
                if (tracks.isEmpty)
                  const Text('Для этого радио пока не нашлось треков'),
                if (tracks.any((t) => t.playable))
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      FilledButton.icon(
                        onPressed: c.busy ? null : () => unawaited(c.play()),
                        icon: const Icon(Icons.play_arrow),
                        label: const Text('Слушать'),
                      ),
                      OutlinedButton(
                        onPressed: c.busy ? null : () => unawaited(c.enqueue()),
                        child: const Text('В очередь'),
                      ),
                    ],
                  ),
                if (c.station!.playlistId != null)
                  Wrap(
                    spacing: 8,
                    children: [
                      TextButton(
                        onPressed: c.canMutate
                            ? () => unawaited(c.append())
                            : null,
                        child: const Text('Добавить треки'),
                      ),
                      TextButton(
                        onPressed: c.canMutate ? _regenerate : null,
                        child: const Text('Пересобрать'),
                      ),
                    ],
                  ),
                if (c.station!.nextCursor != null)
                  TextButton(
                    onPressed: c.busy ? null : () => unawaited(c.more()),
                    child: const Text('Ещё похожие треки'),
                  ),
                if (c.station!.degradedSources.isNotEmpty)
                  const Text('Часть источников временно недоступна'),
              ],
            ],
          ],
          count: tracks.length,
          itemBuilder: (context, index) => ExtrasTrackTile(
            track: tracks[index],
            controller: c,
            onPlay: () => unawaited(c.play(index)),
            onActions: widget.onTrackActions,
          ),
        );
      },
    );
  }
}
