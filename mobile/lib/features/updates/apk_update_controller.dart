import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../app/native_app_update.dart';
import '../../core/model/app_failure.dart';
import '../../core/network/api_transport.dart';
import '../../core/network/network_policy.dart';
import 'apk_update_downloader.dart';
import 'mobile_release_manifest.dart';
import 'release_update_repository.dart';

enum AppUpdatePhase {
  idle,
  checking,
  unsupported,
  noRelease,
  current,
  available,
  incompatible,
  downloading,
  ready,
  needsPermission,
  installing,
  pending,
  failed,
}

final class ApkUpdateController extends ChangeNotifier {
  ApkUpdateController({
    required this.repository,
    required this.downloader,
    required this.installer,
    required this.isCurrent,
    required this.networkPolicy,
    this.onDispose,
  }) {
    _session = repository.authority.changes.listen((_) {
      if (!isCurrent()) cancel();
    });
    if (networkPolicy is Listenable) {
      (networkPolicy as Listenable).addListener(_policyChanged);
    }
  }
  final ReleaseUpdateRepository repository;
  final UpdateApkDownload downloader;
  final AppUpdateInstaller installer;
  final bool Function() isCurrent;
  final NetworkPolicy networkPolicy;
  final VoidCallback? onDispose;
  AppUpdatePhase _phase = AppUpdatePhase.idle;
  String? _message;
  InstalledAppInfo? _installed;
  MobileReleaseManifest? _manifest;
  VerifiedApk? _apk;
  int _received = 0, _generation = 0;
  bool _open = false, _disposed = false;
  String? _nonce;
  UpdateCancellation? _cancellation;
  late final StreamSubscription<dynamic> _session;
  AppUpdatePhase get phase => _phase;
  String? get message => _message;
  InstalledAppInfo? get installed => _installed;
  MobileReleaseManifest? get manifest => _manifest;
  int get received => _received;
  bool get busy => const {
    AppUpdatePhase.checking,
    AppUpdatePhase.downloading,
    AppUpdatePhase.installing,
  }.contains(_phase);
  bool get canInstall =>
      _apk != null && !busy && _phase != AppUpdatePhase.pending;
  bool get canDownload =>
      _manifest != null &&
      _apk == null &&
      !busy &&
      _phase != AppUpdatePhase.pending;
  bool _current(int token) =>
      !_disposed && _open && token == _generation && isCurrent();
  void _guard(int token) {
    if (!_current(token)) throw UpdateCancellation.cancelled;
    networkPolicy.requireNetwork();
  }

  void _publish(AppUpdatePhase value) {
    _phase = value;
    if (!_disposed && _open) notifyListeners();
  }

  void open() {
    if (!_disposed) _open = true;
  }

  void leave() {
    _open = false;
    cancel();
  }

  void _policyChanged() {
    if (!networkPolicy.networkAllowed) networkChanged();
  }

  void networkChanged() {
    if (busy) cancel();
  }

  void cancel() {
    _generation++;
    _cancellation?.cancel();
    _cancellation = null;
    final nonce = _nonce;
    _nonce = null;
    if (nonce != null) {
      unawaited(installer.cancelOwn(nonce).catchError((Object _) {}));
    }
    if (busy) {
      _publish(
        _phase == AppUpdatePhase.installing
            ? AppUpdatePhase.pending
            : _apk != null
            ? AppUpdatePhase.ready
            : _manifest != null
            ? AppUpdatePhase.available
            : AppUpdatePhase.idle,
      );
    }
  }

  Future<void> _perform(
    AppUpdatePhase phase,
    Future<void> Function(int) work,
  ) async {
    if (busy || _disposed || !_open || !isCurrent()) return;
    final token = ++_generation;
    _cancellation = UpdateCancellation();
    _message = null;
    _publish(phase);
    try {
      _guard(token);
      await work(token);
    } catch (e) {
      if (!_current(token)) return;
      _message = e is AppFailure ? e.message : 'Не удалось проверить или подготовить обновление. Попробуйте ещё раз.';
      _publish(AppUpdatePhase.failed);
    }
  }

  Future<void> _discard() async {
    final apk = _apk;
    _apk = null;
    if (apk != null) await downloader.discard(apk);
  }

  Future<void> check() => _perform(AppUpdatePhase.checking, (token) async {
    _installed = await installer.installedInfo();
    _guard(token);
    final pending = await installer.pendingInstall();
    _guard(token);
    if (pending) {
      _publish(AppUpdatePhase.pending);
      return;
    }
    await _discard();
    _guard(token);
    await downloader.prepare();
    _guard(token);
    _manifest = null;
    final result = await repository.check(
      installed: _installed!,
      current: () => _current(token),
    );
    _guard(token);
    _manifest = result.manifest;
    _publish(switch (result.kind) {
      ReleaseAvailabilityKind.unsupported => AppUpdatePhase.unsupported,
      ReleaseAvailabilityKind.noRelease => AppUpdatePhase.noRelease,
      ReleaseAvailabilityKind.current => AppUpdatePhase.current,
      ReleaseAvailabilityKind.update => AppUpdatePhase.available,
      ReleaseAvailabilityKind.incompatible => AppUpdatePhase.incompatible,
    });
  });
  Future<void> _fresh(int token, MobileReleaseManifest expected) async {
    _guard(token);
    final installed = await installer.installedInfo();
    _guard(token);
    final result = await repository.check(
      installed: installed,
      current: () => _current(token),
    );
    _guard(token);
    if (result.kind != ReleaseAvailabilityKind.update ||
        result.manifest == null ||
        !expected.sameRelease(result.manifest!)) {
      throw const AppFailure(
        code: 'update_changed',
        message:
            'Обновление изменилось или больше недоступно. Проверьте его снова.',
      );
    }
    _installed = installed;
  }

  Future<void> download() async {
    final target = _manifest;
    if (target == null || _apk != null) return;
    await _perform(AppUpdatePhase.downloading, (token) async {
      await _fresh(token, target);
      _guard(token);
      _received = 0;
      final apk = await downloader.download(
        target,
        isCurrent: () => _current(token),
        cancellation: _cancellation!,
        onProgress: (bytes) {
          if (_current(token)) {
            _received = bytes;
            notifyListeners();
          }
        },
      );
      if (!_current(token)) {
        await downloader.discard(apk);
        return;
      }
      _guard(token);
      _apk = apk;
      _publish(AppUpdatePhase.ready);
    });
  }

  Future<void> install() async {
    final apk = _apk;
    if (apk == null) return;
    await _perform(AppUpdatePhase.installing, (token) async {
      await _fresh(token, apk.manifest);
      _guard(token);
      await downloader.requireSpace(apk.manifest);
      _guard(token);
      final permitted = await installer.installPermission();
      _guard(token);
      if (!permitted) {
        _publish(AppUpdatePhase.needsPermission);
        return;
      }
      final nonce = newPlaybackTraceId();
      _nonce = nonce;
      await installer.stageAndRequestInstall(
        apk,
        nonce,
        () => _current(token),
        beforeCommit: () => _fresh(token, apk.manifest),
      );
      if (_current(token)) _publish(AppUpdatePhase.pending);
    });
  }

  Future<void> openInstallSettings() =>
      _perform(AppUpdatePhase.checking, (token) async {
        await installer.openInstallSettings();
        _guard(token);
        _publish(
          AppUpdatePhase.needsPermission,
        ); // Returning from settings never installs.
      });
  Future<void> cancelPendingInstall() =>
      _perform(AppUpdatePhase.checking, (token) async {
        await installer.cancelPendingInstall();
        _guard(token);
        await _discard();
        _guard(token);
        _manifest = null;
        _publish(AppUpdatePhase.idle);
      });
  @override
  void dispose() {
    if (_disposed) return;
    leave();
    _disposed = true;
    unawaited(_session.cancel());
    if (networkPolicy is Listenable) {
      (networkPolicy as Listenable).removeListener(_policyChanged);
    }
    unawaited(_discard().catchError((Object _) {}));
    onDispose?.call();
    super.dispose();
  }
}
