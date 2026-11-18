import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../../design_system/artwork.dart';
import '../../design_system/music_controls.dart';
import '../../design_system/quantity.dart';
import '../../design_system/tokens.dart';
import '../../playback/queue_snapshot.dart';
import 'player_controller.dart';
import 'queue_actions_sheet.dart';

class QueueScreen extends StatefulWidget {
  const QueueScreen({super.key, required this.controller, this.onClose});
  final PlayerController controller;
  final VoidCallback? onClose;
  @override
  State<QueueScreen> createState() => _QueueScreenState();
}

class _QueueScreenState extends State<QueueScreen> {
  bool _editing = false;
  PlayerQueueTarget? _dragTarget;
  final _scroll = ScrollController();
  late QueueSnapshot _projection;
  bool _busy = false;
  Object? _failure;

  @override
  void initState() {
    super.initState();
    _projection = widget.controller.snapshot;
    _busy = widget.controller.busy;
    _failure = widget.controller.failure;
    widget.controller.addListener(_changed);
  }

  @override
  void didUpdateWidget(QueueScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller.removeListener(_changed);
      widget.controller.addListener(_changed);
      _projection = widget.controller.snapshot;
      _busy = widget.controller.busy;
      _failure = widget.controller.failure;
      _dragTarget = null;
      if (_scroll.hasClients) _scroll.jumpTo(0);
    }
  }

  void _changed() {
    final controller = widget.controller;
    final state = controller.snapshot;
    // Position, buffer, duration and intent belong to the player. Queue rows
    // rebuild only when their projection or available actions actually change.
    if (_projection.fence == state.fence &&
        _projection.lineage == state.lineage &&
        _projection.currentEntryId == state.currentEntryId &&
        _projection.shuffle == state.shuffle &&
        listEquals(_projection.entries, state.entries) &&
        listEquals(_projection.effectiveOrder, state.effectiveOrder) &&
        _busy == controller.busy &&
        _failure == controller.failure) {
      return;
    }
    final selectionChanged = _projection.currentEntryId != state.currentEntryId;
    if (selectionChanged && _scroll.hasClients) _scroll.jumpTo(0);
    setState(() {
      _projection = state;
      _busy = controller.busy;
      _failure = controller.failure;
    });
  }

  // View indices start at the selected occurrence. The complete earlier part
  // remains accessible after upcoming items, under its explicit section label.
  // Service order and queue ownership are never changed by opening this view.
  List<String> _viewIds(QueueSnapshot state) {
    final order = state.effectiveOrder;
    final current = order.indexOf(state.currentEntryId ?? '');
    if (current <= 0) return order;
    return [...order.skip(current), ...order.take(current)];
  }

  void _reorder(int from, int to) {
    final controller = widget.controller;
    final target = _dragTarget;
    _dragTarget = null;
    if (!_editing ||
        _projection.shuffle ||
        controller.busy ||
        target == null ||
        !target.isCurrent ||
        from == to) {
      return;
    }
    final view = _viewIds(target.snapshot).toList();
    final moved = view.removeAt(from);
    final ids = target.snapshot.effectiveOrder.toList()..remove(moved);
    final insertion = to < view.length
        ? ids.indexOf(view[to])
        : ids.indexOf(view.last) + 1;
    ids.insert(insertion, moved);
    controller.reorder(ids, target: target);
  }

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    final state = _projection;
    final candidate = controller.captureQueue();
    final renderedTarget =
        candidate != null &&
            candidate.snapshot.fence == state.fence &&
            candidate.snapshot.lineage == state.lineage &&
            candidate.snapshot.currentEntryId == state.currentEntryId &&
            listEquals(candidate.snapshot.effectiveOrder, state.effectiveOrder)
        ? candidate
        : null;
    final byId = {for (final entry in state.entries) entry.entryId: entry};
    final ids = _viewIds(state);
    final viewIndices = {for (final (index, id) in ids.indexed) id: index};
    final serviceIndices = {
      for (final (index, id) in state.effectiveOrder.indexed) id: index,
    };
    final currentIndex = state.effectiveOrder.indexOf(
      state.currentEntryId ?? '',
    );
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: Row(
                children: [
                  MusicIconButton(
                    label: 'Назад',
                    icon: Icons.arrow_back,
                    onPressed:
                        widget.onClose ??
                        () => Navigator.of(context).maybePop(),
                  ),
                  const Expanded(child: Text('Очередь')),
                  if (ids.isNotEmpty && (_editing || ids.length > 1))
                    MusicIconButton(
                      label: _editing ? 'Готово' : 'Изменить порядок',
                      icon: _editing ? Icons.check : Icons.swap_vert,
                      onPressed: () => setState(() => _editing = !_editing),
                    ),
                  if (ids.isNotEmpty)
                    MusicIconButton(
                      label: 'Действия очереди',
                      icon: Icons.more_horiz,
                      onPressed: () =>
                          QueueActionsSheet.show(context, controller),
                    ),
                ],
              ),
            ),
            Expanded(
              child: ids.isEmpty
                  ? const Center(child: Text('Очередь пуста'))
                  : CustomScrollView(
                      controller: _scroll,
                      semanticChildCount: ids.length,
                      slivers: [
                        SliverPadding(
                          padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
                          sliver: SliverToBoxAdapter(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              children: [
                                Text(
                                  '${musicQuantity(ids.length, one: 'позиция', few: 'позиции', many: 'позиций')} · ${state.currentEntry?.context.surface == PlaySurface.wave ? 'Волна' : 'Ваша очередь'}',
                                  style: Theme.of(context).textTheme.bodyMedium,
                                ),
                                if (controller.failure != null)
                                  Padding(
                                    padding: const EdgeInsets.symmetric(
                                      vertical: 12,
                                    ),
                                    child: Semantics(
                                      liveRegion: true,
                                      child: Text(controller.failure!.message),
                                    ),
                                  ),
                                if (_editing && state.shuffle)
                                  const Padding(
                                    padding: EdgeInsets.symmetric(vertical: 12),
                                    child: Text(
                                      'Выключите перемешивание для ручного порядка.',
                                    ),
                                  ),
                              ],
                            ),
                          ),
                        ),
                        SliverPadding(
                          padding: const EdgeInsets.fromLTRB(12, 0, 12, 32),
                          sliver: SliverReorderableList(
                            itemCount: ids.length,
                            findChildIndexCallback: (key) =>
                                key is ValueKey<String>
                                ? viewIndices[key.value]
                                : null,
                            onReorderStart: (_) => _dragTarget = renderedTarget,
                            onReorderItem: _reorder,
                            proxyDecorator: (child, _, _) => Material(
                              color: MusicColors.surface2,
                              elevation: 6,
                              child: child,
                            ),
                            itemBuilder: (context, index) {
                              final entry = byId[ids[index]]!;
                              final selected =
                                  entry.entryId == state.currentEntryId;
                              final serviceIndex =
                                  serviceIndices[entry.entryId]!;
                              final target = renderedTarget;
                              void move(int offset) {
                                final order = state.effectiveOrder.toList();
                                final moved = order.removeAt(serviceIndex);
                                order.insert(serviceIndex + offset, moved);
                                controller.reorder(order, target: target);
                              }

                              return IndexedSemantics(
                                key: ValueKey(entry.entryId),
                                index: index,
                                child: Column(
                                  crossAxisAlignment:
                                      CrossAxisAlignment.stretch,
                                  children: [
                                    if (index == 1 &&
                                        currentIndex < ids.length - 1)
                                      const Padding(
                                        padding: EdgeInsets.symmetric(
                                          vertical: 8,
                                        ),
                                        child: Text('Далее'),
                                      ),
                                    if (currentIndex > 0 &&
                                        index == ids.length - currentIndex)
                                      const Padding(
                                        padding: EdgeInsets.symmetric(
                                          vertical: 8,
                                        ),
                                        child: Text('Ранее в очереди'),
                                      ),
                                    Container(
                                      margin: const EdgeInsets.symmetric(
                                        vertical: 4,
                                      ),
                                      decoration: BoxDecoration(
                                        color: selected
                                            ? MusicColors.primaryContainer
                                            : Colors.transparent,
                                        borderRadius: BorderRadius.circular(12),
                                      ),
                                      child: Column(
                                        children: [
                                          Semantics(
                                            selected: selected,
                                            child: Row(
                                              crossAxisAlignment:
                                                  CrossAxisAlignment.start,
                                              children: [
                                                Expanded(
                                                  child: MusicTapTarget(
                                                    onTap:
                                                        controller.busy ||
                                                            target == null
                                                        ? null
                                                        : () => controller
                                                              .playEntry(
                                                                entry.entryId,
                                                                target: target,
                                                              ),
                                                    child: Padding(
                                                      padding:
                                                          const EdgeInsets.all(
                                                            8,
                                                          ),
                                                      child: Row(
                                                        crossAxisAlignment:
                                                            CrossAxisAlignment
                                                                .start,
                                                        children: [
                                                          Artwork(
                                                            uri: entry
                                                                .track
                                                                .artwork,
                                                            trackRef:
                                                                entry.track.ref,
                                                            size: 48,
                                                          ),
                                                          const SizedBox(
                                                            width: 12,
                                                          ),
                                                          Expanded(
                                                            child: Column(
                                                              crossAxisAlignment:
                                                                  CrossAxisAlignment
                                                                      .start,
                                                              children: [
                                                                if (selected)
                                                                  const Text(
                                                                    'Сейчас играет',
                                                                  ),
                                                                if (entry
                                                                        .smartShuffle
                                                                        ?.injected ==
                                                                    true)
                                                                  const Text(
                                                                    'Находка',
                                                                  ),
                                                                Text(
                                                                  entry
                                                                      .track
                                                                      .title,
                                                                ),
                                                                Text(
                                                                  entry
                                                                      .track
                                                                      .artist,
                                                                  style: Theme.of(
                                                                    context,
                                                                  ).textTheme.bodySmall,
                                                                ),
                                                              ],
                                                            ),
                                                          ),
                                                        ],
                                                      ),
                                                    ),
                                                  ),
                                                ),
                                                if (_editing && !state.shuffle)
                                                  ReorderableDragStartListener(
                                                    index: index,
                                                    enabled: !controller.busy,
                                                    child: Semantics(
                                                      label:
                                                          'Перетащить позицию ${serviceIndex + 1}',
                                                      child: const SizedBox(
                                                        width: 48,
                                                        height: 48,
                                                        child: Icon(
                                                          Icons.drag_handle,
                                                        ),
                                                      ),
                                                    ),
                                                  )
                                                else
                                                  MusicIconButton(
                                                    key: ValueKey(
                                                      'entry-actions-${entry.entryId}',
                                                    ),
                                                    label:
                                                        'Действия позиции ${serviceIndex + 1}',
                                                    icon: Icons.more_horiz,
                                                    onPressed: target == null
                                                        ? null
                                                        : () {
                                                            if (target
                                                                .isCurrent) {
                                                              QueueActionsSheet.entry(
                                                                context,
                                                                controller,
                                                                entry.entryId,
                                                              );
                                                            }
                                                          },
                                                  ),
                                              ],
                                            ),
                                          ),
                                          if (_editing && !state.shuffle)
                                            Row(
                                              mainAxisAlignment:
                                                  MainAxisAlignment.end,
                                              children: [
                                                MusicIconButton(
                                                  label:
                                                      'Переместить позицию ${serviceIndex + 1} вверх',
                                                  icon: Icons.arrow_upward,
                                                  onPressed:
                                                      serviceIndex > 0 &&
                                                          !controller.busy &&
                                                          target != null
                                                      ? () => move(-1)
                                                      : null,
                                                ),
                                                MusicIconButton(
                                                  label:
                                                      'Переместить позицию ${serviceIndex + 1} вниз',
                                                  icon: Icons.arrow_downward,
                                                  onPressed:
                                                      serviceIndex <
                                                              ids.length - 1 &&
                                                          !controller.busy &&
                                                          target != null
                                                      ? () => move(1)
                                                      : null,
                                                ),
                                              ],
                                            ),
                                        ],
                                      ),
                                    ),
                                  ],
                                ),
                              );
                            },
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

  @override
  void dispose() {
    widget.controller.removeListener(_changed);
    _scroll.dispose();
    super.dispose();
  }
}
