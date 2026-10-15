import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../core/session/session_authority.dart';

import '../../core/model/app_failure.dart';
import '../library/library_models.dart';
import 'settings_models.dart';
import 'settings_repository.dart';

class SettingsController extends ChangeNotifier {
  SettingsController({
    required this.repository,
    required this.quality,
    required this.setQuality,
    this.initialLoudnessMode = LoudnessMode.auto,
  }) {
    quality.addListener(_notify);
    _session = repository.authority.changes.listen((_) => _notify());
  }
  late final StreamSubscription<SessionState> _session;
  final SettingsRepository repository;
  final ValueListenable<String> quality;
  final Future<void> Function(String) setQuality;

  /// Last confirmed owner-scoped device setting, loaded before feature startup.
  final LoudnessMode initialLoudnessMode;
  UserSettings? _settings;
  UserSettings? get settings => isCurrent ? _settings : null;
  LoudnessMode get loudnessMode =>
      settings?.loudnessMode ?? initialLoudnessMode;
  AppFailure? failure;
  bool busy = false, loading = false, _disposed = false;
  bool get isCurrent => !_disposed && repository.isCurrent;
  bool get canEdit => isCurrent && !busy && !loading;
  bool get canUpload => repository.avatarUploader != null;
  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> load() async {
    if (!isCurrent || loading || busy) return;
    loading = true;
    failure = null;
    _notify();
    try {
      final next = await repository.load(current: () => isCurrent);
      if (isCurrent) _settings = next;
    } catch (e) {
      if (isCurrent) failure = collectionFailure(e);
    } finally {
      loading = false;
      _notify();
    }
  }

  Future<bool> _mutate(Future<void> Function() action) async {
    if (!canEdit) return false;
    busy = true;
    failure = null;
    _notify();
    try {
      await repository.guard(() => isCurrent);
      await action();
      await repository.guard(() => isCurrent);
      return true;
    } catch (e) {
      if (isCurrent) failure = collectionFailure(e);
      return false;
    } finally {
      busy = false;
      _notify();
    }
  }

  Future<bool> update(UserSettingsPatch patch) => _mutate(() async {
    final next = await repository.update(
      patch,
      hasProfilePicture: _settings?.hasProfilePicture,
      current: () => isCurrent,
    );
    if (isCurrent) _settings = next;
  });
  Future<bool> changeQuality(String value) => _mutate(() => setQuality(value));
  Future<bool> uploadAvatar(AvatarInput input) => _mutate(() async {
    await repository.uploadAvatar(input, current: () => isCurrent);
    if (isCurrent) _settings = _settings?.withProfilePicture(true);
  });
  Future<bool> removeAvatar() => _mutate(() async {
    await repository.removeAvatar(current: () => isCurrent);
    if (isCurrent) _settings = _settings?.withProfilePicture(false);
  });
  @override
  void dispose() {
    _disposed = true;
    unawaited(_session.cancel());
    quality.removeListener(_notify);
    super.dispose();
  }
}
