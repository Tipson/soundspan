import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/downloads/download_models.dart';
import 'package:soundspan/downloads/download_network_access.dart';
import 'package:soundspan/downloads/download_network_rules.dart';
import 'package:soundspan/features/downloads/downloads_controller.dart';

import 'download_fixture.dart';

void main() {
  late DownloadHarness h;
  final scheduled = <String>[];
  setUp(() async {
    h = await DownloadHarness.create();
    scheduled.clear();
  });
  tearDown(() async => h.close());
  DownloadsController controller({bool metered = false}) {
    final c = DownloadsController(
      repository: h.repo,
      fence: h.fence,
      networkPolicy: const NetworkPolicy.online(),
      storageReady: () => true,
      schedule: (id, _, _) async {
        scheduled.add(id);
        return 'work';
      },
      cancelJob: (_, _, _) async {},
      networkAccess: DownloadNetworkAccess(
        repository: h.repo,
        fence: h.fence,
        policy: const NetworkPolicy.online(),
        readNetwork: () async => DeviceNetworkState(
          connected: true,
          wifi: true,
          metered: metered,
          roaming: false,
        ),
      ),
    );
    addTearDown(() async {
      await c.close();
      c.dispose();
    });
    return c;
  }

  Future<DeviceDownload> ready() async {
    final job = await h.repo.enqueue(
      DownloadHarness.track,
      'original',
      h.fence,
      origin: DownloadOrigin.offlineMix,
    );
    expect(
      await h.runner.run(job.id, h.fence, job.generation),
      DownloadRunResult.ready,
    );
    return (await h.repo.status(job.id, h.fence))!;
  }

  test(
    'all-ready batch returns exact pinned generations without scheduling',
    () async {
      final file = await ready();
      final result = await controller().queueTracks([DownloadHarness.track]);
      expect(result.accepted, isTrue);
      expect(result.cancelled, isFalse);
      expect(result.jobs.single.id, file.id);
      expect(result.jobs.single.generation, file.generation);
      expect(result.jobs.single.origins, contains('manual'));
      expect(scheduled, isEmpty);
    },
  );

  test('cancelled mixed ready-and-new selection has no admission or pin side effect', () async {
    final file = await ready();
    final c = controller(metered: true);
    c.confirmNetworkUse = (count) async {
      expect(count, 1);
      return false;
    };
    final result = await c.queueTracks([
      DownloadHarness.track,
      const Track(
        ref: LibraryTrackRef('second'),
        title: 'Другой',
        artist: 'Автор',
      ),
    ]);
    expect(result.cancelled, isTrue);
    expect(result.accepted, isFalse);
    expect(result.jobs, isEmpty);
    expect(scheduled, isEmpty);
    expect((await h.repo.list(h.fence)), hasLength(1));
    expect((await h.repo.status(file.id, h.fence))!.origins, {'offlineMix'});
  });

  test(
    'new mix batch returns original job generation with mix-only ownership',
    () async {
      final result = await controller().queueTracks([
        DownloadHarness.track,
      ], origin: DownloadOrigin.offlineMix);
      expect(result.accepted, isTrue);
      expect(result.jobs.single.origins, {'offlineMix'});
      expect(result.jobs.single.originalFence, h.fence);
      expect(result.jobs.single.state, DownloadState.queued);
      expect(scheduled, [result.jobs.single.id]);
    },
  );
}
