import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/features/home/home_repository.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/dart_api_transport.dart';
import 'package:soundspan/core/session/session_authority.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/downloads/offline_mix_daily_factory.dart';

import '../support/collection_fixtures.dart';
import '../features/home_journey_test.dart' show homeResponse;

void main() {
  test(
    'saved legacy source fetches full detail and preserves duplicate order',
    () async {
      final transport = CollectionTransport(
        (request, _) => homeResponse(request),
      );
      final repo = HomeRepository(
        transport: transport,
        authority: CollectionAuthority(),
        fence: collectionFence,
      );
      final source = (await repo.currentMix('legacy:local-mix'))!;
      expect(source.loaded, isTrue);
      expect(source.tracks, hasLength(2));
      expect(source.tracks.first.ref, source.tracks.last.ref);
      expect(transport.requests.map((r) => r.path), [
        '/api/mixes',
        '/api/mixes/local-mix',
      ]);
      expect(transport.fences.every((f) => f == collectionFence), isTrue);
    },
  );
  test(
    'exact daily key never substitutes another mix or home fallback',
    () async {
      final transport = CollectionTransport(
        (request, _) => homeResponse(request),
      );
      final repo = HomeRepository(
        transport: transport,
        authority: CollectionAuthority(),
        fence: collectionFence,
      );
      expect(
        (await repo.currentMix('daily:style-rock'))!.identity,
        'daily:style-rock',
      );
      expect(await repo.currentMix('daily:missing'), isNull);
      expect(
        transport.requests.every(
          (r) => r.path == '/api/personalized/daily-mixes',
        ),
        isTrue,
      );
    },
  );
  test(
    'owner change during asynchronous admission prevents the source HTTP',
    () async {
      final authority = CollectionAuthority();
      final transport = CollectionTransport(
        (request, _) => homeResponse(request),
      );
      final repo = HomeRepository(
        transport: transport,
        authority: authority,
        fence: collectionFence,
        admitRequest: () async => authority.switchOwner(),
      );
      await expectLater(repo.currentMix('daily:style-rock'), throwsA(anything));
      expect(transport.requests, isEmpty);
    },
  );
  test(
    'charging loss after auth grant prevents the actual JSON HTTP',
    () async {
      var allowed = true;
      final client = _SourceClient();
      final authority = _SourceAuthority()..afterGrant = () => allowed = false;
      final transport = DartApiTransport(
        authority: authority,
        client: OfflineMixRefreshJsonClient(client, () async {
          if (!allowed) throw StateError('conditions changed');
        }),
      );
      await expectLater(
        transport.send(
          ApiRequest(
            origin: collectionOrigin,
            method: ApiMethod.get,
            path: '/api/personalized/daily-mixes',
          ),
          fence: collectionFence,
        ),
        throwsA(anything),
      );
      expect(client.sends, 0);
    },
  );
  test(
    '401 replay retains its budget and revalidates daily conditions',
    () async {
      var allowed = true;
      final client = _SourceClient()..status = 401;
      final authority = _SourceAuthority()
        ..afterUnauthorized = () => allowed = false;
      final transport = DartApiTransport(
        authority: authority,
        client: OfflineMixRefreshJsonClient(client, () async {
          if (!allowed) throw StateError('conditions changed');
        }),
      );
      await expectLater(
        transport.send(
          ApiRequest(
            origin: collectionOrigin,
            method: ApiMethod.get,
            path: '/api/personalized/daily-mixes',
          ),
          fence: collectionFence,
        ),
        throwsA(anything),
      );
      expect(client.sends, 1);
    },
  );
}

class _SourceAuthority extends CollectionAuthority {
  void Function()? afterGrant, afterUnauthorized;
  @override
  Future<AccessGrant> grantAccess(SessionFence fence, Uri exactOrigin) async {
    await assertCurrent(fence);
    afterGrant?.call();
    return AccessGrant(
      authStamp: AuthStamp(fence: fence, tokenRevision: 1),
      accessToken: 'fixture',
    );
  }

  @override
  Future<AuthStamp> after401(AuthStamp rejected) async {
    afterUnauthorized?.call();
    return rejected;
  }
}

class _SourceClient implements JsonHttpClient {
  var sends = 0, status = 200;
  @override
  Future<ApiResponse> send(ApiRequest request, {String? accessToken}) async {
    sends++;
    return ApiResponse(status, null);
  }
}
