import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/features/updates/release_update_repository.dart';

import '../../support/collection_fixtures.dart';
import '../../support/update_fixtures.dart';

void main() {
  late CollectionAuthority authority;
  setUp(() => authority = CollectionAuthority());
  tearDown(() => authority.updates.close());
  ReleaseUpdateRepository repo(CollectionTransport transport) {
    final value = ReleaseUpdateRepository(
      transport: transport,
      authority: authority,
      fence: collectionFence,
      networkPolicy: const NetworkPolicy.online(),
    );
    addTearDown(value.dispose);
    return value;
  }

  for (final (code, expected) in [
    (404, ReleaseAvailabilityKind.unsupported),
    (204, ReleaseAvailabilityKind.noRelease),
  ]) {
    test(
      '$code is graceful and GET keeps exact origin/channel/fence',
      () async {
        final transport = CollectionTransport(
          (r, f) => ApiResponse(code, null),
        );
        expect(
          (await repo(transport).check(installed: installedUpdateApp)).kind,
          expected,
        );
        final r = transport.requests.single;
        expect(r.method, ApiMethod.get);
        expect(r.origin, collectionOrigin);
        expect(r.path, '/api/system/mobile-release/manifest');
        expect(r.query, {'channel': 'stable'});
        expect(transport.fences.single, collectionFence);
      },
    );
  }
  for (final code in [27, 28, 29]) {
    test('version $code is compared numerically with installed code', () async {
      final r = repo(
        CollectionTransport((_, _) => ApiResponse(200, releaseDto(code: code))),
      );
      expect(
        (await r.check(installed: installedUpdateApp)).kind,
        code > 28
            ? ReleaseAvailabilityKind.update
            : ReleaseAvailabilityKind.current,
      );
    });
  }
  test('test channel cannot replace a stable installation', () async {
    final r = repo(
      CollectionTransport(
        (_, _) => ApiResponse(200, releaseDto(channel: 'test')),
      ),
    );
    expect(
      (await r.check(installed: installedUpdateApp)).kind,
      ReleaseAvailabilityKind.incompatible,
    );
  });
  test(
    'required capability is read fresh and missing version blocks update',
    () async {
      final transport = CollectionTransport(
        (r, _) => ApiResponse(
          200,
          r.path.endsWith('/features')
              ? {
                  'orderedWave': {'version': 2},
                }
              : (releaseDto()..['requiredCapabilities'] = {'orderedWave': 1}),
        ),
      );
      expect(
        (await repo(transport).check(installed: installedUpdateApp)).kind,
        ReleaseAvailabilityKind.incompatible,
      );
      expect(transport.requests.last.path, '/api/system/features');
    },
  );
  test('401 remains auth failure rather than unsupported server', () async {
    final r = repo(CollectionTransport((_, _) => const ApiResponse(401, null)));
    await expectLater(
      r.check(installed: installedUpdateApp),
      throwsA(isA<AppFailure>().having((f) => f.statusCode, 'status', 401)),
    );
  });
  test('late manifest after owner switch never becomes available', () async {
    final response = Completer<ApiResponse>();
    final r = repo(CollectionTransport((_, _) => response.future));
    final pending = r.check(installed: installedUpdateApp);
    await Future<void>.delayed(Duration.zero);
    authority.switchOwner();
    response.complete(ApiResponse(200, releaseDto()));
    await expectLater(pending, throwsA(isA<AppFailure>()));
  });
}
