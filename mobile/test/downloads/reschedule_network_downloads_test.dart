import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/downloads/download_models.dart';
import 'package:soundspan/downloads/reschedule_network_downloads.dart';

import 'download_fixture.dart';

void main() {
  late DownloadHarness h;
  setUp(() async => h = await DownloadHarness.create());
  tearDown(() async => h.close());

  test('rules update replaces active generations and preserves ready and user-paused files', () async {
    final ready = await h.repo.enqueue(
      DownloadHarness.track,
      'original',
      h.fence,
    );
    expect(
      await h.runner.run(ready.id, h.fence, ready.generation),
      DownloadRunResult.ready,
    );
    final waiting = await h.repo.enqueue(
      DownloadHarness.track,
      'high',
      h.fence,
    );
    final other = await h.repo.enqueue(DownloadHarness.track, 'low', h.fence);
    final paused = await h.repo.pause(
      other.id,
      h.fence,
      expectedGeneration: other.generation,
    );
    final cancelled = <String>[], scheduled = <int>[];
    await rescheduleNetworkDownloads(
      repository: h.repo,
      fence: h.fence,
      cancel: (id, fence, generation) async => cancelled.add(id),
      schedule: (id, fence, generation) async {
        expect(id, waiting.id);
        scheduled.add(generation);
        return 'new-work';
      },
    );
    expect(cancelled, [waiting.id]);
    expect(scheduled, [waiting.generation + 2]);
    expect(
      (await h.repo.status(paused.id, h.fence))!.toJson(),
      paused.toJson(),
    );
    expect(
      await h.repo.openReady(ready.track.ref, ready.quality, h.fence),
      isNotNull,
    );
  });

  test('a cancellation while old native work drains cannot be resumed by the rules callback', () async {
    final job = await h.repo.enqueue(
      DownloadHarness.track,
      'original',
      h.fence,
    );
    var scheduled = 0;
    await rescheduleNetworkDownloads(
      repository: h.repo,
      fence: h.fence,
      cancel: (id, fence, generation) async {
        final latest = (await h.repo.status(id, fence))!;
        await h.repo.cancel(id, fence, expectedGeneration: latest.generation);
      },
      schedule: (_, _, _) async {
        scheduled++;
        return 'unexpected';
      },
    );
    expect(scheduled, 0);
    expect(
      (await h.repo.status(job.id, h.fence))!.errorCode,
      'download_cancelled',
    );
  });
}
