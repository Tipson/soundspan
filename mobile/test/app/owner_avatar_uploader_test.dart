import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/app/owner_avatar_uploader.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/features/settings/settings_models.dart';

import '../support/fake_tls_server.dart';
import '../support/media_fixtures.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  // This file tests real loopback TLS. Flutter's default widget HTTP mock
  // returns synthetic400 before the server sees a request.
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

  test(
    'multipart upload sends one exact owner header and actual immutable image',
    () async {
      final bodies = <List<int>>[];
      final server = await FakeTlsServer.start((request) async {
        expect(request.method, 'POST');
        expect(request.uri.path, '/api/settings/profile-picture');
        expect(request.uri.query, isEmpty);
        expect(request.headers.value('authorization'), 'Bearer initial');
        expect(request.headers.contentType!.mimeType, 'multipart/form-data');
        bodies.add(await request.expand((b) => b).toList());
        request.response.headers.contentType = ContentType.json;
        request.response.write('{"success":true}');
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
      try {
        await uploader.upload(image, fence);
        expect(bodies, hasLength(1));
        final body = latin1.decode(bodies.single);
        expect(body, contains('name="file"; filename="avatar.png"'));
        expect(body, contains('Content-Type: image/png'));
        expect(body, contains(latin1.decode(image.bytes)));
        expect(body, isNot(contains('Bearer')));
        expect(uploader.picture.value, image.bytes);
      } finally {
        await uploader.close();
        await authority.invalidate();
        await server.close();
      }
    },
  );

  test('offline and a borrowed owner epoch perform zero HTTP', () async {
    var requests = 0;
    final server = await FakeTlsServer.start((request) async {
      requests++;
      await request.response.close();
    });
    final authority = await mediaAuthority(server.origin);
    final fence = authority.requireFence();
    final uploader = OwnerAvatarUploader(
      authority: authority,
      fence: fence,
      networkPolicy: const NetworkPolicy.offline(),
      securityContext: server.clientContext,
    );
    try {
      await expectLater(
        uploader.upload(image, fence),
        throwsA(
          isA<AppFailure>().having((e) => e.code, 'code', 'offline_mode'),
        ),
      );
      await expectLater(
        uploader.upload(
          image,
          SessionFence(owner: fence.owner, epoch: fence.epoch + 1),
        ),
        throwsA(isA<AppFailure>()),
      );
      expect(requests, 0);
    } finally {
      await uploader.close();
      await authority.invalidate();
      await server.close();
    }
  });

  test(
    'cold profile picture uses only the fenced owner and validates pixels',
    () async {
      final server = await FakeTlsServer.start((request) async {
        expect(request.method, 'GET');
        expect(request.uri.path, '/api/social/profile-picture/media-user');
        expect(request.uri.query, isEmpty);
        expect(request.headers.value('authorization'), 'Bearer initial');
        request.response.headers.contentType = ContentType('image', 'png');
        request.response.add(image.bytes);
        await request.response.close();
      });
      final authority = await mediaAuthority(server.origin);
      final uploader = OwnerAvatarUploader(
        authority: authority,
        fence: authority.requireFence(),
        networkPolicy: const NetworkPolicy.online(),
        securityContext: server.clientContext,
      );
      try {
        await (uploader as dynamic).loadPicture();
        expect(uploader.picture.value, image.bytes);
      } finally {
        await uploader.close();
        await authority.invalidate();
        await server.close();
      }
    },
  );

  test('missing picture clears a previous confirmed picture', () async {
    final server = await FakeTlsServer.start((request) async {
      await request.drain<void>();
      if (request.method == 'POST') {
        request.response.headers.contentType = ContentType.json;
        request.response.write('{"success":true}');
      } else {
        request.response.statusCode = 404;
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
    try {
      await uploader.upload(image, fence);
      expect(uploader.picture.value, isNotNull);
      await (uploader as dynamic).loadPicture();
      expect(uploader.picture.value, isNull);
    } finally {
      await uploader.close();
      await authority.invalidate();
      await server.close();
    }
  });

  for (final oversized in [false, true]) {
    test(
      'picture rejects ${oversized ? 'oversized body' : 'HTML instead of image'}',
      () async {
        final server = await FakeTlsServer.start((request) async {
          if (oversized) {
            request.response.headers.contentType = ContentType('image', 'png');
            request.response.contentLength = AvatarInput.maxBytes + 1;
            request.response.add(Uint8List(AvatarInput.maxBytes + 1));
          } else {
            request.response.headers.contentType = ContentType.html;
            request.response.write('<html>private server error</html>');
          }
          try {
            await request.response.close();
          } catch (_) {}
        });
        final authority = await mediaAuthority(server.origin);
        final uploader = OwnerAvatarUploader(
          authority: authority,
          fence: authority.requireFence(),
          networkPolicy: const NetworkPolicy.online(),
          securityContext: server.clientContext,
        );
        try {
          await expectLater(
            (uploader as dynamic).loadPicture(),
            throwsA(isA<AppFailure>()),
          );
          expect(uploader.picture.value, isNull);
        } finally {
          await uploader.close();
          await authority.invalidate();
          await server.close();
        }
      },
    );
  }

  for (final replace in [false, true]) {
    test(
      'late GET cannot restore a ${replace ? 'replaced' : 'removed'} photo',
      () async {
        final received = Completer<void>();
        final release = Completer<void>();
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
        try {
          final loading = (uploader as dynamic).loadPicture() as Future<void>;
          await received.future;
          if (replace) {
            await uploader.upload(image, fence);
          } else {
            (uploader as dynamic).clearPicture();
          }
          final confirmed = uploader.picture.value;
          release.complete();
          await loading;
          expect(identical(uploader.picture.value, confirmed), isTrue);
        } finally {
          if (!release.isCompleted) release.complete();
          await uploader.close();
          await authority.invalidate();
          await server.close();
        }
      },
    );
  }

  test(
    'a redirect cannot forward the profile image or bearer to another origin',
    () async {
      var foreign = 0;
      final other = await FakeTlsServer.start((request) async {
        foreign++;
        await request.response.close();
      });
      final server = await FakeTlsServer.start((request) async {
        await request.drain<void>();
        request.response.statusCode = 307;
        request.response.headers.set(
          'location',
          other.origin.resolve('/foreign').toString(),
        );
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
      try {
        await expectLater(
          uploader.upload(image, fence),
          throwsA(
            isA<AppFailure>().having(
              (e) => e.code,
              'code',
              'api_redirect_rejected',
            ),
          ),
        );
        expect(foreign, 0);
      } finally {
        await uploader.close();
        await authority.invalidate();
        await server.close();
        await other.close();
      }
    },
  );

  test(
    'a refused mutation refreshes credentials without replaying the upload',
    () async {
      var requests = 0;
      final server = await FakeTlsServer.start((request) async {
        requests++;
        await request.drain<void>();
        request.response.statusCode = 401;
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
      try {
        await expectLater(
          uploader.upload(image, fence),
          throwsA(isA<AppFailure>().having((e) => e.statusCode, 'status', 401)),
        );
        expect(requests, 1);
        expect(
          (await authority.grantAccess(fence, server.origin)).accessToken,
          'fresh',
        );
      } finally {
        await uploader.close();
        await authority.invalidate();
        await server.close();
      }
    },
  );

  test(
    'offline cancellation is sticky after online resumes and close drains IO',
    () async {
      final received = Completer<void>();
      final release = Completer<void>();
      final server = await FakeTlsServer.start((request) async {
        await request.drain<void>();
        received.complete();
        await release.future;
        try {
          request.response.headers.contentType = ContentType.json;
          request.response.write('{"success":true}');
          await request.response.close();
        } catch (_) {}
      });
      final authority = await mediaAuthority(server.origin);
      final fence = authority.requireFence();
      final policy = _Policy();
      final uploader = OwnerAvatarUploader(
        authority: authority,
        fence: fence,
        networkPolicy: policy,
        securityContext: server.clientContext,
      );
      try {
        final uploading = uploader.upload(image, fence);
        final observed = expectLater(uploading, throwsA(isA<AppFailure>()));
        await received.future;
        policy.set(false);
        policy.set(true);
        final closing = uploader.close();
        await observed;
        await closing;
        expect(uploader.picture.value, isNull);
        release.complete();
      } finally {
        if (!release.isCompleted) release.complete();
        await uploader.close();
        await authority.invalidate();
        await server.close();
        policy.dispose();
      }
    },
  );

  test('old owner response cannot publish another account picture', () async {
    final received = Completer<void>();
    final release = Completer<void>();
    final server = await FakeTlsServer.start((request) async {
      await request.drain<void>();
      received.complete();
      await release.future;
      try {
        request.response.headers.contentType = ContentType.json;
        request.response.write('{"success":true}');
        await request.response.close();
      } catch (_) {}
    });
    final authority = await mediaAuthority(server.origin);
    final fence = authority.requireFence();
    final uploader = OwnerAvatarUploader(
      authority: authority,
      fence: fence,
      networkPolicy: const NetworkPolicy.online(),
      securityContext: server.clientContext,
    );
    try {
      final uploading = uploader.upload(image, fence);
      final observed = expectLater(uploading, throwsA(isA<AppFailure>()));
      await received.future;
      await authority.invalidate();
      release.complete();
      await observed;
      expect(uploader.picture.value, isNull);
    } finally {
      if (!release.isCompleted) release.complete();
      await uploader.close();
      await authority.invalidate();
      await server.close();
    }
  });
}

class _Policy extends ChangeNotifier implements NetworkPolicy {
  bool allowed = true;
  void set(bool value) {
    allowed = value;
    notifyListeners();
  }

  @override
  bool get networkAllowed => allowed;
  @override
  void requireNetwork() {
    if (!allowed) {
      throw const AppFailure(code: 'offline_mode', message: 'Офлайн');
    }
  }
}
