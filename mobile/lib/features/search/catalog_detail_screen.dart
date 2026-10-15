import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/model/app_failure.dart';
import '../../design_system/design_system.dart';
import '../library/library_models.dart';
import 'catalog_actions.dart';
import 'catalog_detail_controller.dart';
import 'catalog_models.dart';
import 'catalog_like_all.dart';
import 'catalog_like_review.dart';
import 'search_screen.dart';

/// Shared detail layout keeps one secondary sheet and lazy, readable track rows.
class CatalogDetailScreen extends StatefulWidget {
  const CatalogDetailScreen({
    super.key,
    required this.controller,
    required this.entity,
    this.onPlay,
    this.onOpenArtist,
    this.onOpenAlbum,
    this.actions = const CatalogActions(),
    this.autoLoad = true,
  });
  final CatalogDetailController controller;
  final CatalogEntityRef entity;
  final FutureOr<void> Function(CollectionPlaybackRequest)? onPlay;
  final FutureOr<void> Function(CatalogEntityRef)? onOpenArtist, onOpenAlbum;
  final CatalogActions actions;
  final bool autoLoad;
  @override
  State<CatalogDetailScreen> createState() => _CatalogDetailScreenState();
}

class _CatalogDetailScreenState extends State<CatalogDetailScreen> {
  AppFailure? _failure;
  int? _busyRevision;
  bool get _busy => _busyRevision == widget.controller.revision;
  String? _actionMessage;
  int? _actionRevision;
  @override
  void initState() {
    super.initState();
    if (widget.autoLoad) unawaited(widget.controller.open(widget.entity));
  }

  @override
  void didUpdateWidget(CatalogDetailScreen old) {
    super.didUpdateWidget(old);
    if (old.controller != widget.controller ||
        old.entity.identityKey != widget.entity.identityKey) {
      _failure = null;
      _busyRevision = null;
      _actionMessage = null;
      _actionRevision = null;
      if (widget.autoLoad) unawaited(widget.controller.open(widget.entity));
    }
  }

  Future<void> _run(
    CatalogDetailController owner,
    int revision,
    FutureOr<void> Function() action,
  ) async {
    if (!mounted ||
        !identical(owner, widget.controller) ||
        !owner.isCurrent ||
        owner.revision != revision ||
        _busy) {
      return;
    }
    setState(() {
      _busyRevision = revision;
      _actionRevision = revision;
      _actionMessage = null;
      _failure = null;
    });
    try {
      await action();
    } catch (e) {
      if (mounted &&
          identical(owner, widget.controller) &&
          owner.isCurrent &&
          owner.revision == revision) {
        setState(() => _failure = collectionFailure(e));
      }
    } finally {
      if (mounted &&
          identical(owner, widget.controller) &&
          owner.isCurrent &&
          _busyRevision == revision) {
        setState(() => _busyRevision = null);
      }
    }
  }

  Future<void> _more(CatalogDetail detail) async {
    final owner = widget.controller,
        revision = owner.revision,
        actions = widget.actions;
    final tracks = detail.tracks
            .where((t) => t.playable)
            .toList(growable: false),
        library = actions.library;
    final downloads = detail.ref.kind == CatalogEntityKind.artist
        ? detail.tracks
              .take(detail.popularTrackCount)
              .where((t) => t.playable)
              .toList(growable: false)
        : tracks;
    final saved = detail.ref.saved;
    final preferences = actions.preferences;
    final ownsPreferences =
        preferences != null &&
        preferences.isCurrent &&
        preferences.fence == owner.fence;
    final likeSelection = ownsPreferences
        ? CatalogLikeSelection(detail, preferences)
        : null;
    bool? isSaved;
    AppFailure? savedFailure;
    final ownsLibrary =
        library != null &&
        library.isCurrent &&
        library.repository.fence == owner.fence;
    if (ownsLibrary && library.canMutate) {
      try {
        isSaved = await library.repository.status(saved);
      } catch (error) {
        savedFailure = collectionFailure(error);
      }
    }
    if (!mounted ||
        !identical(owner, widget.controller) ||
        !owner.isCurrent ||
        owner.revision != revision) {
      return;
    }
    return MusicActionSheet.show(context, [
      if (likeSelection != null && likeSelection.tracks.isNotEmpty)
        MusicAction(
          id: 'like-all',
          label:
              'Добавить загруженные треки в любимое (${likeSelection.tracks.length})',
          icon: Icons.favorite_outline,
          disabledReason:
              !preferences!.canMutate ||
                  !owner.repository.networkPolicy.networkAllowed
              ? 'Для изменения нужна сеть.'
              : null,
          onSelected:
              !preferences.canMutate ||
                  !owner.repository.networkPolicy.networkAllowed
              ? null
              : () => _run(owner, revision, () async {
                  if (!identical(owner.state.detail, detail) ||
                      !preferences.isCurrent ||
                      preferences.fence != owner.fence) {
                    return;
                  }
                  final selected = await reviewCatalogLikes(
                    context,
                    detail: detail,
                    selection: likeSelection,
                  );
                  if (selected == null ||
                      !mounted ||
                      !identical(owner, widget.controller) ||
                      !owner.isCurrent ||
                      owner.revision != revision ||
                      !identical(owner.state.detail, detail)) {
                    return;
                  }
                  final result = await owner.likeLoaded(
                    detail: detail,
                    expectedRevision: revision,
                    preferences: preferences,
                    selected: selected,
                  );
                  if (mounted &&
                      identical(owner, widget.controller) &&
                      owner.isCurrent &&
                      owner.revision == revision &&
                      identical(owner.state.detail, detail)) {
                    setState(() => _actionMessage = result.message);
                  }
                }),
        ),
      if (ownsLibrary)
        MusicAction(
          id: 'save',
          label: isSaved == true
              ? 'Убрать из коллекции'
              : 'Сохранить в коллекцию',
          icon: isSaved == true ? Icons.bookmark : Icons.bookmark_outline,
          disabledReason: isSaved == null
              ? savedFailure?.message ?? 'Для изменения коллекции нужна сеть.'
              : null,
          onSelected: isSaved == null
              ? null
              : () => _run(owner, revision, () async {
                  if (!library.isCurrent ||
                      library.repository.fence != owner.fence) {
                    return;
                  }
                  return library.save(saved, !isSaved!);
                }),
        ),
      if (actions.addToPlaylist case final action?)
        if (tracks.isNotEmpty)
          MusicAction(
            id: 'playlist',
            label: 'Добавить треки в плейлист',
            icon: Icons.playlist_add,
            onSelected: () =>
                _run(owner, revision, () => action(tracks, owner.fence)),
          ),
      if (actions.download case final action?)
        if (downloads.isNotEmpty)
          MusicAction(
            id: 'download',
            label: detail.ref.kind == CatalogEntityKind.artist
                ? 'Скачать загруженные популярные треки (${downloads.length})'
                : 'Скачать треки альбома (${downloads.length})',
            icon: Icons.download_outlined,
            onSelected: () =>
                _run(owner, revision, () => action(downloads, owner.fence)),
          ),
      if (actions.enqueueEnd case final action?)
        if (tracks.isNotEmpty)
          MusicAction(
            id: 'queue',
            label: 'Добавить в очередь (${tracks.length})',
            icon: Icons.queue_music,
            onSelected: () =>
                _run(owner, revision, () => action(tracks, owner.fence)),
          ),
      if (actions.share case final action?)
        MusicAction(
          id: 'share',
          label: 'Поделиться',
          icon: Icons.share_outlined,
          onSelected: () =>
              _run(owner, revision, () => action(detail.ref, owner.fence)),
        ),
    ], title: detail.ref.name);
  }

  bool _hasActions(CatalogDetail d) =>
      widget.actions.library != null ||
      widget.actions.share != null ||
      d.tracks.any((t) => t.playable) &&
          (widget.actions.addToPlaylist != null ||
              widget.actions.download != null ||
              widget.actions.enqueueEnd != null ||
              widget.actions.preferences != null);
  Widget _header(CatalogDetail detail) {
    final artist = detail.ref.kind == CatalogEntityKind.artist,
        owner = widget.controller,
        revision = owner.revision;
    final first = detail.tracks.indexWhere((t) => t.playable);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (artist)
          ClipRRect(
            borderRadius: BorderRadius.circular(MusicRadius.hero),
            child: SizedBox(
              height: 240,
              width: double.infinity,
              child: FittedBox(
                fit: BoxFit.cover,
                clipBehavior: Clip.hardEdge,
                child: Artwork(
                  uri: detail.ref.artwork,
                  size: 600,
                  semanticLabel: detail.ref.name,
                ),
              ),
            ),
          )
        else
          Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 248),
              child: Artwork(
                uri: detail.ref.artwork,
                semanticLabel: detail.ref.name,
              ),
            ),
          ),
        const SizedBox(height: 24),
        Text(
          artist ? 'ИСПОЛНИТЕЛЬ' : 'АЛЬБОМ',
          style: Theme.of(context).textTheme.labelSmall
              ?.copyWith(color: MusicColors.textSecondary),
        ),
        const SizedBox(height: 8),
        Semantics(
          header: true,
          child: Text(
            detail.ref.name,
            style: Theme.of(context).textTheme.headlineMedium,
          ),
        ),
        if (!artist && detail.ref.subtitle != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: MusicTapTarget(
              onTap: detail.artist == null || widget.onOpenArtist == null
                  ? null
                  : () => _run(
                      owner,
                      revision,
                      () => widget.onOpenArtist!(detail.artist!),
                    ),
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 12),
                child: Text(
                  detail.ref.subtitle!,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
            ),
          ),
        if (detail.year != null || !artist)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              [
                ?detail.year,
                if (!artist) '${detail.tracks.length} треков',
              ].join(' · '),
              style: Theme.of(context).textTheme.bodyMedium
                  ?.copyWith(color: MusicColors.textSecondary),
            ),
          ),
        const SizedBox(height: 20),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: MusicButton(
                label: 'Слушать',
                icon: Icons.play_arrow_rounded,
                busy: _busy,
                onPressed: widget.onPlay == null || first < 0 || _busy
                    ? null
                    : () => _run(
                        owner,
                        revision,
                        () => widget.onPlay!(owner.playbackRequest(first)),
                      ),
              ),
            ),
            const SizedBox(width: 8),
            MusicIconButton(
              label: 'Перемешать',
              icon: Icons.shuffle,
              onPressed: widget.onPlay == null || first < 0 || _busy
                  ? null
                  : () => _run(
                      owner,
                      revision,
                      () => widget.onPlay!(
                        owner.playbackRequest(first, shuffle: true),
                      ),
                    ),
            ),
            if (_hasActions(detail)) ...[
              const SizedBox(width: 8),
              MusicIconButton(
                label: 'Действия',
                icon: Icons.more_horiz,
                onPressed: _busy ? null : () => _more(detail),
              ),
            ],
          ],
        ),
        if (_busy) const CatalogNotice('Выполняем действие…'),
        if (artist)
          Padding(
            padding: const EdgeInsets.only(top: 28, bottom: 12),
            child: Text(
              'Популярные треки',
              style: Theme.of(context).textTheme.titleLarge,
            ),
          ),
        if (detail.tracks.isEmpty)
          const CatalogNotice('Доступных треков пока нет.'),
      ],
    );
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.controller,
    builder: (context, _) {
      final owner = widget.controller,
          state = owner.state,
          detail = state.detail,
          revision = owner.revision;
      return Scaffold(
        appBar: AppBar(
          title: Text(
            widget.entity.kind == CatalogEntityKind.artist
                ? 'Исполнитель'
                : 'Альбом',
          ),
        ),
        body: SafeArea(
          top: false,
          child: Padding(
            padding: EdgeInsets.symmetric(
              horizontal: MusicSpace.gutter(MediaQuery.sizeOf(context).width),
            ),
            child: CustomScrollView(
              key: PageStorageKey('catalog-${widget.entity.identityKey}'),
              slivers: [
                SliverToBoxAdapter(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (state.stale)
                        const CatalogNotice(
                          'Аккаунт изменился. Откройте музыку снова.',
                        ),
                      if (state.loading)
                        const Padding(
                          padding: EdgeInsets.all(48),
                          child: Center(child: CircularProgressIndicator()),
                        ),
                      if (state.failure ??
                              (_actionRevision == revision ? _failure : null)
                          case final failure?)
                        CatalogNotice(failure.message),
                      if (_actionRevision == revision && _actionMessage != null)
                        CatalogNotice(_actionMessage!),
                      if (state.failure != null)
                        MusicButton(
                          label: 'Повторить',
                          icon: Icons.refresh,
                          onPressed: () => detail == null
                              ? owner.open(widget.entity)
                              : owner.loadMore(),
                        ),
                      if (detail != null) _header(detail),
                    ],
                  ),
                ),
                if (detail != null) ...[
                  SliverList.builder(
                    itemCount: detail.tracks.length,
                    itemBuilder: (context, i) {
                      final track = detail.tracks[i];
                      return TrackRow(
                        track: track,
                        onPlay: widget.onPlay == null || _busy
                            ? null
                            : () => _run(
                                owner,
                                revision,
                                () => widget.onPlay!(owner.playbackRequest(i)),
                              ),
                        onMore:
                            !track.playable ||
                                !widget.actions.hasTrackActions ||
                                _busy
                            ? null
                            : () => showCatalogTrackSheet(
                                context,
                                actions: widget.actions,
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
                  if (detail.hasMore)
                    SliverToBoxAdapter(
                      child: Padding(
                        padding: const EdgeInsets.symmetric(vertical: 20),
                        child: MusicButton(
                          label: detail.continuationLoaded
                              ? 'Показать ещё треки'
                              : 'Все треки исполнителя',
                          busy: state.loadingMore,
                          onPressed: state.loadingMore ? null : owner.loadMore,
                        ),
                      ),
                    ),
                  if (detail.albums.isNotEmpty)
                    SliverToBoxAdapter(
                      child: Padding(
                        padding: const EdgeInsets.only(top: 28, bottom: 12),
                        child: Text(
                          'Альбомы',
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                      ),
                    ),
                  SliverList.builder(
                    itemCount: detail.albums.length,
                    itemBuilder: (context, i) => CatalogEntityTile(
                      entity: detail.albums[i],
                      onTap: widget.onOpenAlbum == null
                          ? null
                          : () => _run(
                              owner,
                              revision,
                              () => widget.onOpenAlbum!(detail.albums[i].ref),
                            ),
                    ),
                  ),
                  if (detail.bio case final bio?)
                    SliverToBoxAdapter(
                      child: Padding(
                        padding: const EdgeInsets.only(top: 28),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              'О музыке',
                              style: Theme.of(context).textTheme.titleLarge,
                            ),
                            const SizedBox(height: 12),
                            SelectableText(
                              bio.replaceAll(RegExp('<[^>]*>'), ''),
                              style: Theme.of(context).textTheme.bodyLarge,
                            ),
                          ],
                        ),
                      ),
                    ),
                  if (detail.similar.isNotEmpty)
                    SliverToBoxAdapter(
                      child: Padding(
                        padding: const EdgeInsets.only(top: 28, bottom: 12),
                        child: Text(
                          detail.ref.kind == CatalogEntityKind.artist
                              ? 'Похожие исполнители'
                              : 'Похожие альбомы',
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                      ),
                    ),
                  SliverList.builder(
                    itemCount: detail.similar.length,
                    itemBuilder: (context, i) {
                      final entity = detail.similar[i];
                      final open = entity.ref.kind == CatalogEntityKind.artist
                          ? widget.onOpenArtist
                          : widget.onOpenAlbum;
                      return CatalogEntityTile(
                        entity: entity,
                        onTap: open == null
                            ? null
                            : () =>
                                  _run(owner, revision, () => open(entity.ref)),
                      );
                    },
                  ),
                ],
                const SliverToBoxAdapter(child: SizedBox(height: 40)),
              ],
            ),
          ),
        ),
      );
    },
  );
}
