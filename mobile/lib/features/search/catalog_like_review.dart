import 'package:flutter/material.dart';

import '../../core/model/track.dart';
import '../../design_system/design_system.dart';
import 'catalog_like_all.dart';
import 'catalog_models.dart';

/// Cancellation returns no selection; the review itself performs no writes.
Future<List<Track>?> reviewCatalogLikes(
  BuildContext context, {
  required CatalogDetail detail,
  required CatalogLikeSelection selection,
}) => showModalBottomSheet<List<Track>>(
  context: context,
  useRootNavigator: true,
  useSafeArea: true,
  isScrollControlled: true,
  builder: (context) =>
      _CatalogLikeReview(detail: detail, selection: selection),
);

class _CatalogLikeReview extends StatefulWidget {
  const _CatalogLikeReview({required this.detail, required this.selection});
  final CatalogDetail detail;
  final CatalogLikeSelection selection;
  @override
  State<_CatalogLikeReview> createState() => _CatalogLikeReviewState();
}

class _CatalogLikeReviewState extends State<_CatalogLikeReview> {
  late final Set<String> _selected = widget.selection.tracks
      .take(CatalogLikeSelection.maxBatch)
      .map((t) => t.ref.identityKey)
      .toSet();
  @override
  Widget build(BuildContext context) => SizedBox(
    height: MediaQuery.sizeOf(context).height * 0.85,
    child: Padding(
      padding: const EdgeInsets.fromLTRB(20, 8, 20, 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(
            child: CustomScrollView(
              slivers: [
                SliverToBoxAdapter(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Expanded(
                            child: Padding(
                              padding: const EdgeInsets.only(top: 12),
                              child: Text(
                                'Добавить в любимое',
                                style: Theme.of(context).textTheme.titleLarge,
                              ),
                            ),
                          ),
                          MusicIconButton(
                            label: 'Закрыть',
                            icon: Icons.close,
                            onPressed: () => Navigator.of(context).pop(),
                          ),
                        ],
                      ),
                      Text(
                        widget.detail.ref.name,
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const SizedBox(height: 12),
                      Text(
                        'Загружено позиций: ${widget.selection.loadedPositions}. Доступно уникальных треков: ${widget.selection.tracks.length}.',
                      ),
                      if (widget.detail.hasMore)
                        const Padding(
                          padding: EdgeInsets.only(top: 8),
                          child: Text(
                            'Остальная коллекция не загружена. Изменятся только выбранные загруженные треки.',
                          ),
                        ),
                      if (widget.detail.ref.kind == CatalogEntityKind.artist)
                        const Padding(
                          padding: EdgeInsets.only(top: 8),
                          child: Text(
                            'Можно отметить только выбранные загруженные треки исполнителя.',
                          ),
                        ),
                      if (widget.selection.tracks.length >
                          CatalogLikeSelection.maxBatch)
                        const Padding(
                          padding: EdgeInsets.only(top: 8),
                          child: Text(
                            'До 100 треков за одно действие. Выбраны первые 100; снимите отметки, чтобы выбрать другие.',
                          ),
                        ),
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 16),
                        child: Text(
                          'Выбрано: ${_selected.length} из ${widget.selection.tracks.length}',
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                      ),
                    ],
                  ),
                ),
                SliverList.builder(
                  itemCount: widget.selection.tracks.length,
                  itemBuilder: (context, index) {
                    final track = widget.selection.tracks[index],
                        selected = _selected.contains(track.ref.identityKey);
                    return CheckboxListTile(
                      key: ValueKey('like-select-${track.ref.identityKey}'),
                      contentPadding: EdgeInsets.zero,
                      title: Text(
                        track.title,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                      subtitle: Text(
                        track.artist,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                      value: selected,
                      onChanged:
                          !selected &&
                              _selected.length >= CatalogLikeSelection.maxBatch
                          ? null
                          : (value) => setState(() {
                              if (value == true) {
                                _selected.add(track.ref.identityKey);
                              } else {
                                _selected.remove(track.ref.identityKey);
                              }
                            }),
                    );
                  },
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          MusicButton(
            label: 'Добавить в любимое (${_selected.length})',
            icon: Icons.favorite_outline,
            onPressed: _selected.isEmpty
                ? null
                : () => Navigator.of(context).pop(
                    widget.selection.tracks
                        .where((t) => _selected.contains(t.ref.identityKey))
                        .toList(growable: false),
                  ),
          ),
        ],
      ),
    ),
  );
}
