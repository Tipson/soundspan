import 'package:soundspan/app/native_app_update.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/features/updates/apk_update_controller.dart';
import 'package:soundspan/features/updates/apk_update_downloader.dart';
import 'package:soundspan/features/updates/mobile_release_manifest.dart';
import 'package:soundspan/features/updates/release_update_repository.dart';

import 'collection_fixtures.dart';
import 'update_fixtures.dart';

class UpdateTestDownload implements UpdateApkDownload {
  @override
  Future<void> prepare() async {}
  int downloads = 0, discarded = 0;
  @override
  Future<VerifiedApk> download(
    MobileReleaseManifest manifest, {
    required bool Function() isCurrent,
    required UpdateCancellation cancellation,
    void Function(int)? onProgress,
  }) async {
    cancellation.check();
    if (!isCurrent()) throw UpdateCancellation.cancelled;
    downloads++;
    return VerifiedApk('a' * 32, manifest);
  }

  @override
  Future<void> discard(VerifiedApk apk) async {
    discarded++;
  }

  @override
  Future<void> requireSpace(MobileReleaseManifest manifest) async {}
}

class UpdateTestInstaller implements AppUpdateInstaller {
  int infoCalls = 0, stages = 0, commits = 0, cancels = 0, settings = 0;
  bool permission = true, pending = false;
  Future<void> Function()? onStage;
  @override
  Future<InstalledAppInfo> installedInfo() async {
    infoCalls++;
    return installedUpdateApp;
  }

  @override
  Future<bool> installPermission() async => permission;
  @override
  Future<void> openInstallSettings() async {
    settings++;
  }

  @override
  Future<void> stageAndRequestInstall(
    VerifiedApk apk,
    String nonce,
    bool Function() isCurrent, {
    Future<void> Function()? beforeCommit,
  }) async {
    stages++;
    await onStage?.call();
    if (!isCurrent()) throw UpdateCancellation.cancelled;
    await beforeCommit?.call();
    if (!isCurrent()) throw UpdateCancellation.cancelled;
    commits++;
    pending = true;
  }

  @override
  Future<void> cancelOwn(String nonce) async {
    cancels++;
  }

  @override
  Future<bool> pendingInstall() async => pending;
  @override
  Future<void> cancelPendingInstall() async {
    pending = false;
    cancels++;
  }
}

class UpdateControllerFixture {
  UpdateControllerFixture() {
    repository = ReleaseUpdateRepository(
      transport: CollectionTransport((_, _) async {
        requests++;
        return ApiResponse(responseCode, dto);
      }),
      authority: authority,
      fence: collectionFence,
      networkPolicy: const NetworkPolicy.online(),
    );
    controller = ApkUpdateController(
      repository: repository,
      downloader: downloader,
      installer: installer,
      isCurrent: () => authority.isCurrent(collectionFence),
      networkPolicy: const NetworkPolicy.online(),
    );
    controller.open();
  }
  final authority = CollectionAuthority();
  final downloader = UpdateTestDownload();
  final installer = UpdateTestInstaller();
  int requests = 0, responseCode = 200;
  Map<String, Object?> dto = releaseDto();
  late final ReleaseUpdateRepository repository;
  late final ApkUpdateController controller;
  Future<void> ready() async {
    await controller.check();
    await controller.download();
  }

  Future<void> close() async {
    controller.dispose();
    repository.dispose();
    await authority.updates.close();
  }
}
