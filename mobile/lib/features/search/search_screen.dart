import 'dart:async';

import 'package:flutter/material.dart' hide SearchController;

import '../../core/model/app_failure.dart';
import '../../design_system/design_system.dart';
import '../library/library_models.dart';
import 'catalog_actions.dart';
import 'catalog_models.dart';
import 'search_controller.dart';

class SearchScreen extends StatefulWidget {
  const SearchScreen({
    super.key,
    required this.controller,
    this.onOpenArtist,
    this.onOpenAlbum,
    this.onPlay,
    this.actions = const CatalogActions(),
    this.scrollController,
  });
  final SearchController controller;
  final FutureOr<void> Function(CatalogEntityRef)? onOpenArtist, onOpenAlbum;
  final FutureOr<void> Function(CollectionPlaybackRequest)? onPlay;
  final CatalogActions actions;
  final ScrollController? scrollController;
  @override
  State<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends State<SearchScreen> {
  late TextEditingController _query;
  AppFailure? _failure;
  @override
  void initState() {
    super.initState();
    _query = TextEditingController(text: widget.controller.state.query);
  }

  @override
  void didUpdateWidget(SearchScreen old) {
    super.didUpdateWidget(old);
    if (old.controller != widget.controller) {
      _query.text = widget.controller.state.query;
      _failure = null;
    }
  }

  @override
  void dispose() {
    _query.dispose();
    super.dispose();
  }

  Future<void> _run(
    SearchController owner,
    int revision,
    FutureOr<void> Function() action,
  ) async {
    if (!mounted ||
        !identical(owner, widget.controller) ||
        !owner.isCurrent ||
        owner.revision != revision) {
      return;
    }
    try {
      await action();
    } catch (e) {
      if (mounted &&
          identical(owner, widget.controller) &&
          owner.isCurrent &&
          owner.revision == revision) {
        setState(() => _failure = collectionFailure(e));
      }
    }
  }

  Widget _entities(
    String title,
    List<CatalogEntity> entities,
    FutureOr<void> Function(CatalogEntityRef)? open,
  ) {
    final owner = widget.controller, revision = owner.revision;
    return SliverList.list(
      children: [
        Padding(
          padding: const EdgeInsets.only(top: 28, bottom: 12),
          child: Text(title, style: Theme.of(context).textTheme.titleLarge),
        ),
        ...entities.map(
          (e) => CatalogEntityTile(
            entity: e,
            onTap: open == null
                ? null
                : () => _run(owner, revision, () => open(e.ref)),
          ),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.controller,
    builder: (context, _) {
      final owner = widget.controller,
          state = owner.state,
          revision = owner.revision;
      return Material(
        child: SafeArea(
          child: Padding(
            padding: EdgeInsets.symmetric(
              horizontal: MusicSpace.gutter(MediaQuery.sizeOf(context).width),
            ),
            child: CustomScrollView(
              key: const PageStorageKey('catalog-search'),
              controller: widget.scrollController,
              keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
              slivers: [
                SliverToBoxAdapter(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const SizedBox(height: 24),
                      Text(
                        'Поиск',
                        style: Theme.of(context).textTheme.headlineMedium,
                      ),
                      const SizedBox(height: 20),
                      TextField(
                        controller: _query,
                        maxLength: 500,
                        textInputAction: TextInputAction.search,
                        onChanged: (q) {
                          setState(() => _failure = null);
                          owner.changeQuery(q);
                        },
                        onSubmitted: (q) => owner.submit(q),
                        decoration: InputDecoration(
                          labelText: 'Треки, альбомы, артисты',
                          prefixIcon: const Icon(Icons.search),
                          counterText: '',
                          suffixIcon: MusicIconButton(
                            label: 'Очистить поиск',
                            icon: Icons.close,
                            onPressed: state.query.isEmpty
                                ? null
                                : () {
                                    _query.clear();
                                    owner.clear();
                                    FocusScope.of(context).unfocus();
                                  },
                          ),
                        ),
                      ),
                      const SizedBox(height: 16),
                      SingleChildScrollView(
                        scrollDirection: Axis.horizontal,
                        child: Row(
                          children: [
                            for (final pair in [
                              (SearchKind.all, 'Всё'),
                              (SearchKind.tracks, 'Треки'),
                              (SearchKind.artists, 'Артисты'),
                              (SearchKind.albums, 'Альбомы'),
                            ])
                              Padding(
                                padding: const EdgeInsets.only(right: 8),
                                child: ConstrainedBox(
                                  constraints: const BoxConstraints(
                                    minHeight: 48,
                                  ),
                                  child: ChoiceChip(
                                    label: Text(pair.$2),
                                    selected: state.kind == pair.$1,
                                    onSelected: owner.isCurrent
                                        ? (_) => owner.setKind(pair.$1)
                                        : null,
                                  ),
                                ),
                              ),
                          ],
                        ),
                      ),
                      if (state.stale)
                        const CatalogNotice(
                          'Аккаунт изменился. Откройте поиск снова.',
                        ),
                      if (!owner.repository.networkPolicy.networkAllowed)
                        const CatalogNotice(
                          'Офлайн-режим. Загруженная музыка доступна в коллекции.',
                        ),
                      if (state.loading)
                        const Padding(
                          padding: EdgeInsets.all(28),
                          child: Center(child: CircularProgressIndicator()),
                        ),
                      if (state.failure ?? _failure case final failure?)
                        CatalogNotice(failure.message),
                      for (final failure in state.page.failures.values)
                        CatalogNotice(failure.message),
                      if (state.page.failures.isNotEmpty ||
                          state.failure != null)
                        MusicButton(
                          label: 'Повторить поиск',
                          icon: Icons.refresh,
                          onPressed: state.loading
                              ? null
                              : () => owner.submit(state.query),
                        ),
                      if (state.page.alias case final alias?)
                        CatalogNotice('Результаты для «$alias»'),
                      if (!state.loading && state.query.isEmpty && !state.stale)
                        const CatalogNotice(
                          'Найдите музыку, которую хочется услышать.',
                        ),
                      if (!state.loading &&
                          state.query.isNotEmpty &&
                          state.failure == null &&
                          state.page.tracks.isEmpty &&
                          state.page.artists.isEmpty &&
                          state.page.albums.isEmpty)
                        const CatalogNotice(
                          'Ничего не найдено. Попробуйте другое название.',
                        ),
                    ],
                  ),
                ),
                if (state.page.artists.isNotEmpty)
                  _entities(
                    'Исполнители',
                    state.page.artists,
                    widget.onOpenArtist,
                  ),
                if (state.page.albums.isNotEmpty)
                  _entities('Альбомы', state.page.albums, widget.onOpenAlbum),
                if (state.page.tracks.isNotEmpty)
                  SliverToBoxAdapter(
                    child: Padding(
                      padding: const EdgeInsets.only(top: 28, bottom: 12),
                      child: Text(
                        'Треки',
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                    ),
                  ),
                SliverList.builder(
                  itemCount: state.page.tracks.length,
                  itemBuilder: (context, i) {
                    final track = state.page.tracks[i],
                        actions = widget.actions;
                    return TrackRow(
                      track: track,
                      onPlay: widget.onPlay == null
                          ? null
                          : () => _run(
                              owner,
                              revision,
                              () => widget.onPlay!(owner.playbackRequest(i)),
                            ),
                      onMore: !track.playable || !actions.hasTrackActions
                          ? null
                          : () => showCatalogTrackSheet(
                              context,
                              actions: actions,
                              track: track,
                              fence: owner.fence,
                              isCurrent: () =>
                                  mounted &&
                                  identical(owner, widget.controller) &&
                                  owner.isCurrent &&
                                  owner.revision == revision,
                              run: (action) => _run(owner, revision, action),
                            ),
                    );
                  },
                ),
                SliverToBoxAdapter(
                  child: Column(
                    children: [
                      if (state.page.hasMore)
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 24),
                          child: MusicButton(
                            label: 'Показать ещё',
                            busy: state.loadingMore,
                            onPressed: state.loadingMore
                                ? null
                                : owner.loadMore,
                          ),
                        ),
                      const SizedBox(height: 32),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      );
    },
  );
}

class CatalogNotice extends StatelessWidget {
  const CatalogNotice(this.message, {super.key});
  final String message;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 12),
    child: Text(
      message,
      style: Theme.of(context).textTheme.bodyLarge
          ?.copyWith(color: MusicColors.textSecondary),
    ),
  );
}

class CatalogEntityTile extends StatelessWidget {
  const CatalogEntityTile({super.key, required this.entity, this.onTap});
  final CatalogEntity entity;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 4),
    child: Semantics(
      label: '${entity.ref.name}, ${entity.ref.subtitle ?? ''}',
      button: onTap != null,
      child: MusicTapTarget(
        key: ValueKey('entity-${entity.ref.identityKey}'),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 12),
          child: Row(
            children: [
              Artwork(
                uri: entity.ref.artwork,
                size: 64,
                radius: entity.ref.kind == CatalogEntityKind.artist ? 32 : 8,
              ),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      entity.ref.name,
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    if (entity.ref.subtitle != null)
                      Text(
                        entity.ref.subtitle!,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                    if (entity.year != null)
                      Text(
                        entity.year!,
                        style: Theme.of(context).textTheme.bodyMedium,
                      ),
                  ],
                ),
              ),
              if (onTap != null) const Icon(Icons.chevron_right),
            ],
          ),
        ),
      ),
    ),
  );
}
