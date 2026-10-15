import '../../core/model/owner_key.dart';
import '../../core/network/api_transport.dart';
import '../library/library_models.dart';
import '../lyrics/lyrics_repository.dart';
import 'settings_models.dart';

/// Composition supplies the same fenced credential/refresh/origin/network
/// checks as ApiTransport. Exact POST /api/settings/profile-picture, field=file;
/// no redirects, automatic mutation retries, or caller-controlled URLs.
abstract interface class AvatarUploader {
  Future<void> upload(AvatarInput input, SessionFence fence);
}

/// Optional in-memory picture cache. Invalidated only after an acknowledged
/// deletion for the repository's still-current owner.
abstract interface class AvatarPictureCache {
  void clearPicture();
}

class SettingsRepository extends ExtrasRepository {
  SettingsRepository({
    required super.transport,
    required super.authority,
    required super.fence,
    required super.networkPolicy,
    this.avatarUploader,
  });
  final AvatarUploader? avatarUploader;
  Future<UserSettings> load({bool Function()? current}) async =>
      UserSettings.fromJson(
        collectionObject(await request('/api/settings', current: current)),
      );
  Future<UserSettings> update(
    UserSettingsPatch patch, {
    bool? hasProfilePicture,
    bool Function()? current,
  }) async => UserSettings.fromJson(
    collectionObject(
      await request(
        '/api/settings',
        method: ApiMethod.post,
        body: patch.toJson(),
        current: current,
      ),
    ),
    hasProfilePicture: hasProfilePicture,
  );
  Future<void> uploadAvatar(
    AvatarInput input, {
    bool Function()? current,
  }) async {
    await guard(current);
    networkPolicy.requireNetwork();
    final uploader = avatarUploader;
    if (uploader == null) {
      throw UnsupportedError('Avatar upload is unavailable');
    }
    await uploader.upload(input, fence);
    await guard(current);
  }

  Future<void> removeAvatar({bool Function()? current}) async {
    final dto = collectionObject(
      await request(
        '/api/settings/profile-picture',
        method: ApiMethod.delete,
        current: current,
      ),
    );
    if (dto['success'] != true) {
      throw collectionFailure(StateError('avatar response'));
    }
    await guard(current);
    if (avatarUploader case final AvatarPictureCache cache) {
      cache.clearPicture();
    }
  }
}
