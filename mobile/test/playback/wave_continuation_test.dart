import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/dart_api_transport.dart';
import 'package:soundspan/core/session/credential_vault.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/queue_coordinator.dart';
import 'package:soundspan/features/recommendations/recommendation_repository.dart';
import 'package:soundspan/playback/wave_continuation.dart';

import '../support/media_fixtures.dart';
import '../support/auth_fakes.dart' show ScriptedJsonClient;
import '../support/wave_reporting_fixtures.dart';

void main() {
  for (final scenario in ['ordered', 'tail', 'single', 'direction', 'manual']) {
    test('Clear Wave restart preserves $scenario semantics', () async {
      final authority = await mediaAuthority(Uri.parse('https://report.test'));
      final fence = authority.requireFence();
      final ids = scenario == 'single'
          ? ['AAAAAAAAAA1']
          : [
              'AAAAAAAAAA1',
              'BBBBBBBBBB1',
              'CCCCCCCCCC1',
              'DDDDDDDDDD1',
              'EEEEEEEEEE1',
            ];
      var reads = 0;
      final transport = ControlledTransport()
        ..respond = (_) async {
          reads++;
          if (scenario != 'ordered') return ApiResponse(200, waveFeed(ids));
          return ApiResponse(200, {
            'generationId': 'restart-$reads',
            'orderedWave': {
              'version': 1,
              'sequenceId': '5d73c623-d11d-4fda-943e-0e01ce5b3be7',
              'startPosition': 0,
              'nextCursor': 'next',
              'items': [
                for (final (index, id) in ids.indexed)
                  {'position': index, 'track': waveDto(id)},
              ],
              'tail': [
                for (final (index, id) in ids.indexed.skip(3))
                  {'source': 'youtube', 'id': id, 'position': index},
              ],
            },
          });
        };
      final engine = ReportingEngine();
      final queue = QueueCoordinator(
        authority: authority,
        engine: engine,
        prepare: (_, _) async => PreparedAudio(
          uri: Uri.parse('http://127.0.0.1/synthetic'),
          revoke: () async {},
        ),
      );
      final wave = WaveContinuation(
        controller: queue,
        repository: RecommendationRepository(
          transport: transport,
          orderedWaveCapability: (_, _) async => scenario == 'ordered',
        ),
        authority: authority,
      );
      addTearDown(() async {
        await wave.dispose();
        await queue.dispose();
      });
      await wave.start(const WaveSelection(), fence);
      await settle();
      if (scenario == 'tail') {
        await queue.dispatch(PlayEntry(queue.snapshot.entries.last.entryId));
        await settle();
      }
      await queue.dispatch(const Clear());
      await settle();
      if (scenario == 'manual') {
        await queue.dispatch(
          ReplaceQueue(
            queue.createEntries([
              waveTrack('manual'),
            ], const PlayContext(surface: PlaySurface.library)),
            fence: fence,
          ),
        );
        await queue.dispatch(const Clear());
        await settle();
      }
      final selection = scenario == 'direction'
          ? const WaveSelection(mode: WaveMode.newMusic)
          : const WaveSelection();
      await wave.start(selection, fence);
      await settle();
      expect(
        queue.snapshot.currentEntry!.track.ref.identityKey,
        'yt:${scenario == 'ordered' ? ids[1] : ids[0]}',
      );
      expect(
        reads,
        2,
        reason: 'freshStart performs a bounded real request, including a single-recording catalogue',
      );
      if (scenario == 'ordered') {
        expect(
          queue.snapshot.entries.map((entry) => entry.track.ref.identityKey),
          ids.map((id) => 'yt:$id'),
        );
      }
    });
  }

  test(
    'Clear then fresh Wave does not replay its cleared first recording',
    () async {
      final authority = await mediaAuthority(Uri.parse('https://report.test'));
      final fence = authority.requireFence();
      final transport = ControlledTransport()
        ..respond = (_) async =>
            ApiResponse(200, waveFeed(['a', 'b', 'c', 'd', 'e']));
      final engine = ReportingEngine();
      final prepared = <String>[];
      final queue = QueueCoordinator(
        authority: authority,
        engine: engine,
        prepare: (entry, _) async {
          prepared.add(entry.track.ref.identityKey);
          return PreparedAudio(
            uri: Uri.parse('http://127.0.0.1/synthetic'),
            revoke: () async {},
          );
        },
      );
      final wave = WaveContinuation(
        controller: queue,
        repository: RecommendationRepository(transport: transport),
        authority: authority,
      );
      addTearDown(() async {
        await wave.dispose();
        await queue.dispose();
      });
      await wave.start(const WaveSelection(), fence);
      await settle();
      expect(queue.snapshot.currentEntry!.track.ref.identityKey, 'yt:a');
      await queue.dispatch(const Clear());
      await settle();
      expect(queue.snapshot.entries, isEmpty);
      expect(prepared, [
        'yt:a',
      ], reason: 'Clear never records another playback');
      await wave.start(const WaveSelection(), fence);
      await settle();
      expect(queue.snapshot.currentEntry!.track.ref.identityKey, 'yt:b');
      expect(prepared, ['yt:a', 'yt:b']);
    },
  );

  test(
    'Wave explains an API deadline without replacing the current queue',
    () async {
      final authority = await mediaAuthority(Uri.parse('https://report.test'));
      final controller = ReportingController();
      final before = controller.snapshot;
      final transport = ControlledTransport()
        ..respond = (_) async => const ApiResponse(504, {
          'code': 'RADIO_REQUEST_TIMEOUT',
          'error': 'upstream body must not become user-facing text',
        });
      final wave = WaveContinuation(
        controller: controller,
        repository: RecommendationRepository(transport: transport),
        authority: authority,
      );
      addTearDown(() async {
        await wave.dispose();
        await controller.dispose();
      });
      await wave.start(const WaveSelection(), authority.requireFence());
      expect(wave.state.status, WaveStatus.error);
      expect(wave.state.failure?.code, 'wave_request_timeout');
      expect(wave.state.failure?.statusCode, 504);
      expect(wave.state.failure?.retryable, true);
      expect(
        wave.state.failure?.message,
        'Волна не успела подготовиться. Попробуйте ещё раз',
      );
      expect(controller.snapshot, same(before));
    },
  );

  test(
    'Wave keeps classified network failure and server-directed holdoff',
    () async {
      for (final failure in [
        failureForStatus(429, retryAfter: const Duration(seconds: 23)),
        const AppFailure(
          code: 'network_timeout',
          message: 'Время подключения истекло',
          retryable: true,
        ),
      ]) {
        final authority = await mediaAuthority(
          Uri.parse('https://report.test'),
        );
        final controller = ReportingController();
        final transport = ControlledTransport()
          ..respond = (_) async => throw failure;
        final wave = WaveContinuation(
          controller: controller,
          repository: RecommendationRepository(transport: transport),
          authority: authority,
        );
        await wave.start(const WaveSelection(), authority.requireFence());
        expect(wave.state.failure, same(failure));
        await wave.dispose();
        await controller.dispose();
      }
    },
  );

  test('Wave never displays an unclassified exception body', () async {
    final authority = await mediaAuthority(Uri.parse('https://report.test'));
    final controller = ReportingController();
    final transport = ControlledTransport()
      ..respond = (_) async => throw StateError('Bearer private_secret');
    final wave = WaveContinuation(
      controller: controller,
      repository: RecommendationRepository(transport: transport),
      authority: authority,
    );
    await wave.start(const WaveSelection(), authority.requireFence());
    expect(wave.state.failure?.message, 'Не удалось продолжить Волну');
    expect(wave.state.failure?.message.contains('private_secret'), false);
    await wave.dispose();
    await controller.dispose();
  });

  for (final action in [
    'natural',
    'pause-before-end',
    'pause-after-end',
    'clear',
    'manual',
    'logout',
  ]) {
    test('late terminal Wave refill honors $action service intent', () async {
      final authority = await mediaAuthority(Uri.parse('https://report.test'));
      final fence = authority.requireFence();
      final transport = ControlledTransport();
      final refill = Completer<ApiResponse>();
      var pages = 0;
      transport.respond = (_) async => ++pages == 1
          ? ApiResponse(200, waveFeed(['a'], cursor: 71))
          : refill.future;
      final engine = ReportingEngine();
      final prepared = <String>[];
      final queue = QueueCoordinator(
        authority: authority,
        engine: engine,
        prepare: (entry, captured) async {
          expect(captured, fence);
          prepared.add(entry.track.ref.identityKey);
          return PreparedAudio(
            uri: Uri.parse('http://127.0.0.1/test'),
            revoke: () async {},
          );
        },
      );
      final wave = WaveContinuation(
        controller: queue,
        repository: RecommendationRepository(transport: transport),
        authority: authority,
      );
      addTearDown(() async {
        await wave.dispose();
        await queue.dispose();
      });
      await wave.start(const WaveSelection(), fence);
      await settle();
      expect(pages, 2);
      if (action == 'pause-before-end') await queue.dispatch(const Pause());
      engine.controller.add(
        EngineEvent(
          generation: queue.snapshot.generation,
          position: const Duration(seconds: 200),
          duration: const Duration(seconds: 200),
          processing: PlaybackProcessing.completed,
          playing: false,
        ),
      );
      await settle();
      expect(queue.snapshot.processing, PlaybackProcessing.completed);
      if (action == 'pause-after-end') await queue.dispatch(const Pause());
      if (action == 'clear') await queue.dispatch(const Clear());
      if (action == 'manual') {
        await queue.dispatch(
          ReplaceQueue(
            queue.createEntries([
              waveTrack('manual'),
            ], const PlayContext(surface: PlaySurface.library)),
            fence: fence,
          ),
        );
      }
      if (action == 'logout') await authority.invalidate();
      refill.complete(ApiResponse(200, waveFeed(['fresh'])));
      await settle();
      if (action == 'natural') {
        expect(queue.snapshot.currentEntry!.track.ref.identityKey, 'yt:fresh');
        expect(queue.snapshot.playingIntent, true);
        expect(prepared, ['yt:a', 'yt:fresh']);
      } else if (action == 'pause-before-end' || action == 'pause-after-end') {
        expect(queue.snapshot.currentEntry!.track.ref.identityKey, 'yt:a');
        expect(queue.snapshot.playingIntent, false);
        expect(prepared, ['yt:a']);
      } else {
        expect(prepared.contains('yt:fresh'), false);
        expect(wave.state.status, WaveStatus.detached);
      }
    });
  }
  test(
    'delayed old snapshot cannot detach a newer accepted Wave generation',
    () async {
      final authority = await mediaAuthority(Uri.parse('https://report.test'));
      final fence = authority.requireFence();
      final transport = ControlledTransport();
      transport.respond = (r) async => ApiResponse(
        200,
        waveFeed(
          r.query['mode'] == 'new' ? ['fresh'] : ['a', 'b', 'c', 'd'],
          cursor: r.query['mode'] == 'new' ? null : 71,
        ),
      );
      final controller = ReportingController();
      final wave = WaveContinuation(
        controller: controller,
        repository: RecommendationRepository(transport: transport),
        authority: authority,
      );
      await wave.start(const WaveSelection(), fence);
      final old = controller.snapshot;
      await wave.retune(const WaveSelection(mode: WaveMode.newMusic));
      controller.states.add(old);
      await settle();
      expect(wave.state.status, WaveStatus.exhausted);
      expect(wave.state.selection.mode, WaveMode.newMusic);
      await wave.dispose();
      await controller.dispose();
    },
  );
  test('service continues beyond initial batch and freshly prepares fetched entries without UI', () async {
    final authority = await mediaAuthority(Uri.parse('https://report.test'));
    final fence = authority.requireFence();
    final transport = ControlledTransport();
    var pages = 0;
    transport.respond = (_) async => ApiResponse(
      200,
      waveFeed(
        ++pages == 1 ? ['a', 'b', 'c', 'd'] : ['fresh1', 'fresh2', 'fresh3'],
        cursor: pages == 1 ? 711 : null,
      ),
    );
    final prepared = <String>[];
    final coordinator = QueueCoordinator(
      authority: authority,
      engine: ReportingEngine(),
      prepare: (entry, captured) async {
        expect(captured, fence);
        prepared.add(entry.track.ref.identityKey);
        return PreparedAudio(
          uri: Uri.parse('http://127.0.0.1/synthetic'),
          revoke: () async {},
        );
      },
    );
    final wave = WaveContinuation(
      controller: coordinator,
      repository: RecommendationRepository(transport: transport),
      authority: authority,
    );
    await wave.start(const WaveSelection(), fence);
    await settle();
    for (var i = 0; i < 4; i++) {
      await coordinator.dispatch(const Next());
      await settle();
    }
    expect(pages, 2);
    expect(
      coordinator.snapshot.currentEntry!.track.ref.identityKey,
      'yt:fresh1',
    );
    expect(prepared, ['yt:a', 'yt:b', 'yt:c', 'yt:d', 'yt:fresh1']);
    expect(
      coordinator.snapshot.entries.last.context.recommendationGenerationId,
      'generation-1',
    );
    await wave.dispose();
    await coordinator.dispose();
  });
  test('explicit Apply can rerank old upcoming songs while excluding audible identity', () async {
    final authority = await mediaAuthority(Uri.parse('https://report.test'));
    final fence = authority.requireFence();
    final transport = ControlledTransport();
    transport.respond = (r) async => ApiResponse(
      200,
      waveFeed(
        r.query['mode'] == 'new' ? ['a', 'b', 'fresh'] : ['a', 'b', 'c', 'd'],
        cursor: r.query['mode'] == 'new' ? null : 71,
      ),
    );
    final controller = ReportingController();
    final wave = WaveContinuation(
      controller: controller,
      repository: RecommendationRepository(transport: transport),
      authority: authority,
    );
    await wave.start(const WaveSelection(), fence);
    await wave.retune(const WaveSelection(mode: WaveMode.newMusic));
    expect(controller.snapshot.entries.map((e) => e.track.ref.identityKey), [
      'yt:b',
      'yt:fresh',
    ]);
    expect(transport.requests.last.query['exclude'], 'a');
    await wave.dispose();
    await controller.dispose();
  });
  test(
    'latest Apply wins while preceding replacement waits for media prepare',
    () async {
      final authority = await mediaAuthority(Uri.parse('https://report.test'));
      final fence = authority.requireFence();
      final transport = ControlledTransport();
      transport.respond = (r) async => ApiResponse(
        200,
        r.query['mode'] == 'familiar'
            ? {
                'shelves': {
                  'listenAgain': [waveDto('latest')],
                  'quickPicks': [],
                  'discovery': [],
                },
                'generationId': 'latest',
              }
            : waveFeed(
                r.query['mode'] == 'new' ? ['old-new'] : ['a', 'b', 'c', 'd'],
                cursor: r.query['mode'] == 'new' ? null : 71,
              ),
      );
      final controller = ReportingController();
      final wave = WaveContinuation(
        controller: controller,
        repository: RecommendationRepository(transport: transport),
        authority: authority,
      );
      await wave.start(const WaveSelection(), fence);
      final gate = Completer<void>();
      controller.replaceGate = gate;
      final first = wave.retune(const WaveSelection(mode: WaveMode.newMusic));
      await settle();
      expect(
        controller.snapshot.entries.single.track.ref,
        const YoutubeTrackRef('old-new'),
      );
      await wave.retune(const WaveSelection(mode: WaveMode.familiar));
      gate.complete();
      await first;
      await settle();
      expect(
        controller.snapshot.entries.single.track.ref,
        const YoutubeTrackRef('latest'),
      );
      expect(wave.state.status, WaveStatus.exhausted);
      await wave.dispose();
      await controller.dispose();
    },
  );
  test('rapid Apply keeps latest selection despite reversed responses, without sheet lifecycle ownership', () async {
    final authority = await mediaAuthority(Uri.parse('https://report.test'));
    final fence = authority.requireFence();
    final transport = ControlledTransport();
    final old = Completer<ApiResponse>(), latest = Completer<ApiResponse>();
    transport.respond = (r) => r.query['mode'] == 'new'
        ? old.future
        : r.query['mode'] == 'familiar'
        ? latest.future
        : Future.value(
            ApiResponse(200, waveFeed(['a', 'b', 'c', 'd'], cursor: 71)),
          );
    final controller = ReportingController();
    final wave = WaveContinuation(
      controller: controller,
      repository: RecommendationRepository(transport: transport),
      authority: authority,
    );
    await wave.start(const WaveSelection(), fence);
    final current = controller.snapshot.currentEntryId;
    final first = wave.retune(const WaveSelection(mode: WaveMode.newMusic));
    final second = wave.retune(const WaveSelection(mode: WaveMode.familiar));
    expect(controller.snapshot.currentEntryId, current);
    latest.complete(
      ApiResponse(200, {
        'shelves': {
          'listenAgain': [waveDto('latest')],
          'quickPicks': [],
          'discovery': [],
        },
        'nextCursor': null,
        'generationId': 'latest-generation',
      }),
    );
    await second;
    old.complete(
      ApiResponse(200, waveFeed(['stale'], generation: 'stale-generation')),
    );
    await first;
    await settle();
    expect(
      controller.snapshot.entries.single.track.ref,
      const YoutubeTrackRef('latest'),
    );
    expect(wave.state.selection.mode, WaveMode.familiar);
    expect(
      controller.snapshot.entries.single.context.recommendationGenerationId,
      'latest-generation',
    );
    await wave.dispose();
    await controller.dispose();
  });
  test(
    'manual or Downloads replacement detaches and blocks late refill',
    () async {
      final authority = await mediaAuthority(Uri.parse('https://report.test'));
      final fence = authority.requireFence();
      final transport = ControlledTransport();
      final pending = Completer<ApiResponse>();
      var calls = 0;
      transport.respond = (_) => ++calls == 1
          ? Future.value(
              ApiResponse(200, waveFeed(['a', 'b', 'c'], cursor: 71)),
            )
          : pending.future;
      final controller = ReportingController();
      final wave = WaveContinuation(
        controller: controller,
        repository: RecommendationRepository(transport: transport),
        authority: authority,
      );
      await wave.start(const WaveSelection(), fence);
      await settle();
      await controller.dispatch(
        ReplaceQueue(
          controller.createEntries([
            waveTrack('manual'),
          ], const PlayContext(surface: PlaySurface.library)),
          fence: fence,
        ),
      );
      pending.complete(ApiResponse(200, waveFeed(['late'], cursor: 99)));
      await settle();
      expect(wave.state.status, WaveStatus.detached);
      expect(
        controller.snapshot.entries.single.track.ref,
        const YoutubeTrackRef('manual'),
      );
      await wave.dispose();
      await controller.dispose();
    },
  );
  test('owner A response cannot alter owner B queue or error state', () async {
    final authority = await mediaAuthority(Uri.parse('https://report.test'));
    final fence = authority.requireFence();
    final transport = ControlledTransport();
    final pending = Completer<ApiResponse>();
    transport.respond = (_) => pending.future;
    final controller = ReportingController();
    final wave = WaveContinuation(
      controller: controller,
      repository: RecommendationRepository(transport: transport),
      authority: authority,
    );
    final starting = wave.start(const WaveSelection(), fence);
    await settle();
    await authority.establish(
      OwnerKey(serverOrigin: fence.owner.serverOrigin, userId: 'B'),
      const TokenPair(accessToken: 'B', refreshToken: 'B-refresh'),
    );
    final ownerB = authority.requireFence();
    await controller.dispatch(
      ReplaceQueue(
        controller.createEntries([
          waveTrack('B'),
        ], const PlayContext(surface: PlaySurface.library)),
        fence: ownerB,
      ),
    );
    pending.complete(ApiResponse(200, waveFeed(['A'], cursor: 71)));
    await starting;
    expect(controller.snapshot.fence, ownerB);
    expect(
      controller.snapshot.entries.single.track.ref,
      const YoutubeTrackRef('B'),
    );
    expect(wave.state.status, WaveStatus.detached);
    await wave.dispose();
    await controller.dispose();
  });
  test(
    'provider outage is recoverable and does not spin as empty eligible pool',
    () async {
      final authority = await mediaAuthority(Uri.parse('https://report.test'));
      final transport = ControlledTransport()
        ..respond = (_) async => ApiResponse(
          200,
          waveFeed([], cursor: 71, reason: 'provider_unavailable'),
        );
      final controller = ReportingController();
      final wave = WaveContinuation(
        controller: controller,
        repository: RecommendationRepository(transport: transport),
        authority: authority,
      );
      await wave.start(const WaveSelection(), authority.requireFence());
      await settle();
      expect(wave.state.status, WaveStatus.error);
      expect(wave.state.failure!.retryable, true);
      expect(transport.requests.length, 1);
      await wave.retry();
      expect(transport.requests.length, 2);
      await wave.dispose();
      await controller.dispose();
    },
  );
  test('real ApiTransport retains native exact refs and ordered visible exposure only', () async {
    final authority = await mediaAuthority(Uri.parse('https://report.test'));
    final fence = authority.requireFence();
    final native = (jsonDecode(
      File('test/fixtures/home.json').readAsStringSync(),
    ) as Map).cast<String, Object?>();
    final seen = <ApiRequest>[];
    final transport = DartApiTransport(
      authority: authority,
      client: ScriptedJsonClient((request, token) async {
        expect(token, 'initial');
        seen.add(request);
        return ApiResponse(
          200,
          request.method == ApiMethod.get
              ? {
                  'shelves': {
                    'listenAgain': [],
                    'quickPicks': [],
                    'discovery': [native, waveDto('video')],
                  },
                  'generationId': 'native-generation',
                  'nextCursor': 711,
                }
              : {'recorded': 2},
        );
      }),
    );
    final repository = RecommendationRepository(transport: transport);
    final page = await repository.wave(
      const WaveSelection(),
      fence,
      sessionId: 'session-1',
    );
    expect(page.tracks.first.ref.identityKey, 'vk:-1_2');
    expect(page.tracks.first.ref, isA<NativeTrackRef>());
    expect(seen.length, 1);
    await repository.reportVisible(page.generationId!, [
      page.tracks[1],
      page.tracks[0],
    ], fence);
    expect(seen.last.body!['tracks'], [
      {'provider': 'youtube', 'providerTrackId': 'video'},
      {'provider': 'vk', 'providerTrackId': '-1_2'},
    ]);
    expect(seen.last.body!['generationId'], 'native-generation');
  });
  test('repository preserves server cursor and bounded bare YouTube exclusions; fetch is not impression', () async {
    final authority = await mediaAuthority(Uri.parse('https://report.test'));
    final fence = authority.requireFence();
    final transport = ControlledTransport()
      ..respond = (_) async =>
          ApiResponse(200, waveFeed(['fresh'], cursor: 731));
    final repository = RecommendationRepository(transport: transport);
    final page = await repository.wave(
      const WaveSelection(),
      fence,
      cursor: 29,
      exclusions: List.generate(90, (i) => YoutubeTrackRef('v$i')),
      sessionId: 'session-1',
      now: DateTime(2026, 10, 15, 13),
    );
    expect(page.nextCursor, 731);
    expect(transport.requests.single.query['cursor'], '29');
    final exclusions = transport.requests.single.query['exclude']!.split(',');
    expect(exclusions.length, 80);
    expect(exclusions.first, 'v10');
    expect(exclusions.last, 'v89');
    expect(transport.requests.single.query['surface'], 'wave');
    expect(transport.fences.single, fence);
  });
  test('25 ticks share one refill; UI absent; two empty pages stop without polling', () async {
    final authority = await mediaAuthority(Uri.parse('https://report.test'));
    final fence = authority.requireFence();
    final transport = ControlledTransport();
    final deferred = Completer<ApiResponse>();
    var calls = 0;
    transport.respond = (_) {
      calls++;
      return calls == 1
          ? Future.value(
              ApiResponse(200, waveFeed(['a', 'b', 'c'], cursor: 71)),
            )
          : calls == 2
          ? deferred.future
          : Future.value(ApiResponse(200, waveFeed([], cursor: 900)));
    };
    final controller = ReportingController();
    final wave = WaveContinuation(
      controller: controller,
      repository: RecommendationRepository(transport: transport),
      authority: authority,
      sessionId: () => 'session-1',
    );
    await wave.start(const WaveSelection(), fence);
    await settle();
    for (var i = 0; i < 25; i++) {
      controller.states.add(controller.snapshot);
    }
    await settle();
    expect(calls, 2);
    deferred.complete(ApiResponse(200, waveFeed([], cursor: 99)));
    await settle();
    expect(calls, 3);
    expect(wave.state.status, WaveStatus.exhausted);
    for (var i = 0; i < 25; i++) {
      controller.states.add(controller.snapshot);
    }
    await settle();
    expect(calls, 3);
    expect(transport.requests[1].query['cursor'], '71');
    expect(transport.requests[2].query['cursor'], '99');
    await wave.dispose();
    await controller.dispose();
  });
}
