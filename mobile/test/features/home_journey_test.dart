import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/model/play_context.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/dart_api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/core/session/session_authority.dart';
import 'package:soundspan/design_system/design_system.dart';
import 'package:soundspan/features/home/home_controller.dart';
import 'package:soundspan/features/home/home_models.dart';
import 'package:soundspan/features/home/home_repository.dart';
import 'package:soundspan/features/home/home_screen.dart';
import 'package:soundspan/features/home/mix_screen.dart';

import '../support/collection_fixtures.dart';
import '../support/auth_fakes.dart' show ScriptedJsonClient;
import '../support/wave_reporting_fixtures.dart' show waveDto, waveFeed;

const snapshotDto = {
  'generatedAt': '2026-11-17T01:30:00+03:00',
  'compositionDay': '2026-11-16',
  'refreshAfter': '2026-11-17T00:00:00Z',
  'requestedCount': 40,
  'snapshotCount': 3,
  'availableCount': 1,
  'reasons': ['provider_degraded', 'feedback_filtered', 'pool_limited'],
};

ApiResponse snapshotResponse(ApiRequest request) {
  if (request.path == '/api/personalized/daily-mixes') {
    return ApiResponse(200, {
      'mixes': [
        for (final key in ['rock', 'jazz', 'indie'])
          {
            'key': key,
            'title': 'Микс $key',
            'description': '',
            'tracks': [waveDto(key)],
            'snapshot': snapshotDto,
          },
        {
          'key': 'empty',
          'title': 'Микс без записей',
          'description': '',
          'tracks': [],
          'snapshot': {...snapshotDto, 'availableCount': 0},
        },
      ],
      'statuses': [
        {'key': 'rock', 'title': 'Микс rock', 'snapshot': snapshotDto},
        {
          'key': 'empty',
          'title': 'Микс без записей',
          'snapshot': {...snapshotDto, 'availableCount': 0},
        },
      ],
    });
  }
  return ApiResponse(200, {
    ...waveFeed([]),
    'languageStatus': {'pending': true},
  });
}

ApiResponse homeResponse(ApiRequest request) => switch (request.path) {
  '/api/personalized/home' => ApiResponse(
    200,
    waveFeed(['a', 'b', 'c', 'd', 'e', 'f']),
  ),
  '/api/personalized/daily-mixes' => ApiResponse(200, {
    'mixes': [
      {
        'key': 'style-rock',
        'title': 'Ваш рок',
        'description': 'Близкое и новое',
        'generationId': 'daily-generation',
        'tracks': [waveDto('rock')],
      },
    ],
  }),
  '/api/discover/current' => const ApiResponse(200, {
    'kind': 'online-weekly',
    'generationId': 'weekly-gen',
    'weekStart': '2026-10-12',
    'weekEnd': '2026-10-19',
    'tracks': [],
    'unavailable': [],
    'totalCount': 0,
    'unavailableCount': 0,
  }),
  '/api/mixes' => const ApiResponse(200, [
    {
      'id': 'local-mix',
      'name': 'Забытое',
      'description': 'Из коллекции',
      'trackCount': 2,
      'coverUrls': [],
    },
  ]),
  '/api/mixes/local-mix' => ApiResponse(200, {
    'id': 'local-mix',
    'name': 'Забытое',
    'description': 'Из коллекции',
    'trackCount': 2,
    'tracks': [likedDto(1), likedDto(1)],
  }),
  '/api/mixes/local-mix/save' => const ApiResponse(200, {
    'id': 'saved-1',
    'name': 'Забытое',
    'trackCount': 2,
  }),
  _ => const ApiResponse(404, null),
};

HomeRepository repo(
  CollectionAuthority authority,
  CollectionTransport transport, {
  NetworkPolicy policy = const NetworkPolicy.online(),
}) => HomeRepository(
  transport: transport,
  authority: authority,
  fence: collectionFence,
  networkPolicy: policy,
);
HomeRequest request({bool legacy = false, bool weekly = false}) => HomeRequest(
  localHour: 8,
  timezoneOffsetMinutes: 180,
  autoPlaylists: legacy,
  discovery: weekly,
);

class _GrantedHomeAuthority extends CollectionAuthority {
  Completer<void>? assertionGate;
  @override
  Future<void> assertCurrent(SessionFence fence) async {
    final gate = assertionGate;
    assertionGate = null;
    await gate?.future;
    await super.assertCurrent(fence);
  }

  @override
  Future<AccessGrant> grantAccess(SessionFence fence, Uri exactOrigin) async {
    await assertCurrent(fence);
    return AccessGrant(
      authStamp: AuthStamp(fence: fence, tokenRevision: 1),
      accessToken: 'fixture-access',
    );
  }
}

void main() {
  test('snapshot metadata preserves composition counts and missing dates stay unknown', () async {
    final repository = repo(
      CollectionAuthority(),
      CollectionTransport((r, _) => snapshotResponse(r)),
    );
    final feed = await repository.load(request());
    final mix = feed.mixes.first;
    expect(mix.snapshot?.generatedAt, DateTime.utc(2026, 11, 16, 22, 30));
    expect(mix.snapshot?.compositionDay, '2026-11-16');
    expect(mix.snapshot?.refreshAfter, DateTime.utc(2026, 11, 17));
    expect(mix.snapshot?.requestedCount, 40);
    expect(mix.snapshot?.snapshotCount, 3);
    expect(mix.snapshot?.availableCount, 1);
    expect(mix.trackCount, 1);
    expect(mix.tracks.map((track) => track.title), ['rock']);
    expect(await repository.detail(mix), same(mix));
    expect(feed.mixes.any((mix) => mix.id == 'empty'), isFalse);
    expect(feed.mixStatuses.map((status) => status.id), ['empty']);
    final undated = MixSnapshot.tryParse(
      {...snapshotDto}..remove('generatedAt'),
    );
    expect(undated?.generatedAt, isNull);
    expect(undated?.labels, [
      'Часть музыки временно недоступна',
      'С учётом ваших оценок',
      'Пока меньше подходящих треков',
    ]);
  });

  test('malformed or legacy snapshots never discard playable daily or weekly tracks', () async {
    for (final snapshot in <Object?>[
      null,
      'broken',
      {...snapshotDto, 'generatedAt': 'not-a-date'},
      {...snapshotDto, 'generatedAt': '2026-11-17T01:30:00'},
      {...snapshotDto, 'generatedAt': '2026-02-30T01:30:00Z'},
      {...snapshotDto, 'generatedAt': '2026-11-17T01:30:00+99:99'},
      {...snapshotDto, 'compositionDay': '2026-02-30'},
      {...snapshotDto, 'availableCount': -1},
      {
        ...snapshotDto,
        'reasons': [7],
      },
      {...snapshotDto}..remove('refreshAfter'),
    ]) {
      final repository = repo(
        CollectionAuthority(),
        CollectionTransport((r, _) {
          if (r.path == '/api/personalized/daily-mixes') {
            return ApiResponse(200, {
              'mixes': [
                {
                  'key': 'legacy',
                  'title': 'Без даты',
                  'description': '',
                  'tracks': [waveDto('kept'), waveDto('kept')],
                  'snapshot': snapshot,
                },
              ],
            });
          }
          return ApiResponse(200, {
            'tracks': [],
            'unavailable': [],
            'totalCount': 0,
            'snapshot': snapshot,
          });
        }),
      );
      final mix = (await repository.dailyMixes()).single;
      expect(mix.snapshot, isNull, reason: '$snapshot');
      expect(mix.tracks.map((track) => track.title), ['kept', 'kept']);
      expect(mix.trackCount, 2);
      expect((await repository.weekly()).snapshot, isNull);
    }
  });

  for (final scale in [2.0, 3.0]) {
    testWidgets(
      'mix cards stay usable without diagnostic metadata at 320dp scale $scale',
      (tester) async {
        tester.view.physicalSize = const Size(320, 760);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        var failDaily = false, plays = 0;
        MusicMix? opened;
        final controller = HomeController(
          repository: repo(
            CollectionAuthority(),
            CollectionTransport((r, _) {
              if (failDaily && r.path == '/api/personalized/daily-mixes') {
                return const ApiResponse(503, null);
              }
              return snapshotResponse(r);
            }),
          ),
          request: request(),
        );
        await controller.refresh();
        await tester.pumpWidget(
          MaterialApp(
            theme: SoundspanTheme.dark(),
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context)
                  .copyWith(textScaler: TextScaler.linear(scale)),
              child: child!,
            ),
            home: HomeScreen(
              controller: controller,
              autoLoad: false,
              onOpenWave: () {},
              onOpenMix: (mix) => opened = mix,
              onPlay: (_) => plays++,
            ),
          ),
        );
        await tester.pumpAndSettle();
        await tester.scrollUntilVisible(
          find.text('Микс rock'),
          400,
          scrollable: find.byType(Scrollable).first,
        );
        for (final label in [
          'Составлен 16 ноября 2026',
          'Часть музыки временно недоступна',
          'С учётом ваших оценок',
          'Пока меньше подходящих треков',
          'Уточняем язык песен. Подборки появятся после обработки.',
        ]) {
          expect(find.text(label), findsNothing);
        }
        await tester.ensureVisible(find.text('Микс rock'));
        await tester.pumpAndSettle();
        final beforeSwipe = tester.getTopLeft(find.text('Микс indie')).dx;
        await tester.drag(find.text('Микс rock'), const Offset(-350, 0));
        await tester.pumpAndSettle();
        expect(
          tester.getTopLeft(find.text('Микс indie')).dx,
          lessThan(beforeSwipe),
        );
        await tester.ensureVisible(find.text('Микс indie'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Микс indie'));
        await tester.pump();
        expect(opened?.id, 'indie');
        await controller.refresh();
        failDaily = true;
        await controller.refresh();
        await tester.pumpAndSettle();
        final refreshed = controller.state.feed.mixes.first;
        expect(
          refreshed.snapshot?.generatedAt,
          DateTime.utc(2026, 11, 16, 22, 30),
        );
        expect(refreshed.tracks.map((track) => track.title), ['rock']);
        expect(controller.state.feed.mixStatuses.map((status) => status.id), [
          'empty',
        ]);
        expect(controller.state.feed.degraded, isTrue);
        expect(find.byKey(const ValueKey('empty-mix-empty')), findsNothing);
        expect(
          find.widgetWithText(MusicCard, 'Микс без записей'),
          findsNothing,
        );
        expect(
          find.ancestor(
            of: find.text('Микс без записей'),
            matching: find.byType(MusicTapTarget),
          ),
          findsNothing,
        );
        expect(find.text('Микс без записей'), findsNothing);
        expect(find.text('Пока нет готовой подборки'), findsNothing);
        expect(
          find.textContaining('Часть музыки временно недоступна'),
          findsNothing,
        );
        expect(find.text('Повторить загрузку подборок'), findsNothing);
        await tester.pumpWidget(
          MaterialApp(
            theme: SoundspanTheme.dark(),
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context)
                  .copyWith(textScaler: TextScaler.linear(scale)),
              child: child!,
            ),
            home: MixScreen(
              controller: controller,
              mix: opened!,
              onPlay: (_) => plays++,
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('Составлен 16 ноября 2026'), findsNothing);
        expect(find.text('С учётом ваших оценок'), findsNothing);
        expect(find.text('1 трек · доступно: 1'), findsOneWidget);
        expect(plays, 0);
        await tester.ensureVisible(find.text('Слушать'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Слушать'));
        await tester.pump();
        expect(plays, 1);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        controller.dispose();
      },
    );
  }

  testWidgets('empty degraded Home offers a short retry and recovers cards', (
    tester,
  ) async {
    var unavailable = true;
    final controller = HomeController(
      repository: repo(
        CollectionAuthority(),
        CollectionTransport((r, _) {
          if (unavailable && r.path == '/api/personalized/daily-mixes') {
            return const ApiResponse(503, null);
          }
          return snapshotResponse(r);
        }),
      ),
      request: request(),
    );
    try {
      await controller.refresh();
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: HomeScreen(
            controller: controller,
            autoLoad: false,
            onOpenWave: () {},
            onOpenMix: (_) {},
            onPlay: (_) {},
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(controller.state.feed.degraded, isTrue);
      expect(find.text('Не удалось загрузить подборки.'), findsOneWidget);
      expect(find.textContaining('Уточняем язык песен.'), findsNothing);
      expect(find.text('Повторить загрузку подборок'), findsOneWidget);
      unavailable = false;
      await tester.tap(find.text('Повторить загрузку подборок'));
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.text('Микс rock'),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      expect(find.widgetWithText(MusicCard, 'Микс rock'), findsOneWidget);
      expect(find.text('Не удалось загрузить подборки.'), findsNothing);
      expect(find.text('Повторить загрузку подборок'), findsNothing);
      expect(tester.takeException(), isNull);
    } finally {
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    }
  });

  test('visibility revoked during authoritative guard neither reports nor consumes dedup', () async {
    final authority = _GrantedHomeAuthority();
    final transport = CollectionTransport(
      (r, _) => r.method == ApiMethod.post
          ? const ApiResponse(200, {})
          : homeResponse(r),
    );
    final controller = HomeController(
      repository: repo(authority, transport),
      request: request(),
    );
    await controller.refresh();
    final shelf = controller.state.feed.shelves.last;
    var visible = true;
    final gate = Completer<void>();
    authority.assertionGate = gate;
    final pending = controller.reportVisible(shelf, [
      0,
      1,
    ], isVisible: () => visible);
    visible = false;
    gate.complete();
    await pending;
    expect(
      transport.requests.where((r) => r.method == ApiMethod.post),
      isEmpty,
    );
    visible = true;
    await controller.reportVisible(shelf, [0, 1], isVisible: () => visible);
    expect(
      transport.requests.where((r) => r.method == ApiMethod.post).length,
      1,
    );
    controller.dispose();
  });

  for (final reason in ['background', 'covered route', 'ticker disabled']) {
    testWidgets('$reason cancels pending impressions and return reports once', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(390, 850);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final transport = CollectionTransport(
        (r, _) => r.method == ApiMethod.post
            ? const ApiResponse(200, {})
            : homeResponse(r),
      );
      final controller = HomeController(
        repository: repo(CollectionAuthority(), transport),
        request: request(),
      );
      await controller.refresh();
      final scroll = ScrollController(),
          navigator = GlobalKey<NavigatorState>();
      var tickers = true;
      late StateSetter redraw;
      await tester.pumpWidget(
        MaterialApp(
          navigatorKey: navigator,
          theme: SoundspanTheme.dark(),
          home: StatefulBuilder(
            builder: (_, setState) {
              redraw = setState;
              return TickerMode(
                enabled: tickers,
                child: HomeScreen(
                  controller: controller,
                  autoLoad: false,
                  scrollController: scroll,
                  onOpenWave: () {},
                  onOpenMix: (_) {},
                  onPlay: (_) {},
                ),
              );
            },
          ),
        ),
      );
      scroll.jumpTo(1800);
      await tester.pump();
      if (reason == 'background') {
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.inactive,
        );
        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      } else if (reason == 'covered route') {
        unawaited(
          showDialog<void>(
            context: navigator.currentContext!,
            builder: (_) => const AlertDialog(content: Text('Поверх главной')),
          ),
        );
      } else {
        redraw(() => tickers = false);
      }
      await tester.pumpAndSettle();
      await tester.pump(const Duration(milliseconds: 300));
      expect(
        transport.requests.where((r) => r.method == ApiMethod.post),
        isEmpty,
      );
      if (reason == 'background') {
        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.inactive,
        );
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        );
      } else if (reason == 'covered route') {
        navigator.currentState!.pop();
      } else {
        redraw(() => tickers = true);
      }
      await tester.pumpAndSettle();
      await tester.pump(const Duration(milliseconds: 300));
      final count = transport.requests
          .where((r) => r.method == ApiMethod.post)
          .length;
      expect(count, greaterThan(0));
      await tester.pump(const Duration(milliseconds: 600));
      expect(
        transport.requests.where((r) => r.method == ApiMethod.post).length,
        count,
      );
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      scroll.dispose();
    });
  }
  test(
    'real transport legacy409 reconciles exact owned mix over paged GET only',
    () async {
      final authority = _GrantedHomeAuthority(), requests = <ApiRequest>[];
      final client = ScriptedJsonClient((r, _) async {
        requests.add(r);
        if (r.method == ApiMethod.post) {
          return const ApiResponse(409, {'playlistId': 'untrusted-error-body'});
        }
        if (r.path == '/api/playlists' && r.query['offset'] == '0') {
          return ApiResponse(
            200,
            List.generate(
              500,
              (i) => {
                'id': 'other-$i',
                'mixId': i == 0 ? 'legacy' : 'different',
                'userId': i == 0 ? 'b' : 'a',
                'isOwner': i != 0,
              },
            ),
          );
        }
        return const ApiResponse(200, [
          {
            'id': 'confirmed-owned',
            'mixId': 'legacy',
            'userId': 'a',
            'isOwner': true,
          },
        ]);
      });
      final repository = HomeRepository(
        transport: DartApiTransport(client: client, authority: authority),
        authority: authority,
        fence: collectionFence,
      );
      final receipt = await repository.saveLegacy(
        MusicMix(
          id: 'legacy',
          title: 'Подборка',
          description: '',
          kind: MusicMixKind.legacy,
        ),
      );
      expect(receipt.playlistId, 'confirmed-owned');
      expect(requests.map((r) => r.method), [
        ApiMethod.post,
        ApiMethod.get,
        ApiMethod.get,
      ]);
      expect(requests.last.query, {'limit': '500', 'offset': '500'});
    },
  );

  test(
    'real transport409 never infers playlist from name or public other owner',
    () async {
      final authority = _GrantedHomeAuthority(), requests = <ApiRequest>[];
      final transport = DartApiTransport(
        authority: authority,
        client: ScriptedJsonClient((r, _) async {
          requests.add(r);
          if (r.method == ApiMethod.post) return const ApiResponse(409, null);
          return const ApiResponse(200, [
            {
              'id': 'foreign',
              'mixId': 'legacy',
              'userId': 'b',
              'isOwner': true,
              'name': 'Подборка',
            },
            {
              'id': 'same-name',
              'mixId': null,
              'userId': 'a',
              'isOwner': true,
              'name': 'Подборка',
            },
          ]);
        }),
      );
      final controller = HomeController(
        repository: HomeRepository(
          transport: transport,
          authority: authority,
          fence: collectionFence,
        ),
        request: request(),
      );
      await controller.openMix(
        MusicMix(
          id: 'legacy',
          title: 'Подборка',
          description: '',
          kind: MusicMixKind.legacy,
        ),
      );
      await controller.saveSelected();
      await controller.saveSelected();
      expect(controller.state.saveStatus, MixSaveStatus.uncertain);
      expect(controller.state.saveReceipt, isNull);
      expect(requests.where((r) => r.method == ApiMethod.post).length, 1);
      controller.dispose();
    },
  );

  testWidgets(
    'inactive indexed Home has zero impressions and activation exposes once',
    (tester) async {
      tester.view.physicalSize = const Size(390, 850);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final transport = CollectionTransport(
        (r, _) => r.method == ApiMethod.post
            ? const ApiResponse(200, {})
            : homeResponse(r),
      );
      final controller = HomeController(
        repository: repo(CollectionAuthority(), transport),
        request: request(),
      );
      await controller.refresh();
      final scroll = ScrollController(), visible = ValueNotifier(false);
      var index = 1;
      late StateSetter redraw;
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: StatefulBuilder(
            builder: (_, setState) {
              redraw = setState;
              return IndexedStack(
                index: index,
                children: [
                  HomeScreen(
                    controller: controller,
                    autoLoad: false,
                    scrollController: scroll,
                    visibility: visible,
                    onOpenWave: () {},
                    onOpenMix: (_) {},
                    onPlay: (_) {},
                  ),
                  const Scaffold(body: Text('Другая вкладка')),
                ],
              );
            },
          ),
        ),
      );
      for (final offset in [500.0, 1000.0, 1500.0, 2000.0]) {
        scroll.jumpTo(offset);
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 300));
      }
      expect(
        transport.requests.where((r) => r.method == ApiMethod.post),
        isEmpty,
      );
      redraw(() => index = 0);
      visible.value = true;
      await tester.pumpAndSettle();
      await tester.pump(const Duration(milliseconds: 300));
      expect(
        transport.requests.where((r) => r.method == ApiMethod.post),
        isNotEmpty,
      );
      final count = transport.requests
          .where((r) => r.method == ApiMethod.post)
          .length;
      visible.value = false;
      redraw(() => index = 1);
      await tester.pump();
      visible.value = true;
      redraw(() => index = 0);
      await tester.pumpAndSettle();
      await tester.pump(const Duration(milliseconds: 300));
      expect(
        transport.requests.where((r) => r.method == ApiMethod.post).length,
        count,
      );
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      scroll.dispose();
      visible.dispose();
    },
  );

  testWidgets(
    'hidden raw IndexedStack Home never reports without visibility seam',
    (tester) async {
      final transport = CollectionTransport(
        (r, _) => r.method == ApiMethod.post
            ? const ApiResponse(200, {})
            : homeResponse(r),
      );
      final controller = HomeController(
        repository: repo(CollectionAuthority(), transport),
        request: request(),
      );
      await controller.refresh();
      final scroll = ScrollController();
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: IndexedStack(
            index: 1,
            children: [
              HomeScreen(
                controller: controller,
                autoLoad: false,
                scrollController: scroll,
                onOpenWave: () {},
                onOpenMix: (_) {},
                onPlay: (_) {},
              ),
              const Scaffold(body: Text('Другая вкладка')),
            ],
          ),
        ),
      );
      for (final offset in [500.0, 1000.0, 1500.0, 2000.0]) {
        scroll.jumpTo(offset);
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 300));
      }
      expect(
        transport.requests.where((r) => r.method == ApiMethod.post),
        isEmpty,
      );
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      scroll.dispose();
    },
  );
  testWidgets(
    'Home hero explicit Listen and settings are separate from navigation',
    (tester) async {
      final controller = HomeController(
        repository: repo(
          CollectionAuthority(),
          CollectionTransport((r, _) => homeResponse(r)),
        ),
        request: request(),
      );
      var opens = 0, plays = 0, settings = 0;
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: HomeScreen(
            controller: controller,
            autoLoad: false,
            onOpenWave: () {
              opens++;
            },
            onOpenMix: (_) {},
            onPlay: (_) {},
            onStartWave: () {
              plays++;
            },
            onConfigureWave: () {
              settings++;
            },
          ),
        ),
      );
      await tester.tap(find.text('Слушать волну'));
      await tester.pump();
      expect(plays, 1);
      expect(opens, 0);
      await tester.tap(find.byTooltip('Настроить волну'));
      await tester.pump();
      expect(settings, 1);
      expect(plays, 1);
      await tester.tap(find.text('Открыть волну'));
      await tester.pump();
      expect(opens, 1);
      expect(plays, 1);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    },
  );
  test('native daily and weekly keep exact recording; legacy has separate library mapping', () async {
    final native = <String, Object?>{
      'id': 'yandex:42',
      'title': 'Запись',
      'duration': 200,
      'source': 'yandex',
      'streamSource': 'yandex',
      'artist': {'id': null, 'name': 'Артист'},
      'album': {'id': null, 'title': 'Альбом', 'coverArt': null},
      'provider': {
        'source': 'yandex',
        'providerTrackId': '42',
        'youtubeVideoId': null,
        'tidalTrackId': null,
      },
      'musicSourceRecording': {
        'provider': 'yandex',
        'id': '42',
        'title': 'Запись',
        'artists': ['Артист'],
        'duration': 200,
        'contentVersion': 'unknown',
        'preview': false,
      },
    };
    final authority = CollectionAuthority();
    final transport = CollectionTransport((r, _) {
      if (r.path == '/api/personalized/daily-mixes') {
        return ApiResponse(200, {
          'mixes': [
            {
              'key': 'native',
              'title': 'Родное',
              'description': '',
              'generationId': 'native-gen',
              'snapshot': snapshotDto,
              'tracks': [native],
            },
          ],
        });
      }
      if (r.path == '/api/discover/current') {
        return ApiResponse(200, {
          'kind': 'online-weekly',
          'generationId': 'week-gen',
          'snapshot': {
            ...snapshotDto,
            'weekStart': '2026-11-16T00:00:00Z',
            'weekEnd': '2026-11-23T00:00:00Z',
          },
          'weekStart': '2026-10-12',
          'weekEnd': '2026-10-19',
          'tracks': [
            {
              ...native,
              'sourceType': 'yandex',
              'artist': 'Артист',
              'album': 'Альбом',
              'coverUrl': null,
              'available': true,
            },
          ],
          'unavailable': [],
          'totalCount': 1,
        });
      }
      return homeResponse(r);
    });
    final repository = repo(authority, transport);
    final daily = (await repository.dailyMixes()).single;
    final weekly = await repository.weekly();
    expect((daily.tracks.single.ref as NativeTrackRef).recording.id, '42');
    expect(weekly.tracks.single.ref, daily.tracks.single.ref);
    expect(weekly.generationId, 'week-gen');
    expect(daily.snapshot?.generatedAt, DateTime.utc(2026, 11, 16, 22, 30));
    expect(weekly.snapshot?.generatedAt, daily.snapshot?.generatedAt);
    expect(weekly.snapshot?.weekStart, DateTime.utc(2026, 11, 16));
    expect(weekly.snapshot?.weekEnd, DateTime.utc(2026, 11, 23));
    expect(weekly.trackCount, 1);
    final legacy = await repository.detail(
      (await repository.legacyMixes()).single,
    );
    expect(legacy.tracks.map((t) => t.ref.identityKey), [
      'library:local-1',
      'library:local-1',
    ]);
  });

  test(
    'uncertain legacy save survives reopen and reconcile uses callback only',
    () async {
      final transport = CollectionTransport((r, _) {
        if (r.method == ApiMethod.post) throw StateError('lost');
        return homeResponse(r);
      });
      final controller = HomeController(
        repository: repo(CollectionAuthority(), transport),
        request: request(),
      );
      final mix = MusicMix(
        id: 'local-mix',
        title: 'Забытое',
        description: '',
        kind: MusicMixKind.legacy,
        loaded: false,
      );
      await controller.openMix(mix);
      await controller.saveSelected();
      await controller.openMix(
        MusicMix(
          id: 'other',
          title: 'Другое',
          description: '',
          kind: MusicMixKind.daily,
        ),
      );
      await controller.openMix(mix);
      await controller.saveSelected();
      expect(controller.state.saveStatus, MixSaveStatus.uncertain);
      expect(
        transport.requests.where((r) => r.method == ApiMethod.post).length,
        1,
      );
      await controller.reconcileSelected((original, fence) async {
        expect(original.id, 'local-mix');
        expect(fence, collectionFence);
        return const MixSaveReceipt(
          playlistId: 'actual-id',
          message: 'Проверено',
        );
      });
      expect(controller.state.saveStatus, MixSaveStatus.saved);
      expect(
        transport.requests.where((r) => r.method == ApiMethod.post).length,
        1,
      );
      controller.dispose();
    },
  );

  test(
    'failed refresh keeps previously available shelves and marks degradation',
    () async {
      var failMain = false;
      final transport = CollectionTransport(
        (r, _) => failMain && r.query['surface'] == 'home'
            ? const ApiResponse(503, null)
            : homeResponse(r),
      );
      final controller = HomeController(
        repository: repo(CollectionAuthority(), transport),
        request: request(),
      );
      await controller.refresh();
      failMain = true;
      await controller.refresh();
      expect(controller.state.feed.shelves.last.tracks.first.title, 'a');
      expect(controller.state.feed.failures['home'], isNotNull);
      expect(controller.state.feed.degraded, isTrue);
      transport.requests.clear();
      failMain = false;
      await controller.retryFailed();
      expect(transport.requests.length, 1);
      expect(transport.requests.single.query['surface'], 'home');
      expect(controller.state.feed.mixes, isNotEmpty);
      expect(controller.state.feed.failures, isEmpty);
      controller.dispose();
    },
  );

  test(
    'stale detail response and save result cannot replace newer selection',
    () async {
      final detail = Completer<ApiResponse>(),
          saved = Completer<MixSaveReceipt?>();
      final transport = CollectionTransport(
        (r, _) =>
            r.path == '/api/mixes/local-mix' ? detail.future : homeResponse(r),
      );
      final controller = HomeController(
        repository: repo(CollectionAuthority(), transport),
        request: request(),
      );
      final legacy = MusicMix(
        id: 'local-mix',
        title: 'Старое',
        description: '',
        kind: MusicMixKind.legacy,
        loaded: false,
      );
      final latest = MusicMix(
        id: 'fresh',
        title: 'Новое',
        description: '',
        kind: MusicMixKind.daily,
        tracks: [collectionTrack(1)],
      );
      final opening = controller.openMix(legacy);
      await controller.openMix(latest);
      detail.complete(
        homeResponse(
          ApiRequest(
            origin: collectionOrigin,
            method: ApiMethod.get,
            path: '/api/mixes/local-mix',
          ),
        ),
      );
      await opening;
      expect(controller.state.selectedMix, same(latest));
      final save = controller.saveSelected(save: (_, _) => saved.future);
      await controller.openMix(legacy);
      saved.complete(
        const MixSaveReceipt(playlistId: 'fresh-save', message: 'Готово'),
      );
      await save;
      expect(controller.state.selectedMix?.id, 'local-mix');
      expect(controller.state.saveReceipt, isNull);
      controller.dispose();
    },
  );

  test(
    'empty taste and disabled capabilities make no legacy or weekly query',
    () async {
      final transport = CollectionTransport(
        (r, _) => r.path == '/api/personalized/home'
            ? ApiResponse(200, waveFeed([], reason: 'insufficient_signals'))
            : const ApiResponse(200, {'mixes': []}),
      );
      final feed = await repo(CollectionAuthority(), transport).load(request());
      expect(feed.insufficientTaste, isTrue);
      expect(feed.empty, isTrue);
      expect(
        transport.requests.any(
          (r) => r.path == '/api/mixes' || r.path == '/api/discover/current',
        ),
        isFalse,
      );
      expect(
        () => HomeRequest(
          localHour: 24,
          timezoneOffsetMinutes: 180,
          autoPlaylists: false,
          discovery: false,
        ),
        throwsArgumentError,
      );
    },
  );
  test(
    'independent daily DTO, daypart query and positive east offset',
    () async {
      final authority = CollectionAuthority();
      final transport = CollectionTransport((r, _) => homeResponse(r));
      final feed = await repo(
        authority,
        transport,
      ).load(request(legacy: true, weekly: true));
      expect(
        feed.mixes.firstWhere((m) => m.kind == MusicMixKind.daily).id,
        'style-rock',
      );
      expect(
        feed.mixes.firstWhere((m) => m.kind == MusicMixKind.daily).generationId,
        'daily-generation',
      );
      expect(
        feed.mixes.firstWhere((m) => m.kind == MusicMixKind.daypart).title,
        'Ваше утро',
      );
      final daypart = transport.requests.singleWhere(
        (r) => r.query['timeOfDay'] == '1',
      );
      expect(daypart.query['surface'], 'made-for-you');
      expect(daypart.query['localHour'], '8');
      expect(daypart.query['timezoneOffsetMinutes'], '180');
      expect(transport.fences.every((f) => f == collectionFence), isTrue);
      expect(
        feed.mixes
            .where((m) => m.kind == MusicMixKind.legacy)
            .single
            .trackCount,
        2,
      );
    },
  );

  test(
    'offlineValidated stays online; explicit offline makes zero HTTP',
    () async {
      final authority = CollectionAuthority()..restoreLocally();
      final transport = CollectionTransport((r, _) => homeResponse(r));
      await repo(authority, transport).load(request());
      expect(transport.requests, isNotEmpty);
      transport.requests.clear();
      final controller = HomeController(
        repository: repo(
          authority,
          transport,
          policy: const NetworkPolicy.offline(),
        ),
        request: request(),
      );
      await controller.refresh();
      expect(controller.state.failure?.code, 'offline_mode');
      expect(transport.requests, isEmpty);
      controller.dispose();
    },
  );

  test(
    'language pending and provider failure are distinct from empty taste',
    () async {
      final authority = CollectionAuthority();
      final transport = CollectionTransport(
        (r, _) => r.path == '/api/personalized/home'
            ? ApiResponse(200, {
                ...waveFeed([], reason: 'provider_unavailable'),
                'languageStatus': {'pending': true},
              })
            : const ApiResponse(503, null),
      );
      final feed = await repo(authority, transport).load(request());
      expect(feed.languagePending, isTrue);
      expect(feed.insufficientTaste, isFalse);
      expect(feed.degraded, isTrue);
      expect(feed.failures, isNotEmpty);
    },
  );

  test(
    'latest refresh wins and revoked controller cannot revive A B A',
    () async {
      final authority = CollectionAuthority();
      final pending = <Completer<ApiResponse>>[];
      final transport = CollectionTransport((r, _) {
        if (r.path == '/api/personalized/home' &&
            r.query['surface'] == 'home') {
          final result = Completer<ApiResponse>();
          pending.add(result);
          return result.future;
        }
        return homeResponse(r);
      });
      final controller = HomeController(
        repository: repo(authority, transport),
        request: request(),
      );
      final old = controller.refresh();
      await Future<void>.delayed(Duration.zero);
      final latest = controller.refresh();
      await Future<void>.delayed(Duration.zero);
      pending.last.complete(
        ApiResponse(200, waveFeed(['new'], generation: 'new-gen')),
      );
      await latest;
      pending.first.complete(
        ApiResponse(200, waveFeed(['old'], generation: 'old-gen')),
      );
      await old;
      expect(controller.state.feed.shelves.last.tracks.single.title, 'new');
      authority.switchOwner();
      authority.active = collectionFence;
      authority.updates.add(authority.state);
      expect(controller.isCurrent, isFalse);
      expect(controller.state.feed.shelves, isEmpty);
      controller.dispose();
    },
  );

  test(
    'ordered playback preserves duplicate occurrence and skips unavailable',
    () async {
      final authority = CollectionAuthority();
      final controller = HomeController(
        repository: repo(
          authority,
          CollectionTransport((r, _) => homeResponse(r)),
        ),
        request: request(),
      );
      final tracks = [
        collectionTrack(1),
        collectionTrack(9, playable: false),
        collectionTrack(1),
        collectionTrack(2),
      ];
      final mix = MusicMix(
        id: 'daily',
        title: 'День',
        description: '',
        kind: MusicMixKind.daily,
        tracks: tracks,
        generationId: 'generation',
      );
      final play = controller.playbackRequest(mix, 2);
      expect(play.tracks.map((t) => t.ref.identityKey), [
        'library:local-1',
        'library:local-1',
        'library:local-2',
      ]);
      expect(play.startIndex, 1);
      expect(play.context.surface, PlaySurface.home);
      expect(play.context.recommendationGenerationId, 'generation');
      expect(
        () => controller.playbackRequest(mix, 1),
        throwsA(isA<AppFailure>()),
      );
      controller.dispose();
    },
  );

  test(
    'lost save response becomes uncertain and reconcile never replays POST',
    () async {
      final authority = CollectionAuthority();
      final transport = CollectionTransport((r, _) {
        if (r.method == ApiMethod.post) throw StateError('lost response');
        return homeResponse(r);
      });
      final controller = HomeController(
        repository: repo(authority, transport),
        request: request(),
      );
      final legacy = MusicMix(
        id: 'local-mix',
        title: 'Забытое',
        description: '',
        kind: MusicMixKind.legacy,
      );
      await controller.openMix(legacy);
      await controller.saveSelected();
      await controller.saveSelected();
      expect(controller.state.saveStatus, MixSaveStatus.uncertain);
      expect(
        transport.requests.where((r) => r.method == ApiMethod.post).length,
        1,
      );
      controller.dispose();
    },
  );

  test(
    'visible reporting rejects stale shelf and deduplicates generation',
    () async {
      final authority = CollectionAuthority();
      final transport = CollectionTransport(
        (r, _) => r.path == '/api/personalized/impressions'
            ? const ApiResponse(200, {})
            : homeResponse(r),
      );
      final controller = HomeController(
        repository: repo(authority, transport),
        request: request(),
      );
      await controller.refresh();
      final shelf = controller.state.feed.shelves.last;
      await controller.reportVisible(shelf, [0, 1]);
      await controller.reportVisible(shelf, [0, 1]);
      expect(
        transport.requests
            .where((r) => r.method == ApiMethod.post)
            .single
            .body?['tracks'],
        [
          {'provider': 'youtube', 'providerTrackId': 'a'},
          {'provider': 'youtube', 'providerTrackId': 'b'},
        ],
      );
      await controller.refresh();
      await controller.reportVisible(shelf, [2]);
      expect(
        transport.requests.where((r) => r.method == ApiMethod.post).length,
        1,
      );
      authority.switchOwner();
      await controller.reportVisible(
        controller.state.feed.shelves.isEmpty
            ? shelf
            : controller.state.feed.shelves.last,
        [3],
      );
      expect(
        transport.requests.where((r) => r.method == ApiMethod.post).length,
        1,
      );
      controller.dispose();
    },
  );

  for (final width in [320.0, 390.0, 430.0]) {
    for (final scale in [1.0, 2.0]) {
      testWidgets(
        'Home and mix accessible at $width scale $scale; opening does not play',
        (tester) async {
          tester.view.physicalSize = Size(width, 850);
          tester.view.devicePixelRatio = 1;
          addTearDown(tester.view.resetPhysicalSize);
          addTearDown(tester.view.resetDevicePixelRatio);
          final authority = CollectionAuthority();
          final controller = HomeController(
            repository: repo(
              authority,
              CollectionTransport(
                (r, _) => r.path == '/api/personalized/impressions'
                    ? const ApiResponse(200, {})
                    : homeResponse(r),
              ),
            ),
            request: request(),
          );
          await controller.refresh();
          var played = 0, opened = 0;
          Widget app(Widget child) => MaterialApp(
            theme: SoundspanTheme.dark(),
            home: MediaQuery(
              data: MediaQueryData(
                size: Size(width, 850),
                textScaler: TextScaler.linear(scale),
              ),
              child: child,
            ),
          );
          await tester.pumpWidget(
            app(
              HomeScreen(
                controller: controller,
                autoLoad: false,
                onOpenWave: () {
                  opened++;
                },
                onOpenMix: (_) {},
                onPlay: (_) {
                  played++;
                },
              ),
            ),
          );
          await tester.ensureVisible(find.text('Открыть волну'));
          await tester.pump();
          await tester.tap(find.text('Открыть волну'));
          await tester.pump();
          expect(opened, 1);
          expect(played, 0);
          expect(tester.takeException(), isNull);
          final mix = MusicMix(
            id: 'test',
            title: 'Подборка с очень длинным русским названием для проверки переноса и доступности',
            description: 'Музыка вашего дня',
            kind: MusicMixKind.daily,
            tracks: [collectionTrack(1), collectionTrack(2, playable: false)],
          );
          await tester.pumpWidget(
            app(
              MixScreen(
                controller: controller,
                mix: mix,
                onPlay: (_) {
                  played++;
                },
              ),
            ),
          );
          await tester.pump();
          expect(tester.takeException(), isNull);
          expect(played, 0);
          await tester.ensureVisible(find.text('Слушать'));
          await tester.pump();
          await tester.tap(find.text('Слушать'));
          await tester.pump();
          expect(played, 1);
          await tester.ensureVisible(find.byTooltip('Перемешать подборку'));
          await tester.pump();
          await tester.tap(find.byTooltip('Перемешать подборку'));
          await tester.pump();
          expect(played, 2);
          await tester.pumpWidget(const SizedBox());
          controller.dispose();
        },
      );
    }
  }

  for (final size in [const Size(640, 360), const Size(780, 390)]) {
    testWidgets('Home and lazy mix scroll in landscape $size', (tester) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final controller = HomeController(
        repository: repo(
          CollectionAuthority(),
          CollectionTransport(
            (r, _) => r.path == '/api/personalized/impressions'
                ? const ApiResponse(200, {})
                : homeResponse(r),
          ),
        ),
        request: request(),
      );
      await controller.refresh();
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: HomeScreen(
            controller: controller,
            autoLoad: false,
            onOpenWave: () {},
            onOpenMix: (_) {},
            onPlay: (_) {},
          ),
        ),
      );
      await tester.ensureVisible(find.text('Открыть волну'));
      await tester.pump();
      expect(find.text('Открыть волну').hitTestable(), findsOneWidget);
      final mix = MusicMix(
        id: 'many',
        title: 'Тысяча песен',
        description: 'Последовательный состав',
        kind: MusicMixKind.daily,
        tracks: List.generate(1001, (i) => collectionTrack(i)),
      );
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: MixScreen(controller: controller, mix: mix, onPlay: (_) {}),
        ),
      );
      await tester.pump();
      expect(find.byType(TrackRow).evaluate().length, lessThan(20));
      await tester.drag(find.byType(CustomScrollView), const Offset(0, -500));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    });
  }

  testWidgets(
    'impressions only exposed cards; horizontal swipe and vertical scroll coexist',
    (tester) async {
      // Keep the recommendation shelf below the fold even with the compact
      // entry card: only scrolling into view may create an impression.
      tester.view.physicalSize = const Size(390, 480);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final transport = CollectionTransport(
        (r, _) => r.path == '/api/personalized/impressions'
            ? const ApiResponse(200, {})
            : homeResponse(r),
      );
      final controller = HomeController(
        repository: repo(CollectionAuthority(), transport),
        request: request(),
      );
      await controller.refresh();
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: HomeScreen(
            controller: controller,
            autoLoad: false,
            onOpenWave: () {},
            onOpenMix: (_) {},
            onPlay: (_) {},
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 300));
      expect(
        find.byKey(const ValueKey('home-shelf-discovery')).hitTestable(),
        findsNothing,
      );
      expect(
        transport.requests.where((r) => r.method == ApiMethod.post),
        isEmpty,
      );
      await tester.scrollUntilVisible(
        find.byKey(const ValueKey('home-shelf-discovery')),
        350,
        scrollable: find
            .descendant(
              of: find.byKey(const ValueKey('home-scroll')),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      await tester.pumpAndSettle();
      await tester.pump(const Duration(milliseconds: 300));
      final posts = transport.requests
          .where((r) => r.method == ApiMethod.post)
          .toList();
      expect(posts, isNotEmpty);
      final identities = posts
          .expand((r) => r.body!['tracks'] as List)
          .cast<Map>()
          .map((r) => r['providerTrackId']);
      expect(identities, contains('a'));
      expect(identities, isNot(contains('f')));
      await tester.drag(
        find.byKey(const ValueKey('home-shelf-discovery')),
        const Offset(-280, 0),
      );
      await tester.pumpAndSettle();
      await tester.pump(const Duration(milliseconds: 300));
      final afterSwipe = transport.requests
          .where((r) => r.method == ApiMethod.post)
          .expand((r) => r.body!['tracks'] as List)
          .cast<Map>()
          .map((r) => r['providerTrackId']);
      expect(afterSwipe, contains('d'));
      final beforeVertical = tester
          .getTopLeft(find.byKey(const ValueKey('home-shelf-discovery')))
          .dy;
      await tester.drag(
        find.byKey(const ValueKey('home-shelf-discovery')),
        const Offset(0, 180),
      );
      await tester.pumpAndSettle();
      expect(
        tester
            .getTopLeft(find.byKey(const ValueKey('home-shelf-discovery')))
            .dy,
        greaterThan(beforeVertical),
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    },
  );
}
