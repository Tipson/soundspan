import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart' hide SearchController;

import '../artwork/artwork_scope.dart';
import '../core/model/track.dart';
import '../core/model/track_ref.dart';
import '../features/account/account_screen.dart';
import '../features/album/album_controller.dart';
import '../features/album/album_repository.dart';
import '../features/album/album_screen.dart';
import '../features/artist/artist_controller.dart';
import '../features/artist/artist_repository.dart';
import '../features/artist/artist_screen.dart';
import '../features/downloads/downloads_screen.dart';
import '../features/downloads/download_actions_sheet.dart';
import '../features/downloads/offline_mix_screen.dart';
import '../features/inbox/inbox_models.dart';
import '../features/inbox/inbox_screen.dart';
import '../features/shares/share_models.dart';
import '../features/shares/share_sheet.dart';
import '../features/history/history_controller.dart';
import '../features/history/history_repository.dart';
import '../features/history/history_screen.dart';
import '../features/home/home_models.dart';
import '../features/home/home_screen.dart';
import '../features/home/mix_screen.dart';
import '../features/imports/import_screen.dart';
import '../features/library/library_models.dart';
import '../features/library/library_screen.dart';
import '../features/likes/likes_screen.dart';
import '../features/lyrics/lyrics_controller.dart';
import '../features/lyrics/lyrics_repository.dart';
import '../features/lyrics/lyrics_sheet.dart';
import '../features/player/full_player_screen.dart';
import '../features/player/mini_player.dart';
import '../features/player/player_controller.dart';
import '../features/player/queue_screen.dart';
import '../features/playlists/playlist_detail_screen.dart';
import '../features/playlists/playlist_editor_sheet.dart';
import '../features/playlists/playlist_list_screen.dart';
import '../features/playlists/playlist_models.dart';
import '../features/radio/radio_controller.dart';
import '../features/radio/radio_repository.dart';
import '../features/radio/radio_screen.dart';
import '../features/related/related_controller.dart';
import '../features/related/related_repository.dart';
import '../features/related/related_sheet.dart';
import '../features/search/catalog_actions.dart';
import '../features/search/catalog_models.dart';
import '../features/search/search_screen.dart';
import '../features/settings/offline_settings_screen.dart';
import '../features/settings/playback_settings_screen.dart';
import '../features/settings/settings_models.dart';
import '../features/settings/settings_screen.dart';
import '../features/tastes/taste_screen.dart';
import '../features/wave/wave_screen.dart';
import '../features/wave/wave_direction_sheet.dart';
import 'add_to_playlist_sheet.dart';
import 'app_destinations.dart';
import 'app_shell.dart';
import 'collection_track_picker.dart';
import 'native_documents.dart';
import 'owner_route.dart';
import 'owner_profile_screen.dart';
import 'owner_ui_session.dart';
import 'owner_visibility.dart';

/// Real destinations over the stable owner graph. Sharing remains an optional
/// extension of the feature callbacks when its integration is available.
class OwnerShell extends StatefulWidget {
  const OwnerShell({
    super.key,
    required this.session,
    required this.rootExposure,
    this.pickAvatar,
    this.onImportPlaylist,
  });
  final OwnerUiSession session;
  final ValueListenable<bool> rootExposure;
  final Future<AvatarInput?> Function()? pickAvatar;
  final Future<void> Function(BuildContext, OwnerUiSession)? onImportPlaylist;
  @override
  State<OwnerShell> createState() => _OwnerShellState();
}

class _OwnerShellState extends State<OwnerShell>
    implements OwnerUiPresentation {
  OwnerUiSession get s => widget.session;
  Future<bool> _confirmDownloadNetworkUse(int count) async {
    final session = s;
    if (!mounted ||
        !session.isCurrent ||
        !identical(session.presentation, this)) {
      return false;
    }
    final accepted = await DownloadActionsSheet.confirmNetworkUse(
      context,
      count,
    );
    return accepted &&
        mounted &&
        identical(session, s) &&
        session.isCurrent &&
        identical(session.presentation, this);
  }

  Future<void> _configureWave() async {
    final session = s, wave = s.wave, tab = s.router.currentTab;
    final initial = wave.selection, revision = wave.selectionRevision;
    if (!session.isCurrent || !widget.rootExposure.value) return;
    final selection = await WaveDirectionSheet.show(context, initial);
    if (!mounted ||
        !identical(s, session) ||
        !session.isCurrent ||
        !widget.rootExposure.value ||
        s.router.currentTab != tab ||
        wave.selectionRevision != revision ||
        wave.selection != initial ||
        selection == null) {
      return;
    }
    await wave.apply(selection);
    final failure = wave.failure;
    if (identical(s, session) && session.isCurrent && failure != null) {
      throw failure;
    }
  }

  late OwnerVisibility _visibility;
  Timer? _clock;
  final _entities = <String, CatalogEntityRef>{};
  final _mixes = <String, MusicMix>{};
  final _radio = <String, RadioSeed>{};
  final _related = <String, Track>{};
  final _shareIntents =
      <
        String,
        ({
          ShareResource resource,
          Future<void> Function()? guard,
          bool Function()? current,
        })
      >{};
  int _shareSequence = 0;
  final _searchIntent = ValueNotifier<int>(0);
  bool _onboardingScheduled = false;
  bool _onboardingDismissed = false;

  @override
  void initState() {
    super.initState();
    s.presentation = this;
    s.downloads.confirmNetworkUse = _confirmDownloadNetworkUse;
    _visibility = OwnerVisibility(router: s.router, root: widget.rootExposure);
    widget.rootExposure.addListener(_exposure);
    s.tastes.addListener(_tasteChanged);
    s.start();
    _exposure();
    _tasteChanged();
  }

  @override
  void didUpdateWidget(OwnerShell old) {
    super.didUpdateWidget(old);
    if (old.rootExposure != widget.rootExposure) {
      old.rootExposure.removeListener(_exposure);
      _visibility.dispose();
      _visibility = OwnerVisibility(
        router: s.router,
        root: widget.rootExposure,
      );
      widget.rootExposure.addListener(_exposure);
      _exposure();
    }
  }

  void _exposure() {
    _clock?.cancel();
    _clock = null;
    if (!widget.rootExposure.value || !s.isCurrent) return;
    s.refreshClock();
    _clock = Timer.periodic(
      const Duration(minutes: 1),
      (_) => s.refreshClock(),
    );
  }

  void _tasteChanged() {
    if (_onboardingScheduled ||
        _onboardingDismissed ||
        !s.isCurrent ||
        s.tastes.state?.needsOnboarding != true) {
      return;
    }
    _onboardingScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !s.isCurrent) return;
      _report(
        _open(
          const AppDestination(AppRouteKind.taste),
          overlay: true,
        ).whenComplete(() {
          _onboardingScheduled = false;
          _onboardingDismissed = true;
        }),
      );
    });
  }

  @override
  void dispose() {
    if (identical(s.presentation, this)) s.presentation = null;
    if (s.downloads.confirmNetworkUse == _confirmDownloadNetworkUse) {
      s.downloads.confirmNetworkUse = null;
    }
    _clock?.cancel();
    widget.rootExposure.removeListener(_exposure);
    s.tastes.removeListener(_tasteChanged);
    _visibility.dispose();
    _searchIntent.dispose();
    super.dispose();
  }

  Future<void> _open(
    AppDestination destination, {
    bool overlay = false,
    bool Function()? current,
  }) async {
    await s.guard();
    if (!mounted) throw collectionStaleSession;
    if (current?.call() == false) return;
    if (overlay || !widget.rootExposure.value) {
      await s.router.openOverlay<void>(destination);
    } else {
      await s.router.push<void>(destination);
    }
  }

  void _chooseOfflineMix() {
    if (!mounted || !s.isCurrent) return;
    Navigator.of(
      context,
      rootNavigator: true,
    ).popUntil((route) => route.isFirst);
    s.router.selectTab(AppTab.home);
    s.router
        .navigatorKey(AppTab.home)
        .currentState
        ?.popUntil((route) => route.isFirst);
  }

  void _launch(AppDestination destination, {bool overlay = false}) =>
      _report(_open(destination, overlay: overlay));
  void _report(Future<void> navigation) {
    unawaited(
      navigation.catchError((Object _) {
        if (mounted && s.isCurrent) {
          s.notice.value = 'Не удалось выполнить действие. Повторите попытку.';
        }
      }),
    );
  }

  Future<void> _entity(CatalogEntityRef ref, {bool Function()? current}) async {
    await s.guard();
    if (current?.call() == false) return;
    _entities[ref.identityKey] = ref;
    await _open(
      AppDestination(
        ref.kind == CatalogEntityKind.artist
            ? AppRouteKind.artist
            : AppRouteKind.album,
        id: ref.identityKey,
      ),
      current: current,
    );
  }

  void _search(String text) {
    if (!s.isCurrent) {
      return;
    }
    s.search.changeQuery(text);
    // The retained feature owns its text editor. A new explicit search intent
    // resets only that editor; the owner controller and navigation stack remain.
    _searchIntent.value++;
    s.router.selectTab(AppTab.search);
  }

  Future<void> _saved(SavedEntityRef saved) async {
    final source = switch (saved.source) {
      'library' => CatalogSource.library,
      'ytmusic' => CatalogSource.ytmusic,
      'discovery' => CatalogSource.discovery,
      _ => null,
    };
    if (source == null) {
      _search(saved.title);
      return;
    }
    await _entity(
      CatalogEntityRef(
        kind: saved.kind == SavedEntityKind.artist
            ? CatalogEntityKind.artist
            : CatalogEntityKind.album,
        source: source,
        id: saved.entityId,
        name: saved.title,
        subtitle: saved.subtitle,
        artwork: saved.image,
      ),
    );
  }

  Future<void> _play(CollectionPlaybackRequest request) async {
    s.rememberQueue(request.tracks);
    await s.playbackActions.play(request);
  }

  Future<void> _download(
    List<Track> tracks, {
    Future<void> Function()? assertTarget,
    BuildContext? sourceContext,
    bool Function()? sourceCurrent,
  }) async {
    final source = sourceContext ?? context;
    final tab = s.router.currentTab;
    final route = ModalRoute.of(source);
    bool current() =>
        mounted &&
        source.mounted &&
        s.isCurrent &&
        s.router.currentTab == tab &&
        TickerMode.valuesOf(source).enabled &&
        (route?.isCurrent ?? true) &&
        sourceCurrent?.call() != false;
    final original = List<Track>.unmodifiable(tracks);
    final quality = s.owner.quality.value;
    await s.guard();
    await assertTarget?.call();
    if (!source.mounted || !current()) return;
    s.remember(original);
    await DownloadActionsSheet.confirmSelection(
      source,
      s.downloads,
      original,
      quality: quality,
      beforeDownload: () async {
        await s.guard();
        await assertTarget?.call();
        if (!current()) throw collectionStaleSession;
      },
    );
  }

  Future<void> _enqueue(List<Track> tracks) {
    s.rememberQueue(tracks, append: true);
    return s.playbackActions.enqueue(tracks, s.fence);
  }

  Future<void> _openRadio(RadioSeed seed) async {
    await s.guard();
    _radio[seed.identity] = seed;
    await _open(
      AppDestination(AppRouteKind.radio, id: seed.identity),
      overlay: true,
    );
  }

  CatalogActions _catalogActions({
    Future<void> Function()? assertTarget,
    BuildContext? sourceContext,
    CatalogShareAction? share,
  }) {
    final source = sourceContext ?? context;
    final tab = s.router.currentTab;
    final route = ModalRoute.of(source);
    bool current() =>
        source.mounted &&
        s.router.currentTab == tab &&
        (route?.isCurrent ?? true);
    return CatalogActions(
      preferences: s.preferences,
      library: s.library,
      enqueueEnd: (tracks, fence) async {
        if (fence != s.fence) throw collectionStaleSession;
        await _enqueue(tracks);
      },
      download: (tracks, fence) async {
        if (fence != s.fence) throw collectionStaleSession;
        if (!source.mounted || !current()) return;
        await _download(
          tracks,
          assertTarget: assertTarget,
          sourceContext: source,
          sourceCurrent: current,
        );
      },
      addToPlaylist: (tracks, fence) async {
        if (fence != s.fence) throw collectionStaleSession;
        await _add(tracks, assertTarget: assertTarget);
      },
      radio: (track, fence) async {
        if (fence != s.fence) throw collectionStaleSession;
        await _openRadio(RadioSeed.track(track));
      },
      share: share,
    );
  }

  Future<void> _share(
    ShareResource resource, {
    Future<void> Function()? assertTarget,
    bool Function()? targetCurrent,
    BuildContext? sourceContext,
  }) async {
    final tab = s.router.currentTab;
    final sourceRoute = sourceContext == null
        ? null
        : ModalRoute.of(sourceContext);
    bool current() =>
        s.router.currentTab == tab &&
        (sourceContext?.mounted ?? true) &&
        (sourceRoute?.isActive ?? true) &&
        targetCurrent?.call() != false;
    await s.guard();
    await assertTarget?.call();
    if (!mounted || !current() || sourceRoute?.isCurrent == false) return;
    final id = 'share-${_shareSequence++}';
    _shareIntents[id] = (
      resource: resource,
      guard: assertTarget,
      current: current,
    );
    try {
      await _open(
        AppDestination(AppRouteKind.shares, id: id),
        overlay: true,
        current: () => current() && sourceRoute?.isCurrent != false,
      );
    } finally {
      _shareIntents.remove(id);
    }
  }

  Future<void> _add(
    List<Track> tracks, {
    Future<void> Function()? assertTarget,
  }) async {
    await s.guard();
    await assertTarget?.call();
    if (!mounted) return;
    s.remember(tracks);
    await showModalBottomSheet<bool>(
      context: context,
      useRootNavigator: true,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (_) => _owned((retire) {
        final controller = s.newPlaylist();
        retire(controller.dispose);
        return AddToPlaylistSheet(
          controller: controller,
          tracks: List.unmodifiable(tracks),
          assertCurrent: () async {
            await s.guard();
            await assertTarget?.call();
          },
        );
      }),
    );
    if (s.isCurrent) await s.library.refresh();
  }

  Future<PlaylistSummary?> _editPlaylist({
    List<Track>? queue,
    Future<void> Function()? assertTarget,
  }) async {
    await s.guard();
    await assertTarget?.call();
    if (!mounted) return null;
    final result = await showModalBottomSheet<PlaylistSummary>(
      context: context,
      useRootNavigator: true,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (_) => _owned((retire) {
        final controller = s.newPlaylist();
        retire(controller.dispose);
        return PlaylistEditorSheet(
          controller: controller,
          queue: queue,
          beforeSave: () async {
            await s.guard();
            await assertTarget?.call();
          },
        );
      }),
    );
    await s.guard();
    await s.library.refresh();
    return result;
  }

  Future<List<Track>?> _pickTracks() async {
    await s.guard();
    if (!mounted) return null;
    final repository = s.newSearchRepository();
    try {
      if (s.likes.state.tracks.isEmpty && !s.likes.state.loading) {
        await s.likes.refresh();
      }
      await s.guard();
      if (!mounted) return null;
      final selected = await showModalBottomSheet<List<Track>>(
        context: context,
        useRootNavigator: true,
        isScrollControlled: true,
        useSafeArea: true,
        builder: (_) => CollectionTrackPicker(
          initial: s.likes.state.tracks,
          search: (q) async {
            final page = await repository.search(q, SearchKind.tracks);
            await s.guard();
            s.remember(page.tracks);
            return page.tracks;
          },
          isCurrent: () => s.isCurrent,
        ),
      );
      await s.guard();
      return selected;
    } finally {
      repository.dispose();
    }
  }

  @override
  Future<void> saveQueue(PlayerQueueTarget target) async {
    await target.assertCurrent();
    await _editPlaylist(
      queue: target.tracks,
      assertTarget: target.assertCurrent,
    );
  }

  @override
  Future<void> trackAction(String action, PlayerTrackTarget target) async {
    await s.guard();
    await target.assertCurrent();
    final track = target.track;
    switch (action) {
      case 'lyrics':
        await _open(const AppDestination(AppRouteKind.lyrics), overlay: true);
      case 'related':
        _related[track.ref.identityKey] = track;
        await _open(
          AppDestination(AppRouteKind.related, id: track.ref.identityKey),
          overlay: true,
        );
      case 'radio':
        await _openRadio(RadioSeed.track(track));
      case 'playlist':
        await _add([track], assertTarget: target.assertCurrent);
      case 'share':
        await _share(
          ShareResource.track(track),
          assertTarget: target.assertCurrent,
          targetCurrent: () => target.isCurrent && s.router.playerVisible,
        );
      case 'settings':
        await _open(const AppDestination(AppRouteKind.settings), overlay: true);
      case 'artist':
        await _trackEntity(track, artist: true);
      case 'album':
        await _trackEntity(track, artist: false);
    }
  }

  Future<void> _trackEntity(Track track, {required bool artist}) async {
    final id = artist ? track.artistId : track.albumId;
    final name = artist ? track.artist : track.album ?? track.title;
    // Only library metadata provides a proven namespace for these IDs.
    if (id != null && track.ref is LibraryTrackRef) {
      await _entity(
        CatalogEntityRef(
          kind: artist ? CatalogEntityKind.artist : CatalogEntityKind.album,
          source: CatalogSource.library,
          id: id,
          name: name,
        ),
      );
    } else {
      if (s.router.playerVisible) s.router.back();
      _search(name);
    }
  }

  Future<void> _extrasActions(
    Track track,
    ExtrasActionTarget target, {
    BuildContext? sourceContext,
  }) async {
    await target.assertCurrent();
    await s.guard();
    if (!mounted) return;
    if (sourceContext != null && !sourceContext.mounted) return;
    s.remember([track]);
    await showCatalogTrackSheet(
      context,
      actions: _catalogActions(
        assertTarget: target.assertCurrent,
        sourceContext: sourceContext,
      ),
      track: track,
      fence: target.fence,
      isCurrent: () => s.isCurrent && target.isCurrent,
      run: (action) async {
        await target.assertCurrent();
        await s.guard();
        await action();
      },
    );
  }

  Future<void> _relatedEntity(
    RelatedEntity entity,
    ExtrasActionTarget target,
  ) async {
    await target.assertCurrent();
    await s.guard();
    // Related response does not prove an artist/album catalog namespace.
    _search(entity.title);
    if (mounted) {
      Navigator.of(
        context,
        rootNavigator: true,
      ).popUntil((route) => route.isFirst);
    }
  }

  Widget _owned(Widget Function(void Function(VoidCallback)) create) =>
      OwnerRoute(session: s, create: create);
  Widget _artwork(Widget child) =>
      ArtworkScope(loader: s.owner.artwork, child: child);

  Widget _route(BuildContext context, AppDestination destination) => _artwork(
    _owned((retire) {
      final owner = s.owner;
      switch (destination.kind) {
        case AppRouteKind.artist:
          final ref = _entities[destination.id];
          if (ref == null) return _missing();
          final c = ArtistController(
            repository: ArtistRepository(
              transport: owner.transport,
              authority: owner.authority,
              fence: s.fence,
              networkPolicy: owner.policy,
            ),
          );
          retire(c.dispose);
          c.addListener(() {
            s.remember(c.state.detail?.tracks ?? []);
          });
          return ArtistScreen(
            controller: c,
            playback: owner.playback,
            entity: ref,
            onPlay: _play,
            onOpenArtist: _entity,
            onOpenAlbum: _entity,
            actions: _catalogActions(sourceContext: context),
          );
        case AppRouteKind.album:
          final ref = _entities[destination.id];
          if (ref == null) return _missing();
          final c = AlbumController(
            repository: AlbumRepository(
              transport: owner.transport,
              authority: owner.authority,
              fence: s.fence,
              networkPolicy: owner.policy,
            ),
          );
          retire(c.dispose);
          c.addListener(() {
            s.remember(c.state.detail?.tracks ?? []);
          });
          return AlbumScreen(
            controller: c,
            playback: owner.playback,
            entity: ref,
            onPlay: _play,
            onOpenArtist: _entity,
            onOpenAlbum: _entity,
            actions: _catalogActions(
              sourceContext: context,
              share: ref.source != CatalogSource.library
                  ? null
                  : (entity, fence) async {
                      if (fence != s.fence) throw collectionStaleSession;
                      await _share(
                        ShareResource.album(entity),
                        sourceContext: context,
                        targetCurrent: () =>
                            c.isCurrent &&
                            c.state.detail?.ref.identityKey == ref.identityKey,
                      );
                    },
            ),
          );
        case AppRouteKind.playlist:
          final c = s.newPlaylist();
          retire(c.dispose);
          if (destination.id == null) {
            return PlaylistListScreen(
              controller: c,
              onOpenPlaylist: (id) =>
                  _open(AppDestination(AppRouteKind.playlist, id: id)),
            );
          }
          c.addListener(() {
            s.remember(c.state.detail?.items.map((i) => i.track) ?? []);
          });
          // Loading emits synchronously: admit it before the listening parent
          // mounts the detail screen, rather than from that child's initState.
          unawaited(c.open(destination.id!));
          return ListenableBuilder(
            listenable: c,
            builder: (_, _) => PlaylistDetailScreen(
              controller: c,
              playlistId: destination.id,
              autoLoad: false,
              preferences: s.preferences,
              onPlay: _play,
              onEnqueue: _enqueue,
              onDownload: (tracks) => _download(tracks, sourceContext: context),
              onShare: c.state.detail?.playlist.isOwner != true
                  ? null
                  : (playlist) => _share(
                      ShareResource.playlist(playlist),
                      sourceContext: context,
                      targetCurrent: () =>
                          c.isCurrent &&
                          c.state.detail?.playlist.id == playlist.id &&
                          c.state.detail?.playlist.isOwner == true,
                    ),
              onPickTracks: _pickTracks,
              onRadio: (id) => _openRadio(RadioSeed.playlist(id)),
            ),
          );
        case AppRouteKind.mix:
          final mix = _mixes[destination.id];
          if (mix == null) return _missing();
          final c = s.newHome();
          retire(c.dispose);
          return MixScreen(
            controller: c,
            playback: owner.playback,
            mix: mix,
            onPlay: _play,
            onSaveMix: (mix, fence) async {
              if (fence != s.fence) throw collectionStaleSession;
              final saved = await _editPlaylist(queue: mix.tracks);
              await s.guard();
              return saved == null
                  ? null
                  : MixSaveReceipt(
                      playlistId: saved.id,
                      message: 'Плейлист сохранён',
                    );
            },
            offlineMix: s.offlineMix,
            onOpenOfflineMix: () =>
                _open(const AppDestination(AppRouteKind.offlineMix)),
            onSaveOffline: (mix) async {
              await s.guard();
              await s.offlineMix.save(mix, quality: owner.quality.value);
              await s.guard();
              final failure = s.offlineMix.failure;
              if (failure != null) throw failure;
              s.notice.value =
                  s.offlineMix.notice ??
                  (s.offlineMix.state.pending == null
                      ? 'Микс сохранён для офлайна.'
                      : 'Сохраняем микс для офлайна.');
            },
            onOpenPlaylists: () =>
                _open(const AppDestination(AppRouteKind.playlist)),
            onTrackActions: (mix, index) async {
              final track = mix.tracks[index];
              s.remember([track]);
              await showCatalogTrackSheet(
                context,
                actions: _catalogActions(sourceContext: context),
                track: track,
                fence: s.fence,
                isCurrent: () => s.isCurrent && c.isCurrent,
                run: (action) async {
                  await s.guard();
                  await action();
                },
              );
            },
          );
        case AppRouteKind.liked:
          return LikesScreen(
            controller: s.likes,
            preferences: s.preferences,
            playback: owner.playback,
            onPlay: _play,
            onOpenSearch: () => s.router.selectTab(AppTab.search),
            onOpenDownloads: () => s.router.selectTab(AppTab.downloads),
            onAddToPlaylist: _add,
            onDownload: (tracks) => _download(tracks, sourceContext: context),
            onRadio: (track) => _openRadio(RadioSeed.track(track)),
          );
        case AppRouteKind.history:
          final c = HistoryController(
            repository: HistoryRepository(
              transport: owner.transport,
              authority: owner.authority,
              fence: s.fence,
              networkPolicy: owner.policy,
            ),
            playback: owner.playback,
          );
          retire(c.dispose);
          return HistoryScreen(
            controller: c,
            onTrackActions: (track, target) =>
                _extrasActions(track, target, sourceContext: context),
          );
        case AppRouteKind.account:
          return _logoutFrame(
            AccountScreen(
              controller: s.account,
              onProfile: () => _launch(
                const AppDestination(AppRouteKind.settings, id: 'profile'),
              ),
              onSettings: () =>
                  _launch(const AppDestination(AppRouteKind.settings)),
            ),
          );
        case AppRouteKind.settings:
          return switch (destination.id) {
            'profile' => OwnerProfileScreen(
              session: s,
              pickAvatar: s.settings.canUpload ? widget.pickAvatar : null,
              onAccount: () =>
                  _launch(const AppDestination(AppRouteKind.account)),
            ),
            'playback' => ListenableBuilder(
              listenable: Listenable.merge([
                owner.gainAvailable,
                owner.loudnessFailure,
              ]),
              builder: (_, _) => Column(
                children: [
                  if (owner.loudnessFailure.value case final failure?)
                    Material(
                      child: SafeArea(
                        bottom: false,
                        child: Padding(
                          padding: const EdgeInsets.all(16),
                          child: Text(failure.message),
                        ),
                      ),
                    ),
                  Expanded(
                    child: PlaybackSettingsScreen(
                      controller: s.settings,
                      gainAvailable: owner.gainAvailable.value,
                    ),
                  ),
                ],
              ),
            ),
            'offline' => OfflineSettingsScreen(
              policy: owner.policy,
              downloads: s.downloads,
              onDownloads: () {
                if (!mounted ||
                    !context.mounted ||
                    !s.isCurrent ||
                    ModalRoute.of(context)?.isCurrent != true) {
                  return;
                }
                final root = Navigator.of(context, rootNavigator: true);
                s.router.selectTab(AppTab.downloads);
                root.popUntil((route) => route.isFirst);
              },
            ),
            _ => _logoutFrame(
              SettingsScreen(
                onProfile: () => _launch(
                  const AppDestination(AppRouteKind.settings, id: 'profile'),
                ),
                onTaste: () =>
                    _launch(const AppDestination(AppRouteKind.taste)),
                onPlayback: () => _launch(
                  const AppDestination(AppRouteKind.settings, id: 'playback'),
                ),
                onOffline: () => _launch(
                  const AppDestination(AppRouteKind.settings, id: 'offline'),
                ),
                onAccount: () =>
                    _launch(const AppDestination(AppRouteKind.account)),
                onHistory: () =>
                    _launch(const AppDestination(AppRouteKind.history)),
                onShares: () =>
                    _launch(const AppDestination(AppRouteKind.shares)),
                onInbox: () =>
                    _launch(const AppDestination(AppRouteKind.inbox)),
              ),
            ),
          };
        case AppRouteKind.shares:
          final intent = _shareIntents[destination.id];
          if (destination.id != null && intent == null) return _missing();
          return ShareSheet(
            controller: s.newShares(),
            resource: intent?.resource,
            assertTarget: intent?.guard,
            targetCurrent: intent?.current,
          );
        case AppRouteKind.inbox:
          bool current() =>
              context.mounted &&
              s.isCurrent &&
              (ModalRoute.of(context)?.isCurrent ?? true) &&
              TickerMode.valuesOf(context).enabled;
          return InboxScreen(
            controller: s.newInbox(),
            foreground:
                Navigator.of(context) ==
                    Navigator.of(context, rootNavigator: true)
                ? null
                : widget.rootExposure,
            onOpen: (target) async {
              await s.guard();
              switch (target.kind) {
                case InboxDestinationKind.playlist:
                  await _open(
                    AppDestination(AppRouteKind.playlist, id: target.id),
                    current: current,
                  );
                case InboxDestinationKind.album:
                  await _entity(
                    CatalogEntityRef(
                      kind: CatalogEntityKind.album,
                      source: CatalogSource.library,
                      id: target.id,
                      name: 'Альбом из входящих',
                    ),
                    current: current,
                  );
              }
            },
          );
        case AppRouteKind.taste:
          final session = s;
          final route = ModalRoute.of(context);
          final navigator = Navigator.of(context);
          final rootNavigator = Navigator.of(context, rootNavigator: true);
          final exposure = widget.rootExposure;
          bool current() =>
              mounted &&
              context.mounted &&
              identical(s, session) &&
              session.isCurrent &&
              (route?.isCurrent ?? true) &&
              (identical(navigator, rootNavigator) ||
                  (exposure.value &&
                      identical(
                        navigator,
                        session.router
                            .navigatorKey(session.router.currentTab)
                            .currentState,
                      )));
          return TasteScreen(
            controller: session.tastes,
            current: current,
            onComplete: () {
              if (current()) {
                session.router.back();
                session.observe(
                  session.home.refresh(request: session.request()),
                );
              }
            },
          );
        case AppRouteKind.player:
          return FullPlayerScreen(
            controller: s.player,
            onCollapse: () => Navigator.of(context).pop(),
            onOpenQueue: () => _launch(
              const AppDestination(AppRouteKind.queue),
              overlay: true,
            ),
          );
        case AppRouteKind.queue:
          return QueueScreen(
            controller: s.player,
            onClose: () => Navigator.of(context).pop(),
          );
        case AppRouteKind.lyrics:
          final c = LyricsController(
            repository: LyricsRepository(
              transport: owner.transport,
              authority: owner.authority,
              fence: s.fence,
              networkPolicy: owner.policy,
            ),
            playback: owner.playback,
          );
          retire(c.dispose);
          return LyricsSheet(controller: c);
        case AppRouteKind.related:
          final c = RelatedController(
            repository: RelatedRepository(
              transport: owner.transport,
              authority: owner.authority,
              fence: s.fence,
              networkPolicy: owner.policy,
            ),
            playback: owner.playback,
          );
          retire(c.dispose);
          return RelatedSheet(
            controller: c,
            track: _related[destination.id],
            onArtist: _relatedEntity,
            onAlbum: _relatedEntity,
            onTrackActions: (track, target) =>
                _extrasActions(track, target, sourceContext: context),
          );
        case AppRouteKind.radio:
          final c = RadioController(
            repository: RadioRepository(
              transport: owner.transport,
              authority: owner.authority,
              fence: s.fence,
              networkPolicy: owner.policy,
            ),
            playback: owner.playback,
          );
          retire(c.dispose);
          return RadioScreen(
            controller: c,
            seed: _radio[destination.id],
            onTrackActions: (track, target) =>
                _extrasActions(track, target, sourceContext: context),
          );
        case AppRouteKind.downloads:
          return DownloadsScreen(
            controller: s.downloads,
            onPlay: _play,
            offlineMix: s.offlineMix,
            onOpenOfflineMix: () =>
                _open(const AppDestination(AppRouteKind.offlineMix)),
            onChooseMix: _chooseOfflineMix,
          );
        case AppRouteKind.offlineMix:
          final generation = destination.id == null
              ? null
              : int.tryParse(destination.id!);
          if (destination.id != null &&
              (generation == null || generation < 1)) {
            return _missing();
          }
          return OfflineMixScreen(
            controller: s.offlineMix,
            generation: generation,
            onPlay: _play,
          );
        case AppRouteKind.importPlaylist:
          return ImportScreen(
            controller: s.imports,
            foreground:
                Navigator.of(context) ==
                    Navigator.of(context, rootNavigator: true)
                ? null
                : widget.rootExposure,
            pickDocument: () =>
                NativeDocuments().pickPlaylist(isCurrent: () => s.isCurrent),
            onOpenPlaylist: (id) =>
                _launch(AppDestination(AppRouteKind.playlist, id: id)),
            onOpenLibrary: () =>
                _launch(const AppDestination(AppRouteKind.playlist)),
          );
      }
    }),
  );
  Widget _missing() => Scaffold(
    appBar: AppBar(title: const Text('Музыка')),
    body: const Center(
      child: Text('Откройте запись из поиска или Моей музыки.'),
    ),
  );
  Widget _logoutFrame(Widget child) => Scaffold(
    body: child,
    bottomNavigationBar: SafeArea(
      top: false,
      child: TextButton.icon(
        icon: const Icon(Icons.logout),
        onPressed: () => _report(s.endSession()),
        label: const Text('Выйти из аккаунта'),
      ),
    ),
  );

  @override
  Widget build(BuildContext context) => _artwork(
    Column(
      children: [
        ValueListenableBuilder<String?>(
          valueListenable: s.notice,
          builder: (_, value, _) => value == null
              ? const SizedBox.shrink()
              : SafeArea(
                  bottom: false,
                  child: MaterialBanner(
                    content: Text(value),
                    actions: [
                      TextButton(
                        onPressed: () => s.notice.value = null,
                        child: const Text('Закрыть'),
                      ),
                    ],
                  ),
                ),
        ),
        Expanded(
          child: AppShell(
            router: s.router,
            routeBuilder: _route,
            capabilities: const AppCapabilities(),
            miniPlayer: MiniPlayer(
              controller: s.player,
              onOpen: () => _launch(
                const AppDestination(AppRouteKind.player),
                overlay: true,
              ),
            ),
            destinations: {
              AppTab.home: (_) => HomeScreen(
                controller: s.home,
                visibility: _visibility.home,
                onOpenWave: () => s.router.selectTab(AppTab.wave),
                onStartWave: () async {
                  await s.wave.start();
                  if (s.wave.failure case final failure?) throw failure;
                },
                onConfigureWave: _configureWave,
                onPlay: _play,
                onOpenMix: (mix) async {
                  _mixes[mix.identity] = mix;
                  await _open(
                    AppDestination(AppRouteKind.mix, id: mix.identity),
                  );
                },
                onOpenProfile: () => _open(
                  const AppDestination(AppRouteKind.settings),
                  overlay: true,
                ),
                onOpenHistory: () =>
                    _open(const AppDestination(AppRouteKind.history)),
                onOpenTastes: () =>
                    _open(const AppDestination(AppRouteKind.taste)),
                onOpenDownloads: () => s.router.selectTab(AppTab.downloads),
              ),
              AppTab.wave: (_) => WaveScreen(
                controller: s.wave,
                onOpenDownloads: () => s.router.selectTab(AppTab.downloads),
                onOpenPlayer: () => _open(
                  const AppDestination(AppRouteKind.player),
                  overlay: true,
                ),
              ),
              AppTab.search: (_) => ValueListenableBuilder<int>(
                valueListenable: _searchIntent,
                builder: (source, intent, _) => SearchScreen(
                  key: ValueKey(intent),
                  controller: s.search,
                  playback: s.owner.playback,
                  onPlay: _play,
                  onOpenArtist: _entity,
                  onOpenAlbum: _entity,
                  actions: _catalogActions(sourceContext: source),
                ),
              ),
              AppTab.library: (_) => LibraryScreen(
                controller: s.library,
                onOpenLiked: () =>
                    _open(const AppDestination(AppRouteKind.liked)),
                onOpenDownloads: () => s.router.selectTab(AppTab.downloads),
                onCreatePlaylist: () async {
                  await _editPlaylist();
                },
                onImportPlaylist: () => widget.onImportPlaylist == null
                    ? _open(const AppDestination(AppRouteKind.importPlaylist))
                    : widget.onImportPlaylist!(context, s),
                onOpenSearch: () => s.router.selectTab(AppTab.search),
                onOpenEntity: _saved,
                onOpenPlaylist: (id) =>
                    _open(AppDestination(AppRouteKind.playlist, id: id)),
              ),
              AppTab.downloads: (_) => DownloadsScreen(
                controller: s.downloads,
                onPlay: _play,
                visible: _visibility.downloads,
                offlineMix: s.offlineMix,
                onOpenOfflineMix: () =>
                    _open(const AppDestination(AppRouteKind.offlineMix)),
                onChooseMix: _chooseOfflineMix,
              ),
            },
          ),
        ),
      ],
    ),
  );
}
