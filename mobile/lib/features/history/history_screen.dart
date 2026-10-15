import 'dart:async';

import 'package:flutter/material.dart';

import '../lyrics/lyrics_sheet.dart';
import 'history_controller.dart';
import 'history_repository.dart';

class HistoryScreen extends StatefulWidget {
  const HistoryScreen({
    super.key,
    required this.controller,
    this.onTrackActions,
  });
  final HistoryController controller;
  final ExtrasTrackAction? onTrackActions;
  @override
  State<HistoryScreen> createState() => _HistoryScreenState();
}

class _HistoryScreenState extends State<HistoryScreen> {
  Future<void> _clear() async {
    final c = widget.controller, revision = c.revision;
    final range = await showModalBottomSheet<HistoryRange>(
      context: context,
      useSafeArea: true,
      builder: (context) => ListView(
        shrinkWrap: true,
        children: [
          const Padding(
            padding: EdgeInsets.all(20),
            child: Text('Какую историю очистить?'),
          ),
          for (final range in HistoryRange.values)
            TextButton(
              onPressed: () => Navigator.pop(context, range),
              child: Text(range.label),
            ),
        ],
      ),
    );
    if (!mounted || range == null || !c.current(revision)) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        scrollable: true,
        title: const Text('Удалить историю?'),
        content: Text('${range.label}. Удалённые записи нельзя восстановить.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Отмена'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Удалить'),
          ),
        ],
      ),
    );
    if (mounted && confirmed == true && c.current(revision)) {
      await c.clear(range, confirmationRevision: revision);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    return ExtrasFrame(
      controller: c,
      title: 'История',
      onMount: () => unawaited(c.load()),
      onRetry: () => unawaited(c.load()),
      contents: (context) {
        final rows = c.page?.entries ?? [], summary = c.summary;
        return ExtrasContents(
          header: [
            Text(
              'Ваши прослушивания',
              style: Theme.of(context).textTheme.headlineSmall,
            ),
            if (summary != null)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 16),
                child: Text(
                  'За всё время: ${summary.allTime}\n7 дней: ${summary.last7Days} · 30 дней: ${summary.last30Days}\nЗа год: ${summary.last365Days}',
                ),
              ),
            Wrap(
              spacing: 8,
              children: [
                TextButton(
                  onPressed: c.busy ? null : () => unawaited(c.load()),
                  child: const Text('Обновить'),
                ),
                TextButton(
                  onPressed:
                      c.busy ||
                          c.uncertain ||
                          !c.repository.networkPolicy.networkAllowed
                      ? null
                      : _clear,
                  child: const Text('Очистить историю'),
                ),
              ],
            ),
            if (c.message != null) Text(c.message!),
            if (c.page != null && rows.isEmpty)
              const Text('В этом окне нет отображаемых записей'),
            if (c.page?.nextCursor != null)
              TextButton(
                onPressed: c.busy ? null : () => unawaited(c.more()),
                child: const Text('Показать более ранние'),
              ),
            if (c.page?.reachedServerLimit ?? false)
              const Text(
                'Окно последних 200 записей. Недоступные записи сервер может пропускать; более ранние страницы не предоставляются.',
              ),
          ],
          count: rows.length,
          itemBuilder: (context, index) {
            final row = rows[index], date = row.playedAt.toLocal();
            return ExtrasTrackTile(
              track: row.track,
              controller: c,
              subtitle:
                  '${date.day}.${date.month}.${date.year} ${date.hour.toString().padLeft(2, '0')}:${date.minute.toString().padLeft(2, '0')}',
              onPlay: () => unawaited(c.play(index)),
              onEnqueue: () => unawaited(c.enqueue(index)),
              onActions: widget.onTrackActions,
            );
          },
        );
      },
    );
  }
}
