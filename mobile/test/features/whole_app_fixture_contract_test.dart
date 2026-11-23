import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/network/dart_api_transport.dart';
import 'package:soundspan/core/session/credential_vault.dart';
import 'package:soundspan/features/likes/preference_controller.dart';
import 'package:soundspan/features/likes/likes_models.dart';
import 'package:soundspan/features/playlists/playlist_repository.dart';

import '../../integration_test/support/whole_app_fixture.dart';
import '../support/media_fixtures.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  HttpOverrides.global = null;
  test(
    'synthetic large playlist respects actual 100 item cursor contract',
    () async {
      final fixture = await WholeAppFixture.open();
      final authority = await mediaAuthority(fixture.origin);
      await authority.establish(
        OwnerKey(serverOrigin: fixture.origin, userId: 't24-synthetic'),
        const TokenPair(
          accessToken: 'synthetic-ui-access',
          refreshToken: 'synthetic-ui-refresh',
        ),
      );
      final client = DartJsonHttpClient(
        securityContext: WholeAppFixture.trust(),
      );
      final repository = PlaylistRepository(
        transport: DartApiTransport(client: client, authority: authority),
        authority: authority,
        fence: authority.requireFence(),
      );
      try {
        final first = await repository.page('p-road', null);
        expect(first.items, hasLength(100));
        expect(first.total, 101);
        expect(first.hasMore, isTrue);
        final last = await repository.page('p-road', first.nextCursor);
        expect(last.items, hasLength(1));
        expect(last.hasMore, isFalse);
        expect({
          ...first.items.map((e) => e.id),
          ...last.items.map((e) => e.id),
        }, hasLength(101));
      } finally {
        await client.close();
        await authority.invalidate();
        await fixture.close();
      }
    },
  );
  test(
    'synthetic TLS preference response preserves decoded remote identity',
    () async {
      final fixture = await WholeAppFixture.open();
      final authority = await mediaAuthority(fixture.origin);
      await authority.establish(
        OwnerKey(serverOrigin: fixture.origin, userId: 't24-synthetic'),
        const TokenPair(
          accessToken: 'synthetic-ui-access',
          refreshToken: 'synthetic-ui-refresh',
        ),
      );
      final client = DartJsonHttpClient(
        securityContext: WholeAppFixture.trust(),
      );
      final preferences = PreferenceController(
        transport: DartApiTransport(client: client, authority: authority),
        authority: authority,
        fence: authority.requireFence(),
      );
      const ref = YoutubeTrackRef('synthetic16');
      try {
        await preferences.load(ref);
        expect(preferences.current(ref).failure, isNull);
        expect(preferences.current(ref).signal, PreferenceSignal.clear);
        await preferences.set(ref, PreferenceSignal.like);
        expect(preferences.current(ref).failure, isNull);
        expect(preferences.current(ref).signal, PreferenceSignal.like);
        expect(fixture.preferences['yt:synthetic16'], 'thumbs_up');
        expect(fixture.unexpected, isEmpty);
      } finally {
        preferences.dispose();
        await client.close();
        await authority.invalidate();
        await fixture.close();
      }
    },
  );
}
