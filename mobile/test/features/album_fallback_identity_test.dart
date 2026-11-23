import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/features/album/album_repository.dart';
import 'package:soundspan/features/search/catalog_models.dart';

import '../support/collection_fixtures.dart';

void main() {
  const validMbid = 'd7e8cf4e-fbe1-40c9-8f40-16ae540bbd8c';
  const localId = 'cmvfqjj5q17fk08o8qaxhzc23';
  AlbumRepository repository(CollectionTransport transport) => AlbumRepository(
    transport: transport,
    authority: CollectionAuthority(),
    fence: collectionFence,
    networkPolicy: const NetworkPolicy.online(),
  );
  CatalogEntityRef album(String? mbid) => CatalogEntityRef(
    kind: CatalogEntityKind.album,
    source: CatalogSource.library,
    id: localId,
    name: 'GUTS',
    mbid: mbid,
  );
  Map<String, Object?> detail(String id) => {
    'id': id,
    'title': 'GUTS',
    'artist': {'id': 'artist', 'name': 'Olivia Rodrigo'},
    'tracks': [],
  };

  for (final mbid in <String?>[
    'remote:d80b6abecca0659e',
    'federation:album',
    'temp-remote-1791821993153-tupnl4',
    'not-a-mbid',
    '$validMbid/extra',
    null,
  ]) {
    test(
      'unavailable local album never sends synthetic identity $mbid to discovery',
      () async {
        final transport = CollectionTransport(
          (r, _) => r.path.startsWith('/api/library/albums/')
              ? const ApiResponse(404, {})
              : const ApiResponse(500, {}),
        );
        await expectLater(
          repository(transport).load(album(mbid)),
          throwsA(
            isA<AppFailure>()
                .having((e) => e.code, 'code', 'album_unavailable')
                .having((e) => e.statusCode, 'status', 404)
                .having((e) => e.retryable, 'retryable', false)
                .having(
                  (e) => e.message,
                  'message',
                  contains('альбом пока недоступен'),
                ),
          ),
        );
        expect(transport.requests.map((r) => r.path), [
          '/api/library/albums/$localId',
        ]);
        expect(transport.fences, [collectionFence]);
      },
    );
  }

  for (final mbid in [validMbid, validMbid.toUpperCase()]) {
    test(
      'local 404 can fall back to the exact real MusicBrainz identity $mbid',
      () async {
        final transport = CollectionTransport(
          (r, _) => r.path.startsWith('/api/library/albums/')
              ? const ApiResponse(404, {})
              : ApiResponse(200, detail(mbid)),
        );
        final result = await repository(transport).load(album(mbid));
        expect(result.ref.source, CatalogSource.discovery);
        expect(result.ref.id, mbid);
        expect(transport.requests.map((r) => r.path), [
          '/api/library/albums/$localId',
          '/api/artists/album/$mbid',
        ]);
        expect(transport.fences, [collectionFence, collectionFence]);
      },
    );
  }

  test(
    'a successful owned remote album keeps its original library identity',
    () async {
      final transport = CollectionTransport(
        (r, _) => ApiResponse(200, detail(localId)),
      );
      final result = await repository(transport)
          .load(album('remote:d80b6abecca0659e'));
      expect(result.ref.source, CatalogSource.library);
      expect(result.ref.id, localId);
      expect(transport.requests.single.path, '/api/library/albums/$localId');
    },
  );

  for (final status in [401, 403, 409, 429, 500, 503]) {
    test(
      'library status $status never changes catalog or masks the failure',
      () async {
        final transport = CollectionTransport(
          (r, _) => ApiResponse(status, {}),
        );
        await expectLater(
          repository(transport).load(album(validMbid)),
          throwsA(
            isA<AppFailure>().having((e) => e.statusCode, 'status', status),
          ),
        );
        expect(transport.requests.single.path, '/api/library/albums/$localId');
      },
    );
  }
}
