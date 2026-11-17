import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/downloads/download_repository.dart';
import 'package:soundspan/downloads/download_models.dart';

import 'download_fixture.dart';

void main() {
  late DownloadHarness h;
  setUp(() async => h = await DownloadHarness.create());
  tearDown(() async => h.close());

  test('an individual download records protected manual ownership', () async {
    final job = await h.repo.enqueue(
      DownloadHarness.track,
      'original',
      h.fence,
    );
    expect(job.toJson()['origins'], ['manual']);
  });

  test('liked automation records its own protected file ownership', () async {
    final job = await h.repo.enqueue(
      DownloadHarness.track,
      'original',
      h.fence,
      manual: false,
    );
    expect(job.toJson()['origins'], ['liked']);
  });

  for (final pin in [DownloadOrigin.manual, DownloadOrigin.liked]) {
    test(
      'mix-only file gains protected ${pin.name} ownership on adoption',
      () async {
        final mix = await h.repo.enqueue(
          DownloadHarness.track,
          'original',
          h.fence,
          manual: true,
          origin: DownloadOrigin.offlineMix,
        );
        expect(
          mix.exclusivelyOfflineMixOwned,
          isTrue,
          reason: 'Manual-start admission does not turn a mix file into an individual pin.',
        );
        final adopted = await h.repo.enqueue(
          DownloadHarness.track,
          'original',
          h.fence,
          manual: pin == DownloadOrigin.manual,
          origin: pin,
        );
        expect(adopted.generation, mix.generation);
        expect(adopted.origins, containsAll(['offlineMix', pin.name]));
        expect(adopted.exclusivelyOfflineMixOwned, isFalse);
      },
    );
  }

  test(
    'unknown future ownership survives adoption and forbids mix eviction',
    () async {
      final mix = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
        origin: DownloadOrigin.offlineMix,
      );
      await h.store.transaction(h.fence, (tx) async {
        final row = (await tx.read(DownloadRepository.namespace, mix.id))!;
        row['origins'] = ['offlineMix', 'futureOwner'];
        await tx.write(DownloadRepository.namespace, mix.id, row);
      });
      final adopted = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
        origin: DownloadOrigin.offlineMix,
      );
      expect(
        adopted.toJson()['origins'],
        containsAll(['offlineMix', 'futureOwner']),
      );
      expect(adopted.exclusivelyOfflineMixOwned, isFalse);
    },
  );

  test(
    'adopting an old automatic file never erases protected legacy ownership',
    () async {
      final job = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
        manual: false,
      );
      await h.store.transaction(h.fence, (tx) async {
        final row = (await tx.read(DownloadRepository.namespace, job.id))!;
        row.remove('origins');
        await tx.write(DownloadRepository.namespace, job.id, row);
      });
      final adopted = await h.repo.enqueue(
        DownloadHarness.track,
        'original',
        h.fence,
        manual: false,
      );
      expect(adopted.toJson()['origins'], containsAll(['legacy', 'liked']));
    },
  );
}
