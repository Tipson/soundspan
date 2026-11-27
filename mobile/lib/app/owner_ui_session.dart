import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import '../core/network/dart_api_transport.dart';
import '../core/model/app_failure.dart';
import '../features/updates/apk_update_controller.dart';
import '../features/updates/apk_update_downloader.dart';
import '../features/updates/release_update_repository.dart';
import 'native_app_update.dart';

import '../core/model/track.dart';
import '../core/model/track_ref.dart';
import '../downloads/download_worker_bridge.dart';
import '../downloads/download_models.dart';
import '../downloads/liked_download_automation.dart';
import '../downloads/offline_mix_quota.dart';
import '../downloads/reschedule_network_downloads.dart';
import '../downloads/schedule_current_download.dart';
import '../features/account/account_controller.dart';
import '../features/account/account_repository.dart';
import '../features/downloads/downloads_controller.dart';
import '../features/downloads/offline_mix_controller.dart';
import '../features/home/home_controller.dart';
import '../features/home/home_models.dart';
import '../features/home/home_repository.dart';
import '../features/imports/import_controller.dart';
import '../features/imports/import_draft_controller.dart';
import '../features/imports/import_repository.dart';
import '../features/inbox/inbox_controller.dart';
import '../features/inbox/inbox_repository.dart';
import '../features/shares/owner_endpoint.dart';
import '../features/shares/share_controller.dart';
import '../features/shares/share_repository.dart';
import '../features/library/library_controller.dart';
import '../features/library/library_models.dart';
import '../features/library/library_repository.dart';
import '../features/likes/likes_controller.dart';
import '../features/likes/likes_repository.dart';
import '../features/likes/preference_controller.dart';
import '../features/player/player_controller.dart';
import '../features/playlists/playlist_controller.dart';
import '../features/playlists/playlist_repository.dart';
import '../features/playlists/playlist_smart_shuffle.dart';
import '../features/radio/radio_repository.dart';
import '../features/search/search_controller.dart';
import '../features/search/search_repository.dart';
import '../features/settings/settings_controller.dart';
import '../features/settings/settings_repository.dart';
import '../features/settings/settings_models.dart';
import '../features/tastes/taste_controller.dart';
import '../features/tastes/taste_repository.dart';
import '../features/wave/wave_controller.dart';
import '../playback/playback_controller.dart';
import '../playback/track_audio_admin.dart';
import 'app_destinations.dart';
import 'app_router.dart';
import 'launcher_shortcut.dart';
import 'owner_feature_scope.dart';
import 'owner_playback_actions.dart';
import 'owner_services.dart';

abstract interface class OwnerUiPresentation {
  Future<void> trackAction(String action, PlayerTrackTarget target);
  Future<void> saveQueue(PlayerQueueTarget target);
}

/// Feature lifetime follows the immutable broker fence, never widget mounts or
/// token revisions. All native work stays in the original NativeOwnerServices.
final class OwnerUiSession {
  OwnerUiSession._({
    required this.owner,
    required this.logout,
    required LoudnessMode initialLoudnessMode,
    AvatarUploader? avatarUploader,
    DownloadWorkerBridge worker = const DownloadWorkerBridge(),
  }) {
    lifetime.add(router.dispose);
    lifetime.add(() {
      for (final smart in _smartPreparations.toList()) {
        smart.dispose();
      }
    });
    playbackActions = OwnerPlaybackActions(
      authority: owner.authority,
      fence: fence,
      playback: owner.playback,
      isCurrent: () => isCurrent,
      beforeIntent: () {
        for (final smart in _smartPreparations.toList()) {
          smart.cancel();
        }
      },
      prefetch: (tracks) async {
        final window = tracks.take(6).toList();
        remember(window);
        observe(_prefetchWindow(window));
      },
    );
    preferences = own(
      PreferenceController(
        transport: owner.transport,
        authority: owner.authority,
        fence: fence,
        networkPolicy: owner.policy,
        playback: owner.playback,
        finiteAdmission: owner.finiteAdmission,
      ),
    );
    final likesRepository = LikesRepository(
      transport: owner.transport,
      authority: owner.authority,
      fence: fence,
      networkPolicy: owner.policy,
    );
    likes = own(
      LikesController(repository: likesRepository, preferences: preferences),
    );
    home = own(newHome());
    search = own(SearchController(repository: newSearchRepository()));
    library = own(
      LibraryController(
        repository: LibraryRepository(
          transport: owner.transport,
          authority: owner.authority,
          fence: fence,
          networkPolicy: owner.policy,
        ),
      ),
    );
    playlists = own(newPlaylist());
    imports = ImportController(
      repository: ImportRepository(
        transport: owner.transport,
        authority: owner.authority,
        fence: fence,
        networkPolicy: owner.policy,
        store: owner.store,
      ),
    );
    lifetime.add(imports.close);
    draftImports = ImportDraftController(
      repository: imports.repository,
      supported: () => owner.capabilities.importDraftsEnabled == true,
    );
    lifetime.add(draftImports.close);
    wave = own(
      WaveController(
        continuation: owner.wave,
        playback: owner.playback,
        authority: owner.authority,
        fence: fence,
        networkPolicy: owner.policy,
      ),
    );
    Future<String> scheduleDownload(
      String id,
      SessionFence original,
      int generation,
    ) async {
      await guard();
      if (original != fence) throw collectionStaleSession;
      return scheduleCurrentDownload(
        repository: owner.downloads,
        access: owner.downloadAccess,
        worker: worker,
        id: id,
        fence: original,
        generation: generation,
        guard: guard,
      );
    }

    automation = LikedDownloadAutomation(
      downloads: owner.downloads,
      likes: likesRepository,
      fence: fence,
      networkPolicy: owner.policy,
      // Native creation has already canonicalized and opened the private root.
      storageReady: () => isCurrent && owner.downloads.paths.root.existsSync(),
      schedule: scheduleDownload,
      cancelJob: worker.cancelJob,
    );
    lifetime.add(automation.close);
    downloads = DownloadsController(
      repository: owner.downloads,
      fence: fence,
      networkPolicy: owner.policy,
      storageReady: () => isCurrent && owner.downloads.paths.root.existsSync(),
      schedule: scheduleDownload,
      cancelJob: worker.cancelJob,
      requestNotificationPermission: worker.requestNotificationPermission,
      automation: automation,
      networkAccess: owner.downloadAccess,
      offlineQuota: OfflineMixQuota(repository: owner.downloads, fence: fence),
      onNetworkRulesChanged: () async {
        owner.downloadRulesChanged();
        await rescheduleNetworkDownloads(
          repository: owner.downloads,
          fence: fence,
          cancel: worker.cancelJob,
          schedule: scheduleDownload,
        );
      },
    );
    lifetime.add(() async {
      await downloads.close();
      downloads.dispose();
    });
    offlineMix = OfflineMixController(
      repository: owner.offlineMix,
      downloads: downloads,
      dailyRefresh: owner.dailyRefresh,
    );
    lifetime.add(() async {
      await offlineMix.close();
      offlineMix.dispose();
    });
    final settingsRepository = SettingsRepository(
      transport: owner.transport,
      authority: owner.authority,
      fence: fence,
      networkPolicy: owner.policy,
      avatarUploader: avatarUploader,
    );
    lifetime.add(settingsRepository.dispose);
    settings = own(
      SettingsController(
        repository: settingsRepository,
        quality: owner.quality,
        setQuality: owner.setQuality,
        initialLoudnessMode: initialLoudnessMode,
      ),
    );
    settings.addListener(_settingsChanged);
    lifetime.add(() => settings.removeListener(_settingsChanged));
    owner.loudnessFailure.addListener(_loudnessChanged);
    lifetime.add(() => owner.loudnessFailure.removeListener(_loudnessChanged));
    final tasteRepository = TasteRepository(
      transport: owner.transport,
      authority: owner.authority,
      fence: fence,
      networkPolicy: owner.policy,
    );
    lifetime.add(tasteRepository.dispose);
    tastes = own(TasteController(tasteRepository));
    account = own(
      AccountController(
        repository: AccountRepository(
          transport: owner.transport,
          authority: owner.authority,
          networkPolicy: owner.policy,
          interactive: true,
        ),
        onPasswordChanged: endSession,
      ),
    );
    player = own(
      PlayerController(
        playback: owner.playback,
        authority: owner.authority,
        fence: fence,
        preferences: preferences,
        callbacks: PlayerCallbacks(
          onLyrics: (target) => _present('lyrics', target),
          onRelated: (target) => _present('related', target),
          onRadio: (target) => _present('radio', target),
          onArtist: (target) => _present('artist', target),
          onAlbum: (target) => _present('album', target),
          hasFullAudio: (target) async =>
              owner.policy.networkAllowed &&
              await owner.trackAudio.resolve(target.track.ref, fence) != null,
          canManageAudio: (target) => canManageTrackAudio(target.track, fence),
          onManageAudio: (target) => _present('manage-audio', target),
          isDownloaded: (target) async {
            await guard();
            await target.assertCurrent();
            final jobs = await owner.downloads.list(fence);
            for (final job in jobs.where(
              (j) =>
                  j.track.ref == target.track.ref &&
                  j.state == DownloadState.ready,
            )) {
              if (await owner.downloads.openReady(
                    job.track.ref,
                    job.quality,
                    fence,
                  ) !=
                  null) {
                await guard();
                await target.assertCurrent();
                return true;
              }
            }
            await guard();
            await target.assertCurrent();
            return false;
          },
          onDownload: (target) async {
            await guard();
            await target.assertCurrent();
            await downloads.downloadTracks([
              target.track,
            ], quality: owner.quality.value);
          },
          onAddToPlaylist: (target) => _present('playlist', target),
          onShare: (target) => _present('share', target),
          onSettings: (target) => _present('settings', target),
          onSaveQueue: (target) async {
            await target.assertCurrent();
            await guard();
            final ui = presentation;
            if (ui == null) throw collectionStaleSession;
            await ui.saveQueue(target);
          },
        ),
      ),
    );
    final confirmed = preferences.applied.listen((change) {
      if (!isCurrent || change.fence != fence) return;
      observe(
        automation.onPreferenceChanged(
          change.ref,
          change.signal,
          knownTrack: knownTrack(change.ref),
        ),
      );
    });
    lifetime.add(confirmed.cancel);
    final queueChanges = owner.playback.snapshots.listen((snapshot) {
      if (!isCurrent || snapshot.fence != fence) return;
      final track = snapshot.currentEntry?.track;
      if (track == null || track.ref.identityKey == _artworkSelection) return;
      _artworkSelection = track.ref.identityKey;
      final original =
          _queueOriginal[track.ref.identityKey] ??
          knownTrack(track.ref) ??
          track;
      observe(owner.prefetchArtwork([original]));
    });
    lifetime.add(queueChanges.cancel);
    lifetime.add(owner.artwork.cancelNetwork);
    owner.capabilities.state.addListener(_capabilitiesChanged);
    owner.policy.addListener(_policyChanged);
    lifetime.add(() {
      owner.capabilities.state.removeListener(_capabilitiesChanged);
      owner.policy.removeListener(_policyChanged);
    });
  }
  final NativeOwnerServices owner;
  T _trackedRoute<T extends MemoryFeatureController>(T controller) {
    controller.onClosed = lifetime.add(controller.close);
    return controller;
  }

  ShareController newShares() => _trackedRoute(
    ShareController(
      ShareRepository(
        transport: owner.transport,
        authority: owner.authority,
        fence: fence,
        networkPolicy: owner.policy,
        store: owner.store,
      ),
    ),
  );
  InboxController newInbox() => _trackedRoute(
    InboxController(
      InboxRepository(
        transport: owner.transport,
        authority: owner.authority,
        fence: fence,
        networkPolicy: owner.policy,
      ),
    ),
  );
  static Future<OwnerUiSession> create({
    required NativeOwnerServices owner,
    required Future<void> Function() logout,
    AvatarUploader? avatarUploader,
  }) async {
    await owner.authority.assertCurrent(owner.fence);
    final session = OwnerUiSession._(
      owner: owner,
      logout: logout,
      avatarUploader: avatarUploader,
      initialLoudnessMode: owner.loudnessMode.value,
    );
    session._loudnessChanged();
    return session;
  }

  final Future<void> Function() logout;
  final lifetime = OwnerFeatureLifetime();
  final router = AppRouter();
  final notice = ValueNotifier<String?>(null);
  OwnerUiPresentation? presentation;

  late final trackAudioAdmin = TrackAudioAdmin(
    transport: owner.transport,
    authority: owner.authority,
  );
  Future<bool>? _trackAudioRoleRequest;
  ({bool isAdmin, DateTime expires})? _trackAudioRole;

  /// The account profile controls menu visibility. The API validates every write.
  Future<bool> canManageTrackAudio(Track track, SessionFence original) async {
    if (!isCurrent ||
        original != fence ||
        !owner.policy.networkAllowed ||
        TrackAudioTarget.fromRef(track.ref) == null) {
      return false;
    }
    final canManage = await _loadTrackAudioRole().timeout(
      const Duration(milliseconds: 450),
      onTimeout: () => false,
    );
    return isCurrent && owner.policy.networkAllowed && canManage;
  }

  Future<bool> _loadTrackAudioRole() {
    final cached = _trackAudioRole;
    if (cached != null && cached.expires.isAfter(DateTime.now())) {
      return Future.value(cached.isAdmin);
    }
    return _trackAudioRoleRequest ??= _readTrackAudioRole();
  }

  Future<bool> _readTrackAudioRole() async {
    try {
      final profile = await account.repository.read(fence, 'profile');
      final role = profile['role'];
      if (!isCurrent ||
          !owner.policy.networkAllowed ||
          role is! String ||
          role.isEmpty) {
        return false;
      }
      final isAdmin = role == 'admin';
      _trackAudioRole = (
        isAdmin: isAdmin,
        expires: DateTime.now().add(const Duration(minutes: 1)),
      );
      return isAdmin;
    } on AppFailure {
      return false;
    } finally {
      _trackAudioRoleRequest = null;
    }
  }

  late final OwnerPlaybackActions playbackActions;
  late final PreferenceController preferences;
  late final LikesController likes;
  late final HomeController home;
  late final SearchController search;
  late final LibraryController library;
  late final PlaylistController playlists;
  late final ImportController imports;
  late final ImportDraftController draftImports;
  late final WaveController wave;
  late final LikedDownloadAutomation automation;
  late final DownloadsController downloads;
  late final OfflineMixController offlineMix;
  late final SettingsController settings;
  late final TasteController tastes;
  late final AccountController account;
  late final PlayerController player;
  final _pending = <Future<void>>{};
  final _smartPreparations = <PlaylistSmartShuffle>{};
  final _known = <String, Track>{};
  final _queueOriginal = <String, Track>{};
  String? _artworkSelection;
  DateTime? _lastHomeClock;
  bool _started = false;
  LoudnessMode? _lastLoudness;
  Future<void> _settingsTail = Future.value();
  void _loudnessChanged() {
    final failure = owner.loudnessFailure.value;
    if (isCurrent && failure != null) notice.value = failure.message;
  }

  void _settingsChanged() {
    final confirmed = settings.settings;
    if (!isCurrent ||
        confirmed == null ||
        confirmed.loudnessMode == _lastLoudness) {
      return;
    }
    final mode = confirmed.loudnessMode;
    _lastLoudness = mode;
    final next = _settingsTail.then((_) async {
      await guard();
      await owner.setLoudnessMode(mode);
    });
    _settingsTail = next.catchError((Object _) {
      if (_lastLoudness == mode) _lastLoudness = null;
      if (isCurrent) {
        notice.value =
            'Не удалось сохранить настройку громкости для офлайн-запуска.';
      }
    });
  }

  bool get isCurrent => lifetime.isOpen && owner.authority.isCurrent(fence);
  ApkUpdateController newAppUpdate() {
    final json = DartJsonHttpClient(
      maxResponseBytes: 65536,
      networkPolicy: owner.policy,
    );
    final repository = ReleaseUpdateRepository(
      transport: DartApiTransport(client: json, authority: owner.authority),
      authority: owner.authority,
      fence: fence,
      networkPolicy: owner.policy,
    );
    final downloader = ApkUpdateDownloader(
      directory: Directory('${owner.supportDirectory.path}/app-updates'),
      admit: () async {
        await owner.downloadNetwork.start();
        await owner.downloadAccess.requireNetwork();
      },
      readFreeBytes: () async {
        final raw = await const MethodChannel('soundspan/storage')
            .invokeMethod<Object?>('freeBytes');
        if (raw is! int || raw < 0) {
          throw const FileSystemException('Storage unavailable');
        }
        return raw;
      },
    );
    late final ApkUpdateController controller;
    controller = ApkUpdateController(
      repository: repository,
      downloader: downloader,
      installer: NativeAppUpdate(),
      isCurrent: () => isCurrent,
      networkPolicy: owner.policy,
      onDispose: () {
        owner.downloadNetwork.removeListener(controller.networkChanged);
        repository.dispose();
        unawaited(json.close());
      },
    );
    owner.downloadNetwork.addListener(controller.networkChanged);
    return controller;
  }

  SessionFence get fence => owner.fence;
  Future<void> guard() => playbackActions.guard();

  /// Executes a launcher action using the currently admitted owner graph.
  Future<void> launchShortcut(LauncherShortcut shortcut) async {
    try {
      await guard();
      switch (shortcut) {
        case LauncherShortcut.playWave:
          router.selectRootTab(AppTab.wave);
          await wave.playOrStart();
          if (wave.failure case final failure? when isCurrent) {
            notice.value = failure.message;
          }
        case LauncherShortcut.resume:
          final snapshot = owner.playback.snapshot;
          if (snapshot.fence != fence || snapshot.currentEntry == null) {
            notice.value = 'Нет сохранённой очереди для продолжения.';
          } else if (!snapshot.playing) {
            await owner.playback.dispatch(const Resume());
          }
        case LauncherShortcut.downloads:
          router.selectRootTab(AppTab.downloads);
      }
    } on AppFailure catch (failure) {
      if (isCurrent) notice.value = failure.message;
    } catch (_) {
      if (isCurrent) notice.value = 'Не удалось выполнить действие ярлыка.';
    }
  }

  T own<T extends ChangeNotifier>(T controller) {
    lifetime.add(controller.dispose);
    return controller;
  }

  HomeRequest request([DateTime? at]) => HomeRequest.at(
    at ?? DateTime.now(),
    autoPlaylists: owner.capabilities.state.value?.autoPlaylists ?? false,
    discovery: owner.capabilities.state.value?.discovery ?? false,
  );
  HomeController newHome() => HomeController(
    repository: HomeRepository(
      transport: owner.transport,
      authority: owner.authority,
      fence: fence,
      networkPolicy: owner.policy,
    ),
    request: request(),
  );
  SearchRepository newSearchRepository() => SearchRepository(
    transport: owner.transport,
    authority: owner.authority,
    fence: fence,
    networkPolicy: owner.policy,
  );
  PlaylistController newPlaylist() => PlaylistController(
    repository: PlaylistRepository(
      transport: owner.transport,
      authority: owner.authority,
      fence: fence,
      networkPolicy: owner.policy,
    ),
  );
  PlaylistSmartShuffle newSmartShuffle(PlaylistController playlist) {
    late final PlaylistSmartShuffle smart;
    smart = PlaylistSmartShuffle(
      playlist: playlist,
      playback: owner.playback,
      admission: owner.finiteAdmission,
      radio: RadioRepository(
        transport: owner.transport,
        authority: owner.authority,
        fence: fence,
        networkPolicy: owner.policy,
      ),
      onClosed: () => _smartPreparations.remove(smart),
    );
    _smartPreparations.add(smart);
    return smart;
  }

  void start() {
    if (_started || !isCurrent) return;
    _started = true;
    if (owner.policy.networkAllowed) _loadTrackAudioRole().ignore();
    observe(offlineMix.refresh());
    observe(owner.dailyRefresh.ensureScheduled());
    observe(settings.load());
    observe(tastes.load());
    observe(owner.capabilities.refresh());
    if (owner.policy.networkAllowed) observe(automation.reconcile(fence));
  }

  void observe(Future<void> operation) {
    late final Future<void> handled;
    handled = operation
        .catchError((Object _) {
          if (isCurrent) notice.value = 'Не удалось обновить часть данных. Повторите действие при доступной сети.';
        })
        .whenComplete(() => _pending.remove(handled));
    _pending.add(handled);
  }

  void _policyChanged() {
    if (!isCurrent || !owner.policy.networkAllowed) return;
    if (_started) _loadTrackAudioRole().ignore();
    observe(automation.reconcile(fence));
    observe(owner.capabilities.refresh());
    observe(home.refresh(request: request()));
  }

  void _capabilitiesChanged() {
    if (isCurrent) observe(home.refresh(request: request()));
  }

  /// Called on foreground/exposure transitions and once per minute while shown.
  void refreshClock([DateTime? at]) {
    if (!isCurrent) return;
    final now = at ?? DateTime.now(), previous = _lastHomeClock;
    _lastHomeClock = now;
    if (previous != null) {
      final previousUtc = previous.toUtc(), nowUtc = now.toUtc();
      if (previous.year != now.year ||
          previous.month != now.month ||
          previous.day != now.day ||
          previous.hour != now.hour ||
          previous.timeZoneOffset != now.timeZoneOffset ||
          previousUtc.year != nowUtc.year ||
          previousUtc.month != nowUtc.month ||
          previousUtc.day != nowUtc.day) {
        observe(home.refresh(request: request(now)));
        return;
      }
    }
    home.request = request(now);
  }

  void remember(Iterable<Track> tracks) {
    if (!isCurrent) return;
    for (final track in tracks) {
      _known[track.ref.identityKey] = track;
    }
    while (_known.length > 2000) {
      _known.remove(_known.keys.first);
    }
  }

  void rememberQueue(Iterable<Track> tracks, {bool append = false}) {
    if (!isCurrent) return;
    if (!append) _queueOriginal.clear();
    for (final track in tracks) {
      _queueOriginal[track.ref.identityKey] = track;
    }
    remember(tracks);
  }

  Track? knownTrack(TrackRef ref) {
    final original = _queueOriginal[ref.identityKey] ?? _known[ref.identityKey];
    if (original != null) return original;
    final candidates = [
      ...owner.playback.snapshot.entries.map((e) => e.track),
      ...likes.state.tracks,
      ...search.state.page.tracks,
      ...home.state.feed.shelves.expand((s) => s.tracks),
      ...home.state.feed.mixes.expand((m) => m.tracks),
      ...downloads.jobs.map((j) => j.track),
    ];
    for (final track in candidates) {
      if (track.ref == ref) return track;
    }
    return _queueOriginal[ref.identityKey] ?? _known[ref.identityKey];
  }

  Future<void> _prefetchWindow(List<Track> window) async {
    for (final track in window) {
      if (!isCurrent) return;
      await owner.artwork.load(ref: track.ref, hint: track.artwork);
    }
  }

  Future<void> _present(String action, PlayerTrackTarget target) async {
    await target.assertCurrent();
    await guard();
    final ui = presentation;
    if (ui == null) throw collectionStaleSession;
    await ui.trackAction(action, target);
  }

  Future<void> endSession() async {
    await guard();
    await logout();
  }

  Future<void>? _closing;
  Future<void> close() {
    if (_closing != null) return _closing!;
    presentation = null;
    final retired = lifetime.close();
    return _closing = () async {
      try {
        await retired;
      } finally {
        await Future.wait(_pending.toList());
        await _settingsTail;
        _known.clear();
        _queueOriginal.clear();
        notice.dispose();
      }
    }();
  }
}
