import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/features/shares/share_models.dart';
import 'package:soundspan/features/shares/share_repository.dart';
import 'package:soundspan/features/shares/share_controller.dart';
import 'package:soundspan/features/shares/share_sheet.dart';
import 'package:soundspan/features/inbox/inbox_repository.dart';
import 'package:soundspan/features/inbox/inbox_controller.dart';
import 'package:soundspan/features/inbox/inbox_screen.dart';
import 'package:soundspan/features/inbox/inbox_models.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/features/player/player_controller.dart';
import 'package:soundspan/features/player/full_player_screen.dart';
import 'package:soundspan/features/likes/preference_controller.dart';
import 'package:soundspan/features/downloads/download_actions_sheet.dart';
import 'package:soundspan/features/downloads/downloads_controller.dart';

import '../downloads/download_fixture.dart';

import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/session/session_authority.dart';
import 'package:soundspan/core/storage/owner_store.dart';
import 'package:soundspan/core/network/dart_api_transport.dart';
import 'package:soundspan/features/shares/native_share_actions.dart';

import '../support/auth_fakes.dart' show ScriptedJsonClient;

import 'package:soundspan/app/server_capabilities.dart';

import '../support/collection_fixtures.dart';
import '../support/wave_reporting_fixtures.dart';

final token = 'a' * 64;
Map<String, Object?> linkDto({String id = 'link-1', bool revoked = false}) => {
  'id': id,
  'userId': 'a',
  'resourceType': 'track',
  'resourceId': 'local-1',
  'token': token,
  'accessPath': '/api/share-links/access/$token',
  'expiresAt': null,
  'maxPlays': null,
  'playCount': 0,
  'createdAt': '2026-10-15T10:00:00.000Z',
  'revoked': revoked,
};
Map<String, Object?> notificationDto({
  String id = 'n1',
  String type = 'download_complete',
  bool read = false,
}) => {
  'id': id,
  'type': type,
  'title': 'Готово',
  'message': 'Альбом добавлен',
  'metadata': {'albumId': 'album-1', 'url': 'https://evil.invalid/'},
  'read': read,
  'cleared': false,
  'createdAt': '2026-10-15T10:00:00Z',
};
ShareRepository shares(
  CollectionAuthority a,
  CollectionTransport t,
  ReportingStore store,
) => ShareRepository(
  transport: t,
  authority: a,
  fence: collectionFence,
  networkPolicy: const NetworkPolicy.online(),
  store: store,
);
InboxRepository inbox(CollectionAuthority a, CollectionTransport t) =>
    InboxRepository(
      transport: t,
      authority: a,
      fence: collectionFence,
      networkPolicy: const NetworkPolicy.online(),
    );

void main() {
  for (final boundary in [
    'ttl',
    'offline-before-release',
    'offline-after-release',
    'owner',
  ]) {
    test(
      'capability response cannot gain admission across cache await: $boundary',
      () async {
        final authority = CollectionAuthority();
        final policy = _CapabilitiesPolicy();
        final store = _HeldCapabilitiesStore();
        var elapsed = Duration.zero;
        final transport = CollectionTransport(
          (_, _) => ApiResponse(200, _playCreationFeatures()),
        );
        final repo = ServerCapabilitiesRepository(
          transport: transport,
          store: store,
          authority: authority,
          fence: collectionFence,
          policy: policy,
          elapsed: () => elapsed,
        );
        try {
          final refresh = repo.refresh();
          await store.entered.future;
          if (boundary == 'ttl') elapsed = const Duration(seconds: 301);
          if (boundary.startsWith('offline')) policy.change(false);
          if (boundary == 'offline-before-release') policy.change(true);
          if (boundary == 'owner') authority.switchOwner();
          store.release.complete();
          await refresh;
          if (boundary == 'offline-after-release') policy.change(true);
          expect(
            repo.playCreationGrant,
            isNull,
            reason: 'Storage awaits cannot renew the response TTL or revive revoked online admission',
          );
          expect(transport.requests, hasLength(1));
          if (boundary != 'owner') {
            expect(repo.state.value!.discovery, isTrue);
            expect(repo.hasFreshUnsupportedPlayCreation, isFalse);
            await repo.refresh();
            expect(transport.requests, hasLength(2));
            expect(
              repo.playCreationGrant,
              isNotNull,
              reason: 'A new online response can grant admission after the old response was discarded',
            );
          }
        } finally {
          if (!store.release.isCompleted) store.release.complete();
          await repo.close();
          await authority.updates.close();
          policy.dispose();
        }
      },
    );
  }
  test('capability server clock and TTL stay anchored to receipt before cache persistence', () async {
    final authority = CollectionAuthority();
    final store = _HeldCapabilitiesStore();
    var elapsed = Duration.zero;
    final repo = ServerCapabilitiesRepository(
      transport: CollectionTransport(
        (_, _) => ApiResponse(200, _playCreationFeatures()),
      ),
      store: store,
      authority: authority,
      fence: collectionFence,
      policy: const NetworkPolicy.online(),
      elapsed: () => elapsed,
    );
    try {
      final refresh = repo.refresh();
      await store.entered.future;
      elapsed = const Duration(seconds: 100);
      store.release.complete();
      await refresh;
      final grant = repo.playCreationGrant!;
      expect(grant.serverNowMs, 1700000100000);
      elapsed = const Duration(seconds: 299);
      expect(grant.isFresh, isTrue);
      elapsed = const Duration(seconds: 300);
      expect(grant.isFresh, isFalse);
      expect(repo.playCreationGrant, isNull);
    } finally {
      if (!store.release.isCompleted) store.release.complete();
      await repo.close();
      await authority.updates.close();
    }
  });
  test('unsupported capability freshness also expires while UI cache persistence waits', () async {
    final authority = CollectionAuthority();
    final store = _HeldCapabilitiesStore();
    var elapsed = Duration.zero;
    final repo = ServerCapabilitiesRepository(
      transport: CollectionTransport(
        (_, _) => const ApiResponse(200, {
          'discovery': true,
          'autoPlaylists': false,
          'federation': false,
        }),
      ),
      store: store,
      authority: authority,
      fence: collectionFence,
      policy: const NetworkPolicy.online(),
      elapsed: () => elapsed,
    );
    try {
      final refresh = repo.refresh();
      await store.entered.future;
      elapsed = const Duration(seconds: 301);
      store.release.complete();
      await refresh;
      expect(repo.state.value!.discovery, isTrue);
      expect(repo.playCreationGrant, isNull);
      expect(repo.hasFreshUnsupportedPlayCreation, isFalse);
    } finally {
      if (!store.release.isCompleted) store.release.complete();
      await repo.close();
      await authority.updates.close();
    }
  });
  test('background Play admission refresh does not announce unchanged UI feature flags', () async {
    final authority = CollectionAuthority(), owners = ReportingStore();
    var now = 1700000000000, changes = 0;
    final repo = ServerCapabilitiesRepository(
      transport: CollectionTransport(
        (_, _) => ApiResponse(200, {
          'discovery': true,
          'autoPlaylists': false,
          'federation': false,
          'playCreation': {
            'version': 1,
            'newCreationsEnabled': true,
            'replaySupported': true,
            'createPath': '/api/plays/idempotent',
            'ownerHistoryEpoch': 7,
            'serverNowMs': now++,
            'replayWindowSeconds': 86400,
            'futureSkewSeconds': 300,
            'capabilityTtlSeconds': 300,
            'allowedSources': ['youtube'],
          },
        }),
      ),
      store: owners,
      authority: authority,
      fence: collectionFence,
      policy: const NetworkPolicy.online(),
    );
    repo.state.addListener(() {
      changes++;
    });
    try {
      await repo.refresh();
      final old = repo.playCreationGrant!;
      await repo.refresh();
      expect(changes, 1);
      expect(repo.playCreationGrant, isNotNull);
      expect(old.isFresh, isFalse);
    } finally {
      await repo.close();
      await authority.updates.close();
    }
  });
  test('unsupported Play capability never breaks cached UI flags or admits a foreign path', () async {
    final authority = CollectionAuthority(), owners = ReportingStore();
    final protocol = <String, Object?>{
      'version': 1,
      'newCreationsEnabled': true,
      'replaySupported': true,
      'createPath': '/api/plays/idempotent',
      'ownerHistoryEpoch': 7,
      'serverNowMs': 1700000000000,
      'replayWindowSeconds': 86400,
      'futureSkewSeconds': 300,
      'capabilityTtlSeconds': 300,
      'allowedSources': ['youtube'],
    };
    var current = Map<String, Object?>.of(protocol);
    final repo = ServerCapabilitiesRepository(
      transport: CollectionTransport(
        (_, _) => ApiResponse(200, {
          'discovery': true,
          'autoPlaylists': false,
          'federation': false,
          'playCreation': current,
        }),
      ),
      store: owners,
      authority: authority,
      fence: collectionFence,
      policy: const NetworkPolicy.online(),
    );
    try {
      await repo.refresh();
      final old = repo.playCreationGrant!;
      for (final invalid in [
        <String, Object?>{'version': 2},
        <String, Object?>{'createPath': 'https://foreign.invalid/api/plays'},
        <String, Object?>{
          'allowedSources': ['library'],
        },
        <String, Object?>{'ownerHistoryEpoch': -1},
      ]) {
        current = {...protocol, ...invalid};
        await repo.refresh();
        expect(repo.playCreationGrant, isNull);
        expect(old.allowsNew('youtube', collectionFence), isFalse);
        expect(repo.state.value!.discovery, isTrue);
      }
    } finally {
      await repo.close();
      await authority.updates.close();
    }
  });
  test('Play create grant is online only, expires monotonically and is revoked by failed refresh', () async {
    final authority = CollectionAuthority();
    final owners = ReportingStore();
    var elapsed = Duration.zero;
    var succeeds = true;
    final body = <String, Object?>{
      'discovery': true,
      'autoPlaylists': false,
      'federation': false,
      'playCreation': {
        'version': 1,
        'newCreationsEnabled': true,
        'replaySupported': true,
        'createPath': '/api/plays/idempotent',
        'ownerHistoryEpoch': 7,
        'serverNowMs': 1700000000000,
        'replayWindowSeconds': 86400,
        'futureSkewSeconds': 300,
        'capabilityTtlSeconds': 300,
        'allowedSources': ['youtube', 'vk', 'yandex'],
      },
    };
    final repo = ServerCapabilitiesRepository(
      transport: CollectionTransport(
        (_, _) =>
            succeeds ? ApiResponse(200, body) : const ApiResponse(503, null),
      ),
      store: owners,
      authority: authority,
      fence: collectionFence,
      policy: const NetworkPolicy.online(),
      elapsed: () => elapsed,
    );
    try {
      await repo.refresh();
      expect(
        repo.playCreationGrant!.allowsNew('youtube', collectionFence),
        isTrue,
      );
      expect(
        repo.playCreationGrant!.allowsNew('library', collectionFence),
        isFalse,
      );
      final stored = owners.records.values.single['capabilities/system']!;
      expect((stored['flags'] as Map).containsKey('playCreation'), isFalse);
      final restarted = ServerCapabilitiesRepository(
        transport: CollectionTransport((_, _) => throw StateError('offline')),
        store: owners,
        authority: authority,
        fence: collectionFence,
        policy: const NetworkPolicy.online(),
      );
      await restarted.restore();
      expect(restarted.state.value!.discovery, isTrue);
      expect(restarted.playCreationGrant, isNull);
      await restarted.close();
      elapsed = const Duration(seconds: 300);
      expect(repo.playCreationGrant, isNull);
      elapsed = const Duration(seconds: 301);
      await repo.refresh();
      expect(repo.playCreationGrant, isNotNull);
      succeeds = false;
      await repo.refresh();
      expect(repo.playCreationGrant, isNull);
    } finally {
      await repo.close();
      await authority.updates.close();
    }
  });
  testWidgets(
    'explicit create sends one grant and never opens external UI automatically',
    (tester) async {
      final a = CollectionAuthority(), store = ReportingStore();
      var posts = 0;
      final t = CollectionTransport((r, _) {
        if (r.method == ApiMethod.post) {
          posts++;
          return ApiResponse(200, linkDto());
        }
        return const ApiResponse(200, []);
      });
      final c = ShareController(shares(a, t, store));
      await tester.pumpWidget(
        MaterialApp(
          home: ShareSheet(
            controller: c,
            resource: ShareResource.track(collectionTrack(1)),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(posts, 0);
      await tester.ensureVisible(find.text('Создать ссылку'));
      await tester.tap(find.text('Создать ссылку'));
      await tester.pumpAndSettle();
      expect(posts, 1);
      expect(c.links, hasLength(1));
      expect(t.requests.last.body!['resourceId'], 'local-1');
      expect(t.requests.last.body!.containsKey('allowDownload'), isFalse);
      expect(c.message, contains('Ссылка создана'));
      await tester.pumpWidget(const SizedBox.shrink());
      await drain(tester, c.close());
      await drain(tester, a.updates.close());
    },
    timeout: const Timeout(Duration(seconds: 15)),
  );
  testWidgets('inbox foreground gate has no hidden or periodic scans', (
    tester,
  ) async {
    final a = CollectionAuthority(), visible = ValueNotifier(false);
    final t = CollectionTransport(
      (r, _) => r.path.endsWith('unread-count')
          ? const ApiResponse(200, {'count': 0})
          : const ApiResponse(200, []),
    );
    final c = InboxController(inbox(a, t));
    await tester.pumpWidget(
      MaterialApp(
        home: InboxScreen(controller: c, foreground: visible),
      ),
    );
    await tester.pumpAndSettle();
    expect(t.requests, isEmpty);
    visible.value = true;
    await tester.pumpAndSettle();
    expect(t.requests, hasLength(2));
    visible.value = false;
    await tester.pump(const Duration(minutes: 2));
    expect(t.requests, hasLength(2));
    await tester.pumpWidget(const SizedBox.shrink());
    await drain(tester, c.close());
    await drain(tester, a.updates.close());
    visible.dispose();
  }, timeout: const Timeout(Duration(seconds: 15)));
  for (final size in [
    const Size(320, 700),
    const Size(390, 800),
    const Size(430, 900),
    const Size(800, 390),
  ]) {
    testWidgets('share and inbox remain scrollable at $size and text2', (
      tester,
    ) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final a = CollectionAuthority(),
          t = CollectionTransport(
            (r, _) => r.path.endsWith('unread-count')
                ? const ApiResponse(200, {'count': 1})
                : r.path.contains('notifications')
                ? ApiResponse(200, [notificationDto()])
                : ApiResponse(200, [linkDto()]),
          );
      final c = ShareController(shares(a, t, ReportingStore()));
      Widget app(Widget child) => MaterialApp(
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: const TextScaler.linear(2)),
          child: child!,
        ),
        home: child,
      );
      await tester.pumpWidget(
        app(
          ShareSheet(
            controller: c,
            resource: ShareResource.track(collectionTrack(1)),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Создать ссылку'));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      await drain(tester, c.close());
      final i = InboxController(inbox(a, t));
      await tester.pumpWidget(app(InboxScreen(controller: i)));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Очистить все'));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      await drain(tester, i.close());
      await drain(tester, a.updates.close());
    }, timeout: const Timeout(Duration(seconds: 20)));
  }
  test(
    'Back before first POST clears only its pending journal and sends nothing',
    () async {
      final a = GateAuthority(),
          t = CollectionTransport((_, _) => ApiResponse(200, linkDto())),
          store = ReportingStore();
      final r = shares(a, t, store);
      var current = true;
      final operation = r.create(
        ShareDraft(ShareResource.track(collectionTrack(1))),
        current: () => current,
      );
      final failed = expectLater(operation, throwsA(isA<AppFailure>()));
      await a.reached.future;
      current = false;
      a.gate.complete();
      await failed;
      expect(t.requests, isEmpty);
      expect(await r.pendingAttempt(), isNull);
      await r.close();
      await a.updates.close();
    },
  );
  test('Back during admitted 401 refresh drains one replay without presentation or followup', () async {
    final a = RefreshAuthority(), store = ReportingStore();
    var posts = 0;
    final client = ScriptedJsonClient((request, _) async {
      if (request.method == ApiMethod.post) {
        posts++;
        return posts == 1
            ? const ApiResponse(401, {})
            : ApiResponse(200, linkDto());
      }
      return ApiResponse(200, [linkDto()]);
    });
    final repository = ShareRepository(
      transport: DartApiTransport(client: client, authority: a),
      authority: a,
      fence: collectionFence,
      networkPolicy: const NetworkPolicy.online(),
      store: store,
    );
    final c = ShareController(repository);
    var presented = true, external = 0;
    final operation = c.create(
      ShareDraft(ShareResource.track(collectionTrack(1))),
      current: () => presented,
    );
    await a.reached.future;
    presented = false;
    final closing = c.close();
    a.gate.complete();
    await operation;
    await closing;
    await c.useLink(ShareLink.decode(linkDto(), collectionOwner), (_) async {
      external++;
    }, current: () => presented);
    expect(posts, 2);
    expect(a.revision, 1);
    expect(c.links, isEmpty);
    expect(external, 0);
    expect(
      await store.transaction(
        collectionFence,
        (tx) => tx.read('shares', 'creation'),
      ),
      isNull,
    );
    await a.updates.close();
  });
  test('native bridge sends only validated capability text and never retries chooser cancellation', () async {
    final calls = <MethodCall>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(const MethodChannel('soundspan/share'), (
          call,
        ) async {
          calls.add(call);
          return 'opened';
        });
    addTearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(
            const MethodChannel('soundspan/share'),
            null,
          ),
    );
    final actions = NativeShareActions();
    await actions.share(Uri.parse('https://music.example/share/$token'));
    expect(calls.single.method, 'share');
    expect(calls.single.arguments, {
      'origin': 'https://music.example',
      'url': 'https://music.example/share/$token',
    });
    await expectLater(
      actions.open(Uri.parse('https://music.example/share/$token?token=bad')),
      throwsA(isA<AppFailure>()),
    );
    expect(calls, hasLength(1));
  });
  testWidgets(
    'download selection rejects stale captured queue after its admission await',
    (tester) async {
      final h = (await tester.runAsync(DownloadHarness.create))!;
      var scheduled = 0;
      final c = DownloadsController(
        repository: h.repo,
        fence: h.fence,
        networkPolicy: const NetworkPolicy.online(),
        storageReady: () => true,
        schedule: (_, _, _) async {
          scheduled++;
          return 'job';
        },
        cancelJob: (_, _, _) async {},
      );
      final gate = Completer<void>();
      var current = true, completed = false;
      Object? failure;
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () {
                  DownloadActionsSheet.confirmSelection(
                    context,
                    c,
                    [DownloadHarness.track],
                    beforeDownload: () async {
                      await gate.future;
                      if (!current) {
                        throw const AppFailure(
                          code: 'stale_session',
                          message: 'changed',
                        );
                      }
                    },
                  ).then<void>(
                    (_) {
                      completed = true;
                    },
                    onError: (Object e) {
                      failure = e;
                      completed = true;
                    },
                  );
                },
                child: const Text('Выбрать'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Выбрать'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Скачать 1 треков'));
      await tester.pumpAndSettle();
      expect(scheduled, 0);
      current = false;
      gate.complete();
      await tester.pumpAndSettle();
      expect(completed, isTrue);
      expect(failure, isA<AppFailure>());
      expect(scheduled, 0);
      expect(await tester.runAsync(() => h.repo.list(h.fence)), isEmpty);
      await tester.pumpWidget(const SizedBox.shrink());
      await drain(tester, c.close());
      c.dispose();
      await tester.runAsync(h.close);
    },
    timeout: const Timeout(Duration(seconds: 20)),
  );
  testWidgets('share action exists only for playable library track', (
    tester,
  ) async {
    final a = CollectionAuthority();
    final t = CollectionTransport(
      (_, _) => preferenceResponse('local-1', 'clear'),
    );
    final preferences = PreferenceController(
      transport: t,
      authority: a,
      fence: collectionFence,
    );
    for (final track in [
      collectionTrack(1),
      const Track(
        ref: YoutubeTrackRef('video-1'),
        title: 'Remote',
        artist: 'Artist',
      ),
      collectionTrack(2, playable: false),
    ]) {
      final playback = CollectionPlayback(
        QueueSnapshot(fence: collectionFence),
      );
      final entry = playback.createEntries([
        track,
      ], const PlayContext(surface: PlaySurface.library)).single;
      playback.value = QueueSnapshot(
        fence: collectionFence,
        entries: [entry],
        effectiveOrder: [entry.entryId],
        currentEntryId: entry.entryId,
      );
      final player = PlayerController(
        playback: playback,
        authority: a,
        fence: collectionFence,
        preferences: preferences,
        callbacks: PlayerCallbacks(onShare: (_) async {}),
      );
      await tester.pumpWidget(
        MaterialApp(home: FullPlayerScreen(controller: player)),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Действия трека'));
      await tester.pumpAndSettle();
      expect(
        find.text('Поделиться'),
        track.ref is LibraryTrackRef && track.playable
            ? findsOneWidget
            : findsNothing,
      );
      await tester.pumpWidget(const SizedBox.shrink());
      player.dispose();
    }
    preferences.dispose();
    await drain(tester, a.updates.close());
  }, timeout: const Timeout(Duration(seconds: 15)));
  test('only exact library track resources admit creation and draft limits validate', () async {
    expect(ShareResource.track(collectionTrack(1)).id, 'local-1');
    expect(
      () => ShareResource.track(collectionTrack(1, playable: false)),
      throwsA(isA<AppFailure>()),
    );
    final resource = ShareResource.track(collectionTrack(1));
    expect(
      () => ShareDraft(resource, maxPlays: 0).payload(DateTime.now()),
      throwsA(isA<AppFailure>()),
    );
    expect(
      () => ShareDraft(
        resource,
        expiresAt: DateTime.utc(2000),
      ).payload(DateTime.now()),
      throwsA(isA<AppFailure>()),
    );
    expect(ShareDraft(resource, maxPlays: 2).payload(DateTime.now()), {
      'resourceType': 'track',
      'resourceId': 'local-1',
      'maxPlays': 2,
    });
  });
  test('capability URL accepts exact owner path and rejects foreign or encoded targets', () {
    final valid = ShareLink.decode(linkDto(), collectionOwner);
    expect(valid.publicUrl.toString(), 'https://music.example/share/$token');
    expect(valid.toString(), isNot(contains(token)));
    for (final path in [
      'https://evil.invalid/api/share-links/access/$token',
      '//evil.invalid/$token',
      '/api/share-links/access/%61${token.substring(1)}',
      '/api/share-links/access/$token?x=1',
      '/api/share-links/access/$token#fragment',
    ]) {
      expect(
        () => ShareLink.decode({
          ...linkDto(),
          'accessPath': path,
        }, collectionOwner),
        throwsA(isA<AppFailure>()),
      );
    }
    expect(
      () => ShareLink.decode({...linkDto(), 'userId': 'b'}, collectionOwner),
      throwsA(isA<AppFailure>()),
    );
    expect(
      ShareLink.decode({
        ...linkDto(),
        'expiresAt': '2000-01-01T00:00:00Z',
      }, collectionOwner).available(DateTime.now()),
      isFalse,
    );
  });
  test(
    'lost create stays uncertain after repository restart and never replays',
    () async {
      final a = CollectionAuthority(), store = ReportingStore();
      final t = CollectionTransport((r, _) {
        if (r.method == ApiMethod.post) {
          throw const AppFailure(code: 'network_timeout', message: 'lost');
        }
        return const ApiResponse(200, []);
      });
      final first = shares(a, t, store);
      await expectLater(
        first.create(ShareDraft(ShareResource.track(collectionTrack(1)))),
        throwsA(isA<AppFailure>()),
      );
      await first.close();
      final second = shares(a, t, store);
      expect(await second.pendingAttempt(), isNotNull);
      await second.list();
      await expectLater(
        second.create(ShareDraft(ShareResource.track(collectionTrack(1)))),
        throwsA(isA<AppFailure>()),
      );
      expect(t.requests.where((r) => r.method == ApiMethod.post), hasLength(1));
      final row = await store.transaction(
        collectionFence,
        (tx) => tx.read('shares', 'creation'),
      );
      expect(row.toString(), isNot(contains(token)));
      expect(
        row!.keys,
        unorderedEquals([
          'version',
          'attemptId',
          'resourceType',
          'resourceId',
          'uncertain',
        ]),
      );
      await second.close();
      await a.updates.close();
    },
  );
  test(
    'revocation acknowledged before failed readback remains acknowledged',
    () async {
      final a = CollectionAuthority(), store = ReportingStore();
      var deleted = false;
      final t = CollectionTransport((r, _) {
        if (r.method == ApiMethod.delete) {
          deleted = true;
          return const ApiResponse(200, {'success': true});
        }
        return deleted
            ? const ApiResponse(503, {})
            : ApiResponse(200, [linkDto()]);
      });
      final c = ShareController(shares(a, t, store));
      await c.load();
      final link = c.links.single;
      await c.revoke(link, current: () => true);
      expect(c.links, isEmpty);
      expect(c.message, contains('отозвана'));
      expect(c.failure, isNotNull);
      expect(
        t.requests.where((r) => r.method == ApiMethod.delete).single.path,
        '/api/share-links/link-1',
      );
      await c.close();
      await a.updates.close();
    },
  );
  test(
    'late share response and old link action cannot cross owner boundary',
    () async {
      final a = CollectionAuthority(), deferred = Completer<ApiResponse>();
      final t = CollectionTransport((_, _) => deferred.future);
      final c = ShareController(shares(a, t, ReportingStore()));
      final load = c.load();
      await Future<void>.delayed(Duration.zero);
      a.switchOwner();
      deferred.complete(ApiResponse(200, [linkDto()]));
      await load;
      expect(c.links, isEmpty);
      var dispatched = false;
      await c.useLink(ShareLink.decode(linkDto(), collectionOwner), (_) async {
        dispatched = true;
      }, current: () => true);
      expect(dispatched, isFalse);
      await c.close();
      await a.updates.close();
    },
  );
  test(
    'inbox validates latest100 and ignores arbitrary metadata action URLs',
    () async {
      final a = CollectionAuthority();
      final t = CollectionTransport(
        (r, _) => r.path.endsWith('unread-count')
            ? const ApiResponse(200, {'count': 130})
            : ApiResponse(
                200,
                List.generate(105, (i) => notificationDto(id: 'n$i')),
              ),
      );
      final c = InboxController(inbox(a, t));
      await c.load();
      expect(c.entries, hasLength(100));
      expect(c.unread, 130);
      expect(c.entries.first.destination!.kind, InboxDestinationKind.album);
      expect(
        InboxEntry.decode({
          ...notificationDto(type: 'unknown'),
          'metadata': {'url': 'https://evil.invalid'},
        }).destination,
        isNull,
      );
      expect(c.entries.first.serverAcquisition, isTrue);
      await c.close();
      await a.updates.close();
    },
  );
  test('inbox read and clear one/all use endpoints and preserve acknowledged readback failure', () async {
    final a = CollectionAuthority();
    var failReadback = false;
    final t = CollectionTransport((r, _) {
      if (r.method == ApiMethod.post) {
        failReadback = true;
        return const ApiResponse(200, {'success': true});
      }
      if (failReadback) return const ApiResponse(503, {});
      return r.path.endsWith('unread-count')
          ? const ApiResponse(200, {'count': 1})
          : ApiResponse(200, [notificationDto()]);
    });
    final c = InboxController(inbox(a, t));
    for (final action in InboxAction.values) {
      failReadback = false;
      await c.load();
      await c.mutate(
        action,
        id: action == InboxAction.read || action == InboxAction.clear
            ? 'n1'
            : null,
        current: () => true,
      );
      expect(c.message, contains('выполнено'));
      expect(c.failure, isNotNull);
    }
    expect(
      t.requests.where((r) => r.method == ApiMethod.post).map((r) => r.path),
      [
        '/api/notifications/n1/read',
        '/api/notifications/read-all',
        '/api/notifications/n1/clear',
        '/api/notifications/clear-all',
      ],
    );
    await c.close();
    await a.updates.close();
  });
  testWidgets('opening share UI and Back creates no link', (tester) async {
    final a = CollectionAuthority(),
        t = CollectionTransport((_, _) => const ApiResponse(200, []));
    final c = ShareController(shares(a, t, ReportingStore()));
    await tester.pumpWidget(
      MaterialApp(
        home: ShareSheet(
          controller: c,
          resource: ShareResource.track(collectionTrack(1)),
        ),
      ),
    );

    await tester.pumpAndSettle();

    expect(find.text('Создать ссылку'), findsOneWidget);
    expect(t.requests.where((r) => r.method == ApiMethod.post), isEmpty);
    await tester.pumpWidget(const SizedBox.shrink());
    await drain(tester, c.close());
    await drain(tester, a.updates.close());
  }, timeout: const Timeout(Duration(seconds: 15)));
  testWidgets(
    'inbox clear confirmation cancellation sends no POST and server-ready is not phone-ready',
    (tester) async {
      final a = CollectionAuthority(),
          t = CollectionTransport(
            (r, _) => r.path.endsWith('unread-count')
                ? const ApiResponse(200, {'count': 1})
                : ApiResponse(200, [notificationDto()]),
          );
      final c = InboxController(inbox(a, t));
      await tester.pumpWidget(MaterialApp(home: InboxScreen(controller: c)));
      await tester.pumpAndSettle();
      expect(find.textContaining('на сервере'), findsWidgets);
      await tester.tap(find.text('Очистить все'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Отмена'));
      await tester.pumpAndSettle();
      expect(t.requests.where((r) => r.method == ApiMethod.post), isEmpty);
      await tester.pumpWidget(const SizedBox.shrink());
      await drain(tester, c.close());
      await drain(tester, a.updates.close());
    },
  );
}

Map<String, Object?> _playCreationFeatures() => {
  'discovery': true,
  'autoPlaylists': false,
  'federation': false,
  'playCreation': {
    'version': 1,
    'newCreationsEnabled': true,
    'replaySupported': true,
    'createPath': '/api/plays/idempotent',
    'ownerHistoryEpoch': 7,
    'serverNowMs': 1700000000000,
    'replayWindowSeconds': 86400,
    'futureSkewSeconds': 300,
    'capabilityTtlSeconds': 300,
    'allowedSources': ['youtube'],
  },
};

final class _CapabilitiesPolicy extends ChangeNotifier
    implements NetworkPolicy {
  bool _online = true;
  @override
  bool get networkAllowed => _online;
  @override
  void requireNetwork() {
    if (!_online) throw StateError('offline');
  }

  void change(bool online) {
    _online = online;
    notifyListeners();
  }
}

final class _HeldCapabilitiesStore implements OwnerStore {
  final _inner = ReportingStore();
  final entered = Completer<void>(), release = Completer<void>();
  @override
  Future<T> transaction<T>(
    SessionFence fence,
    Future<T> Function(OwnerTransaction) operation,
  ) async {
    if (!entered.isCompleted) {
      entered.complete();
      await release.future;
    }
    return _inner.transaction(fence, operation);
  }
}

class GateAuthority extends CollectionAuthority {
  final reached = Completer<void>(), gate = Completer<void>();
  int calls = 0;
  @override
  Future<void> assertCurrent(SessionFence fence) async {
    if (++calls == 2) {
      reached.complete();
      await gate.future;
    }
    await super.assertCurrent(fence);
  }
}

class RefreshAuthority extends CollectionAuthority {
  final reached = Completer<void>(), gate = Completer<void>();
  int revision = 0;
  @override
  Future<AccessGrant> grantAccess(SessionFence fence, Uri exactOrigin) async {
    await assertCurrent(fence);
    return AccessGrant(
      authStamp: AuthStamp(fence: fence, tokenRevision: revision),
      accessToken: 'synthetic-$revision',
    );
  }

  @override
  Future<AuthStamp> after401(AuthStamp rejected) async {
    reached.complete();
    await gate.future;
    await assertCurrent(rejected.fence);
    revision++;
    updates.add(
      SessionState(
        status: SessionStatus.authenticated,
        fence: active,
        tokenRevision: revision,
      ),
    );
    return AuthStamp(fence: rejected.fence, tokenRevision: revision);
  }
}

Future<void> drain(WidgetTester tester, Future<void> closing) async {
  var completed = false;
  Object? error;
  closing.then(
    (_) => completed = true,
    onError: (Object e) {
      error = e;
      completed = true;
    },
  );
  for (var i = 0; i < 100 && !completed; i++) {
    await tester.pump();
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 10)),
    );
  }
  expect(
    completed,
    isTrue,
    reason: 'The original controller and fixture must finish draining',
  );
  if (error != null) throw error!;
}
