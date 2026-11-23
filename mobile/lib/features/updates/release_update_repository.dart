import '../../core/model/app_failure.dart';
import '../../core/network/api_transport.dart';
import '../lyrics/lyrics_repository.dart';
import 'mobile_release_manifest.dart';

enum ReleaseAvailabilityKind {
  unsupported,
  noRelease,
  current,
  update,
  incompatible,
}

final class ReleaseAvailability {
  const ReleaseAvailability(this.kind, [this.manifest]);
  final ReleaseAvailabilityKind kind;
  final MobileReleaseManifest? manifest;
}

class ReleaseUpdateRepository extends ExtrasRepository {
  ReleaseUpdateRepository({
    required super.transport,
    required super.authority,
    required super.fence,
    required super.networkPolicy,
  });
  Future<ReleaseAvailability> check({
    required InstalledAppInfo installed,
    bool Function()? current,
  }) async {
    await guard(current);
    networkPolicy.requireNetwork();
    if (!installed.trusted) {
      return const ReleaseAvailability(ReleaseAvailabilityKind.incompatible);
    }
    ApiResponse response;
    try {
      response = await transport.send(
        ApiRequest(
          origin: fence.owner.serverOrigin,
          method: ApiMethod.get,
          path: '/api/system/mobile-release/manifest',
          query: {'channel': installed.channel},
        ),
        fence: fence,
      );
      response.requireSuccess();
    } on AppFailure catch (e) {
      await guard(current);
      networkPolicy.requireNetwork();
      if (e.statusCode == 404) {
        return const ReleaseAvailability(ReleaseAvailabilityKind.unsupported);
      }
      rethrow;
    }
    await guard(current);
    networkPolicy.requireNetwork();
    if (response.statusCode == 204) {
      return const ReleaseAvailability(ReleaseAvailabilityKind.noRelease);
    }
    if (response.statusCode != 200) {
      throw const FormatException('Invalid release response');
    }
    final manifest = MobileReleaseManifest.decode(
      response.data,
      origin: fence.owner.serverOrigin,
    );
    if (manifest.channel != installed.channel ||
        manifest.minSdk > installed.sdk ||
        !manifest.abis.any(installed.abis.contains)) {
      return const ReleaseAvailability(ReleaseAvailabilityKind.incompatible);
    }
    if (manifest.versionCode <= installed.versionCode) {
      return const ReleaseAvailability(ReleaseAvailabilityKind.current);
    }
    if (manifest.requiredCapabilities.isNotEmpty) {
      final features = await request('/api/system/features', current: current);
      if (features is! Map ||
          manifest.requiredCapabilities.entries.any((e) {
            final feature = features[e.key];
            return feature is! Map ||
                feature['version'] is! int ||
                feature['version'] != e.value;
          })) {
        return const ReleaseAvailability(ReleaseAvailabilityKind.incompatible);
      }
    }
    await guard(current);
    return ReleaseAvailability(ReleaseAvailabilityKind.update, manifest);
  }
}
