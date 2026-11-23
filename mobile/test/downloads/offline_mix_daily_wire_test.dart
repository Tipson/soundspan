import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/downloads/download_worker_bridge.dart';

import '../support/collection_fixtures.dart';

void main() {
  test('daily file wire carries only the original identity and revision', () {
    final legacy = DownloadWorkRequest('a' * 64, collectionFence, 3);
    final decoded = DownloadWorkRequest.decode({
      ...legacy.encode(),
      'refreshRevision': 7,
    });
    expect(decoded.originalFence, collectionFence);
    expect(decoded.generation, 3);
    expect(decoded.encode(), {...legacy.encode(), 'refreshRevision': 7});
  });
  test('legacy file wire remains exact and unknown additions fail closed', () {
    final legacy = DownloadWorkRequest('a' * 64, collectionFence, 3);
    expect(
      DownloadWorkRequest.decode(legacy.encode()).encode(),
      legacy.encode(),
    );
    for (final bad in [null, 0, 1.0, '7', true]) {
      expect(
        () => DownloadWorkRequest.decode({
          ...legacy.encode(),
          'refreshRevision': bad,
        }),
        throwsA(isA<AppFailure>()),
      );
    }
    expect(
      () => DownloadWorkRequest.decode({
        ...legacy.encode(),
        'source': 'daily:any',
      }),
      throwsA(isA<AppFailure>()),
    );
  });
}
