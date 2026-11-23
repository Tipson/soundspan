import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/app/owner_avatar_uploader.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/features/settings/settings_controller.dart';
import 'package:soundspan/features/settings/settings_models.dart';
import 'package:soundspan/features/settings/settings_repository.dart';

import '../support/collection_fixtures.dart';
import '../support/fake_tls_server.dart';
import '../support/media_fixtures.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  HttpOverrides.global = null;
  late AvatarInput image;
  setUpAll(() async {
    final recorder = ui.PictureRecorder();
    ui.Canvas(recorder).drawColor(const ui.Color(0xff907ab2), ui.BlendMode.src);
    final picture = recorder.endRecording();
    final raster = await picture.toImage(16, 16);
    try {
      image = await AvatarInput.validate(
        (await raster.toByteData(format: ui.ImageByteFormat.png))!.buffer
            .asUint8List(),
      );
    } finally {
      raster.dispose();
      picture.dispose();
    }
  });

  Future<void> scenario({
    int deleteStatus = 200,
    bool receipt = true,
    bool latePicture = false,
    bool uploadInstead = false,
  }) async {
    final received = Completer<void>(), release = Completer<void>();
    final server = await FakeTlsServer.start((request) async {
      await request.drain<void>();
      if (request.method == 'GET') {
        received.complete();
        await release.future;
        request.response.headers.contentType = ContentType('image', 'png');
        request.response.add(image.bytes);
      } else {
        request.response.headers.contentType = ContentType.json;
        request.response.write('{"success":true}');
      }
      await request.response.close();
    });
    final authority = await mediaAuthority(server.origin);
    final fence = authority.requireFence();
    final uploader = OwnerAvatarUploader(
      authority: authority,
      fence: fence,
      networkPolicy: const NetworkPolicy.online(),
      securityContext: server.clientContext,
    );
    var reads = 0, deletes = 0;
    final repository = SettingsRepository(
      transport: CollectionTransport((request, _) {
        if (request.method == ApiMethod.delete) {
          deletes++;
          return ApiResponse(deleteStatus, {'success': receipt});
        }
        reads++;
        // A settings refresh is unavailable after the deletion attempt.
        return deletes > 0 || (uploadInstead && uploader.picture.value != null)
            ? const ApiResponse(503, {})
            : ApiResponse(200, {
                'displayName': 'Listener',
                'hasProfilePicture': !uploadInstead,
                'loudnessMode': 'album',
                'shareOnlinePresence': true,
                'shareListeningStatus': true,
              });
      }),
      authority: authority,
      fence: fence,
      networkPolicy: const NetworkPolicy.online(),
      avatarUploader: uploader,
    );
    final quality = ValueNotifier('original');
    final controller = SettingsController(
      repository: repository,
      quality: quality,
      setQuality: (_) async {},
    );
    Future<void>? loading;
    try {
      if (!uploadInstead) await uploader.upload(image, fence);
      await controller.load();
      if (latePicture) {
        loading = uploader.loadPicture();
        await received.future;
      }
      final removed = uploadInstead
          ? await controller.uploadAvatar(image)
          : await controller.removeAvatar();
      final confirmed = deleteStatus == 200 && receipt;
      expect(removed, confirmed);
      expect(deletes, uploadInstead ? 0 : 1);
      expect(
        reads,
        1,
        reason: 'Acknowledged DELETE needs no second settings read.',
      );
      expect(
        controller.settings!.hasProfilePicture,
        uploadInstead || !confirmed,
      );
      expect(controller.settings!.displayName, 'Listener');
      expect(controller.settings!.loudnessMode, LoudnessMode.album);
      expect(controller.settings!.shareOnlinePresence, isTrue);
      expect(controller.settings!.shareListeningStatus, isTrue);
      expect(
        uploader.picture.value,
        confirmed && !uploadInstead ? isNull : image.bytes,
      );
      if (latePicture) {
        release.complete();
        await loading;
        expect(uploader.picture.value, isNull);
      }
    } finally {
      if (!release.isCompleted) release.complete();
      await loading;
      controller.dispose();
      repository.dispose();
      quality.dispose();
      await uploader.close();
      await authority.invalidate();
      await server.close();
    }
  }

  test(
    'confirmed removal clears pixels and preserves confirmed settings without a reload',
    () => scenario(),
  );
  test(
    'late picture response cannot resurrect an acknowledged deletion',
    () => scenario(latePicture: true),
  );
  test(
    'refused deletion keeps the current photo and settings',
    () => scenario(deleteStatus: 403),
  );
  test(
    'unacknowledged deletion keeps the current photo and settings',
    () => scenario(receipt: false),
  );
  test(
    'acknowledged upload preserves the confirmed picture without a settings reload',
    () => scenario(uploadInstead: true),
  );
}
