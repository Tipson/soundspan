import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/features/updates/apk_update_controller.dart';

import '../../support/update_controller_fixtures.dart';
import '../../support/update_fixtures.dart';

void main() {
  late UpdateControllerFixture f;
  setUp(() => f = UpdateControllerFixture());
  tearDown(() => f.close());
  test(
    'opening has no network/native IO and steps require separate actions',
    () async {
      expect(f.requests, 0);
      expect(f.installer.infoCalls, 0);
      await f.controller.check();
      expect(f.controller.phase, AppUpdatePhase.available);
      expect(f.downloader.downloads, 0);
      expect(f.installer.commits, 0);
      await f.controller.download();
      expect(f.controller.phase, AppUpdatePhase.ready);
      expect(f.installer.commits, 0);
      await f.controller.install();
      expect(f.installer.commits, 1);
      expect(
        f.controller.phase,
        AppUpdatePhase.pending,
      ); // Not installed/success.
    },
  );
  test('old server 404 is graceful without download/install', () async {
    f.responseCode = 404;
    await f.controller.check();
    expect(f.controller.phase, AppUpdatePhase.unsupported);
    expect(f.downloader.downloads, 0);
    expect(f.installer.stages, 0);
  });
  test(
    'denied permission and settings return never trigger automatic install',
    () async {
      await f.ready();
      f.installer.permission = false;
      await f.controller.install();
      expect(f.controller.phase, AppUpdatePhase.needsPermission);
      expect(f.installer.stages, 0);
      await f.controller.openInstallSettings();
      f.installer.permission = true;
      expect(f.installer.settings, 1);
      expect(f.installer.stages, 0);
      await f.controller.install();
      expect(f.installer.commits, 1);
    },
  );
  for (final kind in ['owner', 'route', 'cancel', 'network']) {
    test('$kind at held native stage never reaches commit', () async {
      await f.ready();
      final started = Completer<void>(), release = Completer<void>();
      f.installer.onStage = () {
        started.complete();
        return release.future;
      };
      final pending = f.controller.install();
      await started.future.timeout(const Duration(seconds: 1));
      switch (kind) {
        case 'owner':
          f.authority.switchOwner();
        case 'route':
          f.controller.leave();
        case 'cancel':
          f.controller.cancel();
        case 'network':
          f.controller.networkChanged();
      }
      release.complete();
      await pending;
      expect(f.installer.commits, 0);
      expect(f.installer.cancels, greaterThan(0));
    });
  }
  test(
    'manifest revoked while staging is rechecked before native commit',
    () async {
      await f.ready();
      f.installer.onStage = () async {
        f.responseCode = 404;
      };
      await f.controller.install();
      expect(f.installer.commits, 0);
      expect(f.controller.phase, AppUpdatePhase.failed);
    },
  );
  test(
    'changed release before download is rejected without using stale metadata',
    () async {
      await f.controller.check();
      f.dto = releaseDto(code: 30);
      await f.controller.download();
      expect(f.downloader.downloads, 0);
      expect(f.controller.phase, AppUpdatePhase.failed);
    },
  );
  test(
    'restored committed session remains pending until explicit cancellation',
    () async {
      f.installer.pending = true;
      await f.controller.check();
      expect(f.controller.phase, AppUpdatePhase.pending);
      expect(f.installer.stages, 0);
      await f.controller.cancelPendingInstall();
      expect(f.controller.phase, AppUpdatePhase.idle);
      expect(f.installer.commits, 0);
    },
  );
}
