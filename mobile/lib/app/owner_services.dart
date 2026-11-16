import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';

import '../artwork/artwork_repository.dart';
import '../core/model/app_failure.dart';
import '../core/model/owner_key.dart';
import '../core/model/track.dart';
import '../core/network/dart_api_transport.dart';
import '../core/network/stored_network_policy.dart';
import '../core/session/session_authority.dart';
import '../core/storage/owner_store.dart';
import '../downloads/android_media_probe.dart';
import '../downloads/download_models.dart';
import '../downloads/download_repository.dart';
import '../downloads/download_verifier.dart';
import '../downloads/download_worker_bridge.dart';
import '../downloads/private_media_paths.dart';
import '../downloads/protected_media_fetcher.dart';
import '../features/recommendations/recommendation_repository.dart';
import '../playback/feedback_outbox.dart';
import '../playback/finite_queue_admission_api.dart';
import '../playback/finite_queue_admission_coordinator.dart';
import '../playback/local_first_preparation.dart';
import '../playback/loudness_gain_policy.dart';
import '../playback/native_loudness_controller.dart';
import '../playback/media_gateway.dart';
import '../playback/next_track_warmup.dart';
import '../playback/notification_artwork_bridge.dart';
import '../playback/playback_controller.dart';
import '../playback/playback_engine.dart';
import '../playback/playback_reporter.dart';
import '../playback/play_create_journal.dart';
import '../playback/playback_resolver.dart';
import '../playback/protected_audio_warmup.dart';
import '../playback/resolved_media.dart';
import '../playback/queue_checkpoint_observer.dart';
import '../playback/queue_coordinator.dart';
import '../playback/queue_snapshot_store.dart';
import '../playback/service_playback_controller.dart';
import '../playback/wave_continuation.dart';
import 'app_environment.dart';
import 'server_capabilities.dart';

/// Feature-independent resources for one immutable broker fence.
final class NativeOwnerServices implements AppOwnerScope {
  NativeOwnerServices._({
    required this.authority,
    required this.fence,
    required OwnerStore store,
    required this.playback,
    required this.supportDirectory,
    required this.cancelDownloads,
  }) : _store = _OwnerStoreLease(store, fence),
       _checkpointLease = _OwnerStoreLease(store, fence);
  final SessionAuthority authority;
  @override
  final SessionFence fence;
  final _OwnerStoreLease _store;
  final _OwnerStoreLease _checkpointLease;
  OwnerStore get store => _store;
  final PlaybackController playback;
  final Directory supportDirectory;
  final Future<void> Function(SessionFence) cancelDownloads;
  late final StoredNetworkPolicy policy;
  late final DartApiTransport transport;
  late final FiniteQueueAdmissionCoordinator finiteAdmission;
  late final DartJsonHttpClient _json;
  late final DownloadRepository downloads;
  late final ArtworkRepository artwork;
  late final MediaGateway gateway;
  NextTrackWarmup? _warmup;
  late final WaveContinuation wave;
  late final PlaybackReporter reporter;
  late final FeedbackOutbox outbox;
  late final PlayCreateJournal playCreates;
  late final QueueSnapshotStore queueStore;
  late final QueueCheckpointObserver checkpoint;
  late final ServerCapabilitiesRepository capabilities;
  NotificationArtworkBridge? _notification;
  final quality = ValueNotifier<String>('original');
  final qualityFailure = ValueNotifier<AppFailure?>(null);
  final loudnessMode = ValueNotifier<LoudnessMode>(LoudnessMode.auto);
  final loudnessFailure = ValueNotifier<AppFailure?>(null);
  final gainAvailable = ValueNotifier<bool>(false);
  NativeLoudnessController? _loudness;
  Future<void> _loudnessTail = Future.value();
  Future<void> _qualityTail = Future.value();
  bool _closed = false;
  int _networkRevision = 0;
  Future<void>? _closing;
  final _retire = <Future<void> Function()>[];
  final _blockedFiles = <Uri, int>{};
  final _preparations = <Future<PreparedAudio>>{};

  static Future<NativeOwnerServices> create({
    required SessionAuthority authority,
    required OwnerStore store,
    required SessionFence fence,
    required PlaybackController playback,
    required Directory supportDirectory,
    Future<void> Function(SessionFence)? cancelDownloads,
    MediaProbe mediaProbe = const AndroidMediaProbe(),
    SecurityContext? securityContext,
  }) async {
    final owner = NativeOwnerServices._(
      authority: authority,
      store: store,
      fence: fence,
      playback: playback,
      supportDirectory: supportDirectory,
      cancelDownloads:
          cancelDownloads ??
          (f) => const DownloadWorkerBridge().cancel(f.owner),
    );
    try {
      await owner._initialize(mediaProbe, securityContext);
      return owner;
    } catch (_) {
      await owner.close();
      rethrow;
    }
  }

  bool get _current => !_closed && authority.isCurrent(fence);
  Future<void> _guard() async {
    if (!_current) throw _stale;
    await authority.assertCurrent(fence);
    if (!_current) throw _stale;
  }

  Future<void> _initialize(MediaProbe probe, SecurityContext? tls) async {
    await _guard();
    policy = await StoredNetworkPolicy.restore(
      store: store,
      authority: authority,
      fence: fence,
      onOffline: _offline,
    );
    _retire.add(policy.close);
    await _guard();
    // Restoring an offline preference does not call setOffline's callback.
    if (!policy.networkAllowed) await cancelDownloads(fence);
    await _guard();
    _json = DartJsonHttpClient(networkPolicy: policy, securityContext: tls);
    _retire.add(_json.close);
    transport = DartApiTransport(client: _json, authority: authority);
    finiteAdmission = FiniteQueueAdmissionCoordinator(
      api: FiniteQueueAdmissionApi(transport: transport),
      authority: authority,
      snapshot: () => playback.snapshot,
      snapshots: playback.snapshots,
    );
    final queue = switch (playback) {
      ServicePlaybackController service => service.handler.coordinator,
      QueueCoordinator coordinator => coordinator,
      _ => null,
    };
    queue?.finiteAdmission = finiteAdmission;
    _retire.add(() {
      if (identical(queue?.finiteAdmission, finiteAdmission)) {
        queue?.finiteAdmission = null;
      }
      return finiteAdmission.close();
    });
    gateway = MediaGateway(
      authority: authority,
      fetcher: ProtectedMediaFetcher(
        authority: authority,
        securityContext: tls,
      ),
    );
    _retire.add(gateway.close);
    void closeMediaAdmission() {
      if (!policy.networkAllowed) {
        _networkRevision++;
        _warmup?.cancelNetwork();
        unawaited(gateway.revoke(fence));
      }
    }

    policy.addListener(closeMediaAdmission);
    _retire.add(() async => policy.removeListener(closeMediaAdmission));
    final paths = await PrivateMediaPaths.create(
      Directory(
        '${supportDirectory.path}${Platform.pathSeparator}device-media',
      ),
    );
    downloads = DownloadRepository(
      store: store,
      authority: authority,
      paths: paths,
      verifier: DownloadVerifier(probe: probe),
      beforeRemove: _beforeRemove,
    );
    artwork = ArtworkRepository(
      authority: authority,
      store: store,
      fence: fence,
      networkPolicy: policy,
      privateRoot: Directory(
        '${supportDirectory.path}${Platform.pathSeparator}artwork-cache',
      ),
      testSecurityContext: tls,
    );
    _retire.add(artwork.close);
    await _loadQuality();
    await _loadLoudness();
    // The final service checkpoint drains after public feature admission closes.
    queueStore = QueueSnapshotStore(_checkpointLease);
    final initial = playback.snapshot;
    if (initial.entries.isEmpty) {
      final restored = await queueStore.load(fence);
      await _guard();
      if (restored != null &&
          playback.snapshot.entries.isEmpty &&
          playback.snapshot.lineage == initial.lineage) {
        await playback.dispatch(
          RestoreQueue(
            restored,
            fence: fence,
            expectedLineage: initial.lineage,
          ),
        );
      }
    }
    checkpoint = QueueCheckpointObserver(
      playback: playback,
      authority: authority,
      fence: fence,
      save: queueStore.save,
    );
    _retire.add(checkpoint.close);
    final recommendations = RecommendationRepository(
      transport: transport,
      networkPolicy: policy,
    );
    outbox = FeedbackOutbox(
      store: store,
      repository: recommendations,
      authority: authority,
      networkPolicy: policy,
    );
    capabilities = ServerCapabilitiesRepository(
      transport: transport,
      store: store,
      authority: authority,
      fence: fence,
      policy: policy,
    );
    _retire.add(capabilities.close);
    playCreates = PlayCreateJournal(
      store: _checkpointLease,
      repository: recommendations,
      outbox: outbox,
      capabilities: capabilities,
      authority: authority,
      fence: fence,
      networkPolicy: policy,
    );
    _retire.add(playCreates.close);
    capabilities.onPlayCreationRefresh = () =>
        unawaited(playCreates.flush(refresh: false).catchError((Object _) {}));
    void playDeliveryPolicyChanged() {
      if (policy.networkAllowed) {
        unawaited(playCreates.recover().catchError((Object _) {}));
      } else {
        playCreates.cancelNetwork();
      }
    }

    policy.addListener(playDeliveryPolicyChanged);
    _retire.add(() async => policy.removeListener(playDeliveryPolicyChanged));
    wave = WaveContinuation(
      controller: playback,
      repository: recommendations,
      authority: authority,
    );
    _retire.add(wave.dispose);
    _warmup = NextTrackWarmup(
      controller: playback,
      authority: authority,
      networkAllowed: () => _current && policy.networkAllowed,
      warm: _warmNext,
      finiteAdmission: finiteAdmission,
    );
    _retire.add(_warmup!.close);
    reporter = PlaybackReporter(
      controller: playback,
      repository: recommendations,
      outbox: outbox,
      authority: authority,
      networkPolicy: policy,
      journal: playCreates,
    );
    _retire.add(reporter.dispose);
    await capabilities.restore();
    unawaited(playCreates.recover().catchError((Object _) {}));
    if (playback case ServicePlaybackController service) {
      _notification = NotificationArtworkBridge(
        handler: service.handler,
        artwork: artwork,
        authority: authority,
        fence: fence,
      );
      _retire.add(_notification!.close);
    }
    await _guard();
  }

  Future<void> _offline(SessionFence original) async {
    if (original != fence || !_current) throw _stale;
    _warmup?.cancelNetwork();
    artwork.cancelNetwork();
    await Future.wait<void>([
      _json.cancelPending(),
      gateway.revoke(original),
      cancelDownloads(original),
    ]);
  }

  Future<void> _loadQuality() async {
    final row = await store.transaction(
      fence,
      (tx) => tx.read('settings', 'playbackQuality'),
    );
    await _guard();
    if (row == null) return;
    if (row.length != 2 ||
        row['version'] != 1 ||
        !_qualities.contains(row['value'])) {
      qualityFailure.value = const AppFailure(
        code: 'invalid_playback_quality',
        message: 'Настройка качества повреждена. Используется оригинальное качество.',
      );
      return;
    }
    quality.value = row['value'] as String;
  }

  static const _qualities = {'original', 'high', 'medium', 'low'};
  Future<void> _loadLoudness() async {
    try {
      final row = await store.transaction(
        fence,
        (tx) => tx.read('settings', 'loudness'),
      );
      await _guard();
      if (row != null) {
        if (row.length != 2 ||
            row['version'] != 1 ||
            !LoudnessMode.values.any((mode) => mode.name == row['value'])) {
          throw const FormatException('Invalid loudness preference');
        }
        loudnessMode.value = LoudnessMode.values.firstWhere(
          (mode) => mode.name == row['value'],
        );
      }
    } catch (_) {
      await _guard();
      loudnessMode.value = LoudnessMode.off;
      loudnessFailure.value = const AppFailure(
        code: 'invalid_loudness_mode',
        message: 'Не удалось прочитать настройку громкости. Нормализация выключена; проверьте настройки воспроизведения.',
      );
    }
    final engine = switch (playback) {
      ServicePlaybackController service => service.handler.coordinator.engine,
      QueueCoordinator queue => queue.engine,
      _ => null,
    };
    if (engine case LoudnessPlaybackEngine gainEngine) {
      final gain = _loudness = gainEngine.loudness;
      void changed() {
        if (!_current) return;
        gainAvailable.value = gain.gainAvailable.value;
        if (gain.failure.value != null) {
          loudnessFailure.value = gain.failure.value;
        } else if (loudnessFailure.value?.code == 'loudness_unavailable') {
          loudnessFailure.value = null;
        }
      }

      gain.gainAvailable.addListener(changed);
      gain.failure.addListener(changed);
      _retire.add(() async {
        gain.gainAvailable.removeListener(changed);
        gain.failure.removeListener(changed);
        await gain.releaseOwner(fence);
      });
      await gain.setOwner(fence, loudnessMode.value, isCurrent: () => _current);
      changed();
    }
    await _guard();
  }

  /// Called only after a server-confirmed preference change. The canonical row
  /// is also the process service's offline/background startup preference.
  Future<void> setLoudnessMode(LoudnessMode mode) {
    final next = _loudnessTail.then((_) async {
      await _guard();
      await store.transaction(
        fence,
        (tx) => tx.write('settings', 'loudness', {
          'version': 1,
          'value': mode.name,
        }),
      );
      await _guard();
      await _loudness?.setOwner(fence, mode, isCurrent: () => _current);
      await _guard();
      loudnessMode.value = mode;
      loudnessFailure.value = _loudness?.failure.value;
    });
    _loudnessTail = next.then<void>((_) {}, onError: (Object _) {});
    return next;
  }

  Future<void> setQuality(String value) {
    if (!_qualities.contains(value)) {
      throw ArgumentError('Invalid playback quality');
    }
    final next = _qualityTail.then((_) async {
      await _guard();
      await store.transaction(
        fence,
        (tx) => tx.write('settings', 'playbackQuality', {
          'version': 1,
          'value': value,
        }),
      );
      await _guard();
      quality.value = value;
      qualityFailure.value = null;
    });
    _qualityTail = next.then<void>((_) {}, onError: (Object _) {});
    return next;
  }

  /// Feed original server metadata before durable codecs discard remote hints.
  Future<void> prefetchArtwork(Iterable<Track> tracks) async {
    for (final track in tracks) {
      if (!_current) return;
      await artwork.load(ref: track.ref, hint: track.artwork);
    }
  }

  @override
  Future<PreparedAudio> prepare(QueueEntry entry, SessionFence original) {
    if (original != fence || !_current) return Future.error(_stale);
    final operation = _prepare(entry);
    _preparations.add(operation);
    unawaited(
      operation.then<void>(
        (_) => _preparations.remove(operation),
        onError: (Object _) {
          _preparations.remove(operation);
        },
      ),
    );
    return operation;
  }

  List<String> _qualityOrder(String selected) => [
    selected,
    'original',
    'high',
    'medium',
    'low',
    'lossless',
    'HIGH',
    'MEDIUM',
    'LOW',
    'LOSSLESS',
  ];

  Future<void> _warmNext(
    QueueEntry entry,
    SessionFence original,
    MediaCancellation cancellation,
  ) async {
    final revision = _networkRevision;
    final selected = quality.value;
    void check() {
      cancellation.check();
      if (!_current ||
          original != fence ||
          revision != _networkRevision ||
          selected != quality.value) {
        throw mediaCancelled;
      }
      policy.requireNetwork();
    }

    check();
    for (final candidate in _qualityOrder(selected).toSet()) {
      final ready = await downloads.openReady(
        entry.track.ref,
        candidate,
        original,
      );
      check();
      if (ready != null) return;
    }
    await ProtectedAudioWarmup(
      resolver: PlaybackResolver(
        transport: transport,
        authority: authority,
        quality: selected,
      ),
      fetcher: gateway.fetcher,
      requireNetwork: check,
    ).warm(entry.track.ref, original, cancellation);
  }

  Future<PreparedAudio> _prepare(QueueEntry entry) async {
    final networkRevision = _networkRevision;
    await _guard();
    final selected = quality.value;
    final preparation = LocalFirstPreparation(
      authority: authority,
      policy: policy,
      qualities: () => _qualityOrder(selected),
      openReady: (ref, candidate, original) async {
        final file = await downloads.openReady(ref, candidate, original);
        if (file == null) return null;
        await _guard();
        if (_blockedFiles.containsKey(file.uri)) throw _busyFile;
        return file;
      },
      network: protectedAudioPreparation(
        PlaybackResolver(
          transport: transport,
          authority: authority,
          quality: selected,
        ),
        gateway,
      ),
    );
    final prepared = await preparation.prepare(entry, fence);
    try {
      await _guard();
      if (prepared.uri.scheme != 'file') {
        policy.requireNetwork();
        if (networkRevision != _networkRevision) {
          throw const AppFailure(
            code: 'network_cancelled',
            message: 'Запрос отменён.',
          );
        }
      }
      // Ready paths include immutable generation+claim. A deletion cannot be
      // undone by its tombstone incrementing the mutable journal generation.
      if (_blockedFiles.containsKey(prepared.uri)) throw _busyFile;
      return prepared;
    } catch (_) {
      await prepared.revoke();
      rethrow;
    }
  }

  Future<void> _beforeRemove(DeviceDownload job) async {
    await _guard();
    if (job.originalFence.owner != fence.owner) throw _stale;
    final files = <Uri>{};
    for (final cp in [
      ...job.files,
      if (job.checkpoint != null) job.checkpoint!,
    ]) {
      final file = await downloads.paths.file(
        fence.owner,
        job.id,
        cp.generation,
        cp.claim,
        ready: true,
      );
      files.add(file.uri);
    }
    await _guard();
    // Cover historical claims too: the decoder may still hold a previous ready
    // file after a corrupt/download generation has superseded its journal row.
    for (final file in files) {
      _blockedFiles.update(file, (count) => count + 1, ifAbsent: () => 1);
    }
    try {
      final coordinator = switch (playback) {
        ServicePlaybackController service => service.handler.coordinator,
        QueueCoordinator queue => queue,
        _ => throw StateError('File deletion requires process coordinator'),
      };
      for (final file in files) {
        final before = playback.snapshot;
        final released = await coordinator.releaseLocalFile(
          file,
          fence: fence,
          expectedEntryId: before.currentEntryId,
          expectedGeneration: before.generation,
          expectedLineage: before.lineage,
        );
        if (!released) throw _busyFile;
      }
    } catch (_) {
      // This callback rejected deletion. Drop only this attempt's reservation;
      // concurrent or successful deletions retain their own path reservations.
      for (final file in files) {
        final remaining = _blockedFiles[file]! - 1;
        if (remaining == 0) {
          _blockedFiles.remove(file);
        } else {
          _blockedFiles[file] = remaining;
        }
      }
      rethrow;
    }
  }

  @override
  Future<void> close() {
    if (_closing != null) return _closing!;
    _closed = true;
    _store.seal();
    final completion = Completer<void>();
    _closing = completion.future;
    completion.complete(_finishClose());
    return completion.future;
  }

  Future<void> _finishClose() async {
    Object? failure;
    Future<void> attempt(Future<void> Function() action) async {
      try {
        await action();
      } catch (error) {
        failure ??= error;
      }
    }

    // Start all cancellations synchronously; then drain each owned resource.
    final pending = <Future<void>>[];
    for (final action in _retire.reversed) {
      final operation = Future<void>.sync(action);
      pending.add(operation);
      unawaited(operation.then<void>((_) {}, onError: (Object _) {}));
    }
    if (!authority.isCurrent(fence)) {
      await attempt(() => cancelDownloads(fence));
    }
    for (final operation in pending) {
      await attempt(() => operation);
    }
    await attempt(() => _qualityTail);
    await attempt(() => _loudnessTail);
    await Future.wait(
      _preparations
          .map(
            (operation) => operation.then<void>((_) {}, onError: (Object _) {}),
          )
          .toList(),
    );
    await attempt(_store.close);
    await attempt(_checkpointLease.close);
    if (!authority.isCurrent(fence)) await attempt(_clearArtwork);
    quality.dispose();
    qualityFailure.dispose();
    loudnessMode.dispose();
    loudnessFailure.dispose();
    gainAvailable.dispose();
    if (failure != null) throw failure!;
  }

  Future<void> _clearArtwork() async {
    final root = Directory(
      '${supportDirectory.path}${Platform.pathSeparator}artwork-cache',
    );
    if (!await root.exists()) return;
    if (await root.resolveSymbolicLinks() != root.absolute.path) {
      throw const FileSystemException('Linked artwork root');
    }
    final hash = sha256
        .convert(
          utf8.encode(
            jsonEncode([
              fence.owner.serverOrigin.toString(),
              fence.owner.userId,
            ]),
          ),
        )
        .toString();
    final directory = Directory('${root.path}${Platform.pathSeparator}$hash');
    final type = await FileSystemEntity.type(
      directory.path,
      followLinks: false,
    );
    if (type == FileSystemEntityType.notFound) return;
    if (type != FileSystemEntityType.directory ||
        await directory.resolveSymbolicLinks() != directory.absolute.path) {
      throw const FileSystemException('Linked artwork owner');
    }
    final files = await directory.list(followLinks: false).toList();
    for (final file in files) {
      if (file is! File ||
          !RegExp(r'^[a-f0-9]{64}(?:-[a-f0-9]{64})?\.(?:png|part)$')
              .hasMatch(file.uri.pathSegments.last)) {
        throw const FileSystemException('Unexpected artwork entry');
      }
      if (await file.resolveSymbolicLinks() != file.absolute.path) {
        throw const FileSystemException('Linked artwork file');
      }
    }
    for (final file in files) {
      await file.delete();
    }
    await directory.delete();
  }

  static const _stale = AppFailure(
    code: 'stale_session',
    message: 'Сеанс завершён.',
  );
  static const _busyFile = AppFailure(
    code: 'download_in_use',
    message: 'Запись ещё используется плеером. Повторите удаление.',
    retryable: true,
  );
}

/// Closing an owner drains accepted writes and rejects late callbacks locally.
final class _OwnerStoreLease implements OwnerStore {
  _OwnerStoreLease(this.inner, this.originalFence);
  final OwnerStore inner;
  final SessionFence originalFence;
  bool _closed = false;
  final _pending = <Future<void>>{};
  @override
  Future<T> transaction<T>(
    SessionFence fence,
    Future<T> Function(OwnerTransaction) operation,
  ) {
    if (_closed || fence != originalFence) {
      return Future.error(NativeOwnerServices._stale);
    }
    final result = inner.transaction(fence, operation);
    final observed = result.then<void>((_) {}, onError: (Object _) {});
    _pending.add(observed);
    unawaited(observed.then((_) => _pending.remove(observed)));
    return result;
  }

  void seal() => _closed = true;
  Future<void> close() async {
    seal();
    await Future.wait(_pending.toList());
  }
}
