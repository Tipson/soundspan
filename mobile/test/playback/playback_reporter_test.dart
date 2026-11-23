import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/core/session/credential_vault.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/features/recommendations/recommendation_repository.dart';
import 'package:soundspan/playback/feedback_outbox.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/playback_reporter.dart';

import '../support/media_fixtures.dart';
import '../support/wave_reporting_fixtures.dart';

void main() {
  test('final completed200 automatically drains after an in-flight meaningful60 PATCH', () async {
    final authority = await mediaAuthority(Uri.parse('https://report.test'));
    final fence = authority.requireFence();
    final transport = ControlledTransport();
    final firstPatch = Completer<ApiResponse>();
    var patches = 0;
    transport.respond = (request) async {
      if (request.method == ApiMethod.patch && ++patches == 1) {
        return firstPatch.future;
      }
      return const ApiResponse(200, {'id': 'play-1'});
    };
    final repository = RecommendationRepository(transport: transport);
    final store = ReportingStore();
    final outbox = FeedbackOutbox(
      store: store,
      repository: repository,
      authority: authority,
    );
    final controller = ReportingController();
    final reporter = PlaybackReporter(
      controller: controller,
      repository: repository,
      outbox: outbox,
      authority: authority,
    );
    addTearDown(() async {
      await reporter.dispose();
      await controller.dispose();
    });
    controller.emit(reportSnapshot(fence), seconds: 0);
    await settle();
    controller.emit(reportSnapshot(fence, position: 60), seconds: 60);
    await settle();
    expect(patches, 1);
    controller.emit(
      reportSnapshot(
        fence,
        position: 200,
        audible: false,
        processing: PlaybackProcessing.completed,
      ),
      kind: PlaybackEventKind.completed,
      seconds: 200,
    );
    await settle();
    firstPatch.complete(const ApiResponse(200, {'success': true}));
    await settle();
    final sent = transport.requests
        .where((request) => request.method == ApiMethod.patch)
        .toList();
    expect(sent.length, 2);
    final createdRun = transport.requests
        .firstWhere((r) => r.path == '/api/plays')
        .playbackRunId;
    expect(createdRun, matches(RegExp(r'^[A-Za-z0-9_-]{1,64}$')));
    expect(sent.map((r) => r.playbackRunId), everyElement(createdRun));
    expect(sent.last.body, {
      'listenedSeconds': 200,
      'completionRatio': 1,
      'outcome': 'completed',
    });
    expect(
      transport.requests
          .where((request) => request.method == ApiMethod.post)
          .length,
      1,
    );
    final durable = await store.transaction(
      fence,
      (tx) => tx.read(FeedbackOutbox.namespace, 'play-1'),
    );
    expect(durable!['ackVersion'], durable['version']);
  });
  test('restored metadata remains unreported until a fresh audible resume generation', () async {
    final authority = await mediaAuthority(Uri.parse('https://report.test'));
    final fence = authority.requireFence();
    final transport = ControlledTransport();
    final repository = RecommendationRepository(transport: transport);
    final controller = ReportingController();
    final reporter = PlaybackReporter(
      controller: controller,
      repository: repository,
      outbox: FeedbackOutbox(
        store: ReportingStore(),
        repository: repository,
        authority: authority,
      ),
      authority: authority,
    );
    controller.emit(
      reportSnapshot(
        fence,
        position: 75,
        audible: false,
        processing: PlaybackProcessing.idle,
      ),
      kind: PlaybackEventKind.transition,
      seconds: 0,
    );
    await settle();
    expect(transport.requests, isEmpty);
    controller.emit(
      reportSnapshot(fence, position: 75, generation: 2),
      seconds: 1,
    );
    await settle();
    expect(
      transport.requests.where((r) => r.method == ApiMethod.post).length,
      1,
    );
    expect(reporter.state.listenedSeconds, 0);
    await reporter.dispose();
    await controller.dispose();
  });
  test('sparse audible background progress counts thirty seconds bounded by monotonic elapsed', () async {
    final authority = await mediaAuthority(Uri.parse('https://report.test'));
    final fence = authority.requireFence();
    final transport = ControlledTransport();
    final repository = RecommendationRepository(transport: transport);
    final controller = ReportingController();
    final reporter = PlaybackReporter(
      controller: controller,
      repository: repository,
      outbox: FeedbackOutbox(
        store: ReportingStore(),
        repository: repository,
        authority: authority,
      ),
      authority: authority,
    );
    controller.emit(reportSnapshot(fence), seconds: 0);
    controller.emit(reportSnapshot(fence, position: 30), seconds: 30);
    expect(reporter.state.listenedSeconds, 30);
    controller.emit(
      reportSnapshot(fence, position: 130),
      kind: PlaybackEventKind.seek,
      seconds: 30,
    );
    expect(reporter.state.listenedSeconds, 30);
    await reporter.dispose();
    await controller.dispose();
  });
  test('completed run cannot be resurrected by stale audible event after later completion', () async {
    final authority = await mediaAuthority(Uri.parse('https://report.test'));
    final fence = authority.requireFence();
    final transport = ControlledTransport();
    var starts = 0;
    transport.respond = (r) async => ApiResponse(
      200,
      r.method == ApiMethod.post
          ? {'id': 'play-${++starts}'}
          : {'success': true},
    );
    final repository = RecommendationRepository(transport: transport);
    final controller = ReportingController();
    final reporter = PlaybackReporter(
      controller: controller,
      repository: repository,
      outbox: FeedbackOutbox(
        store: ReportingStore(),
        repository: repository,
        authority: authority,
      ),
      authority: authority,
    );
    for (var g = 1; g <= 2; g++) {
      controller.emit(reportSnapshot(fence, generation: g), seconds: g * 10);
      await settle();
      controller.emit(
        reportSnapshot(
          fence,
          generation: g,
          audible: false,
          processing: PlaybackProcessing.completed,
        ),
        kind: PlaybackEventKind.completed,
        seconds: g * 10,
      );
      await settle();
    }
    controller.emit(reportSnapshot(fence, generation: 1), seconds: 10);
    await settle();
    expect(starts, 2);
    await reporter.dispose();
    await controller.dispose();
  });
  test('YouTube missing album uses existing Single metadata convention', () {
    final body = playStartBody(
      const QueueEntry(
        entryId: 'yt',
        track: Track(
          ref: YoutubeTrackRef('video'),
          title: ' Title ',
          artist: ' Artist ',
        ),
        context: PlayContext(surface: PlaySurface.search),
      ),
    );
    expect(body['album'], 'Single');
    expect(body['title'], 'Title');
    expect(body['artist'], 'Artist');
  });
  test(
    'early unfinished play is not prematurely promoted by periodic PATCH',
    () async {
      final authority = await mediaAuthority(Uri.parse('https://report.test'));
      final fence = authority.requireFence();
      final transport = ControlledTransport();
      final repository = RecommendationRepository(transport: transport);
      final controller = ReportingController();
      final reporter = PlaybackReporter(
        controller: controller,
        repository: repository,
        outbox: FeedbackOutbox(
          store: ReportingStore(),
          repository: repository,
          authority: authority,
        ),
        authority: authority,
      );
      controller.emit(reportSnapshot(fence), seconds: 0);
      await settle();
      for (var i = 1; i <= 30; i++) {
        controller.emit(reportSnapshot(fence, position: i), seconds: i);
      }
      await settle();
      controller.emit(
        reportSnapshot(fence, id: 'next', generation: 2),
        kind: PlaybackEventKind.transition,
        seconds: 30,
      );
      await settle();
      expect(
        transport.requests
            .where((r) => r.method == ApiMethod.patch)
            .last
            .body!['outcome'],
        'skipped',
      );
      await reporter.dispose();
      await controller.dispose();
    },
  );
  test('repeat-one has distinct runs and ignores duplicate completion from prior generation', () async {
    final authority = await mediaAuthority(Uri.parse('https://report.test'));
    final fence = authority.requireFence();
    final transport = ControlledTransport();
    var starts = 0;
    transport.respond = (r) async => ApiResponse(
      200,
      r.method == ApiMethod.post
          ? {'id': 'play-${++starts}'}
          : {'success': true},
    );
    final repository = RecommendationRepository(transport: transport);
    final controller = ReportingController();
    final reporter = PlaybackReporter(
      controller: controller,
      repository: repository,
      outbox: FeedbackOutbox(
        store: ReportingStore(),
        repository: repository,
        authority: authority,
      ),
      authority: authority,
    );
    for (var generation = 1; generation <= 2; generation++) {
      final offset = (generation - 1) * 20;
      controller.emit(
        reportSnapshot(fence, generation: generation),
        seconds: offset,
      );
      await settle();
      if (generation == 2) {
        controller.eventController.add(
          PlaybackEvent(
            kind: PlaybackEventKind.completed,
            snapshot: reportSnapshot(
              fence,
              generation: 1,
              position: 20,
              audible: false,
              processing: PlaybackProcessing.completed,
            ),
            elapsed: const Duration(seconds: 20),
          ),
        );
      }
      controller.emit(
        reportSnapshot(fence, generation: generation, position: 10),
        seconds: offset + 10,
      );
      controller.emit(
        reportSnapshot(
          fence,
          generation: generation,
          position: 20,
          audible: false,
          processing: PlaybackProcessing.completed,
        ),
        kind: PlaybackEventKind.completed,
        seconds: offset + 20,
      );
      await settle();
    }
    expect(starts, 2);
    final patches = transport.requests
        .where((r) => r.method == ApiMethod.patch)
        .toList();
    expect(patches.length, 2);
    expect(
      patches.every(
        (r) =>
            r.body!['outcome'] == 'completed' &&
            r.body!['listenedSeconds'] == 20,
      ),
      true,
    );
    await reporter.dispose();
    await controller.dispose();
  });
  test('native and library play bodies use exact source snapshots without video substitution', () async {
    final authority = await mediaAuthority(Uri.parse('https://report.test'));
    final fence = authority.requireFence();
    final transport = ControlledTransport();
    final repository = RecommendationRepository(transport: transport);
    final native = QueueEntry(
      entryId: 'native',
      track: Track(ref: recordingRef, title: 'native', artist: 'Artist'),
      context: const PlayContext(
        surface: PlaySurface.wave,
        waveMode: WaveMode.newMusic,
        recommendationGenerationId: 'gen',
        recommendationSessionId: 'session',
      ),
    );
    await repository.startPlay(native, fence);
    expect(transport.requests.single.body, {
      'musicSourceRecording': recordingRef.recording.toJson(),
      'playContext': 'wave',
      'waveMode': 'new',
      'recommendationGenerationId': 'gen',
      'recommendationSessionId': 'session',
    });
    await repository.startPlay(
      const QueueEntry(
        entryId: 'local',
        track: Track(
          ref: LibraryTrackRef('db-id'),
          title: 'Local',
          artist: 'Artist',
        ),
        context: PlayContext(surface: PlaySurface.library),
      ),
      fence,
    );
    expect(transport.requests.last.body, {
      'trackId': 'db-id',
      'playContext': 'library',
    });
  });
  test('explicit offline playback never creates a server play', () async {
    final authority = await mediaAuthority(Uri.parse('https://report.test'));
    final fence = authority.requireFence();
    final transport = ControlledTransport();
    final repository = RecommendationRepository(transport: transport);
    final controller = ReportingController();
    final reporter = PlaybackReporter(
      controller: controller,
      repository: repository,
      outbox: FeedbackOutbox(
        store: ReportingStore(),
        repository: repository,
        authority: authority,
      ),
      authority: authority,
      networkPolicy: const NetworkPolicy.offline(),
    );
    controller.emit(reportSnapshot(fence), seconds: 0);
    controller.emit(reportSnapshot(fence, position: 10), seconds: 10);
    await settle();
    expect(transport.requests, isEmpty);
    expect(reporter.state.createState, PlayCreateState.idle);
    await reporter.dispose();
    await controller.dispose();
  });
  test('buffering position movement cannot add audible seconds', () async {
    final authority = await mediaAuthority(Uri.parse('https://report.test'));
    final fence = authority.requireFence();
    final transport = ControlledTransport();
    final repository = RecommendationRepository(transport: transport);
    final controller = ReportingController();
    final reporter = PlaybackReporter(
      controller: controller,
      repository: repository,
      outbox: FeedbackOutbox(
        store: ReportingStore(),
        repository: repository,
        authority: authority,
      ),
      authority: authority,
    );
    controller.emit(reportSnapshot(fence), seconds: 0);
    controller.emit(reportSnapshot(fence, position: 10), seconds: 10);
    controller.emit(
      reportSnapshot(
        fence,
        position: 15,
        audible: false,
        processing: PlaybackProcessing.buffering,
      ),
      kind: PlaybackEventKind.buffering,
      seconds: 15,
    );
    expect(reporter.state.listenedSeconds, 10);
    await reporter.dispose();
    await controller.dispose();
  });
  test('late stale owner event cannot terminate active B run', () async {
    final authority = await mediaAuthority(Uri.parse('https://report.test'));
    final ownerA = authority.requireFence();
    final transport = ControlledTransport();
    final repository = RecommendationRepository(transport: transport);
    final controller = ReportingController();
    final reporter = PlaybackReporter(
      controller: controller,
      repository: repository,
      outbox: FeedbackOutbox(
        store: ReportingStore(),
        repository: repository,
        authority: authority,
      ),
      authority: authority,
    );
    await authority.establish(
      OwnerKey(serverOrigin: ownerA.owner.serverOrigin, userId: 'B'),
      const TokenPair(accessToken: 'B', refreshToken: 'B-refresh'),
    );
    final ownerB = authority.requireFence();
    controller.emit(reportSnapshot(ownerB, id: 'B'), seconds: 10);
    await settle();
    controller.eventController.add(
      PlaybackEvent(
        kind: PlaybackEventKind.position,
        snapshot: reportSnapshot(ownerA, id: 'A'),
        elapsed: const Duration(seconds: 5),
      ),
    );
    controller.emit(reportSnapshot(ownerB, id: 'B', position: 10), seconds: 20);
    await settle();
    expect(
      transport.requests.where((r) => r.method == ApiMethod.post).length,
      1,
    );
    expect(reporter.state.listenedSeconds, 10);
    await reporter.dispose();
    await controller.dispose();
  });
  test(
    'out of order duplicate progress cannot double count listened time',
    () async {
      final authority = await mediaAuthority(Uri.parse('https://report.test'));
      final fence = authority.requireFence();
      final transport = ControlledTransport();
      final repository = RecommendationRepository(transport: transport);
      final controller = ReportingController();
      final reporter = PlaybackReporter(
        controller: controller,
        repository: repository,
        outbox: FeedbackOutbox(
          store: ReportingStore(),
          repository: repository,
          authority: authority,
        ),
        authority: authority,
      );
      controller.emit(reportSnapshot(fence), seconds: 0);
      controller.emit(reportSnapshot(fence, position: 10), seconds: 10);
      controller.emit(reportSnapshot(fence, position: 5), seconds: 5);
      controller.emit(reportSnapshot(fence, position: 11), seconds: 11);
      await settle();
      expect(reporter.state.listenedSeconds, 11);
      await reporter.dispose();
      await controller.dispose();
    },
  );
  test('delayed POST after switch finalizes original run with original fence, never current metadata', () async {
    final authority = await mediaAuthority(Uri.parse('https://report.test'));
    final fence = authority.requireFence();
    final transport = ControlledTransport();
    final delayed = Completer<ApiResponse>();
    transport.respond = (request) async {
      if (request.path == '/api/plays' &&
          request.body!['youtubeVideoId'] == 'video-entry') {
        return delayed.future;
      }
      return const ApiResponse(200, {'id': 'next-play'});
    };
    final repository = RecommendationRepository(transport: transport);
    final controller = ReportingController();
    final reporter = PlaybackReporter(
      controller: controller,
      repository: repository,
      outbox: FeedbackOutbox(
        store: ReportingStore(),
        repository: repository,
        authority: authority,
      ),
      authority: authority,
    );
    controller.emit(reportSnapshot(fence), seconds: 0);
    controller.emit(reportSnapshot(fence, position: 10), seconds: 10);
    await settle();
    controller.emit(
      reportSnapshot(fence, id: 'next', generation: 2),
      kind: PlaybackEventKind.transition,
      seconds: 10,
    );
    await settle();
    delayed.complete(const ApiResponse(200, {'id': 'old-play'}));
    await settle();
    final patch = transport.requests
        .where((r) => r.path == '/api/plays/old-play/engagement')
        .single;
    expect(patch.body!['listenedSeconds'], 10);
    expect(transport.fences.every((f) => f == fence), true);
    await reporter.dispose();
    await controller.dispose();
  });
  test(
    'late POST response after logout never enters another owner outbox',
    () async {
      final authority = await mediaAuthority(Uri.parse('https://report.test'));
      final fence = authority.requireFence();
      final transport = ControlledTransport();
      final delayed = Completer<ApiResponse>();
      transport.respond = (_) => delayed.future;
      final repository = RecommendationRepository(transport: transport);
      final controller = ReportingController();
      final store = ReportingStore();
      final reporter = PlaybackReporter(
        controller: controller,
        repository: repository,
        outbox: FeedbackOutbox(
          store: store,
          repository: repository,
          authority: authority,
        ),
        authority: authority,
      );
      controller.emit(reportSnapshot(fence), seconds: 0);
      await settle();
      await authority.invalidate();
      delayed.complete(const ApiResponse(200, {'id': 'old-play'}));
      await settle();
      expect(transport.requests.length, 1);
      expect(store.records, isEmpty);
      await reporter.dispose();
      await controller.dispose();
    },
  );
  test('audible progression excludes seek jump and buffering; duplicate events create one play', () async {
    final authority = await mediaAuthority(Uri.parse('https://report.test'));
    final transport = ControlledTransport();
    final repository = RecommendationRepository(transport: transport);
    final controller = ReportingController();
    final outbox = FeedbackOutbox(
      store: ReportingStore(),
      repository: repository,
      authority: authority,
    );
    final reporter = PlaybackReporter(
      controller: controller,
      repository: repository,
      outbox: outbox,
      authority: authority,
    );
    final fence = authority.requireFence();
    controller.emit(reportSnapshot(fence), seconds: 0);
    controller.emit(reportSnapshot(fence, position: 10), seconds: 10);
    controller.emit(
      reportSnapshot(fence, position: 110),
      kind: PlaybackEventKind.seek,
      seconds: 10,
    );
    controller.emit(
      reportSnapshot(
        fence,
        position: 110,
        audible: false,
        processing: PlaybackProcessing.buffering,
      ),
      kind: PlaybackEventKind.buffering,
      seconds: 15,
    );
    controller.emit(
      reportSnapshot(
        fence,
        position: 110,
        audible: false,
        processing: PlaybackProcessing.failed,
      ),
      kind: PlaybackEventKind.failure,
      seconds: 15,
    );
    controller.emit(
      reportSnapshot(
        fence,
        position: 110,
        audible: false,
        processing: PlaybackProcessing.failed,
      ),
      kind: PlaybackEventKind.failure,
      seconds: 15,
    );
    await settle();
    await outbox.flush(fence);
    expect(transport.requests.where((r) => r.path == '/api/plays').length, 1);
    final patch = transport.requests
        .where((r) => r.method == ApiMethod.patch)
        .last;
    expect(patch.body!['listenedSeconds'], 10);
    expect(patch.body!['outcome'], 'failed');
    await reporter.dispose();
    await controller.dispose();
  });
  test('lost POST response is ambiguous and never retries on ticks', () async {
    final authority = await mediaAuthority(Uri.parse('https://report.test'));
    final transport = ControlledTransport()
      ..respond = (_) async => throw TimeoutException('lost response');
    final repository = RecommendationRepository(transport: transport);
    final controller = ReportingController();
    final reporter = PlaybackReporter(
      controller: controller,
      repository: repository,
      outbox: FeedbackOutbox(
        store: ReportingStore(),
        repository: repository,
        authority: authority,
      ),
      authority: authority,
    );
    final fence = authority.requireFence();
    for (var i = 0; i < 25; i++) {
      controller.emit(reportSnapshot(fence, position: i), seconds: i);
    }
    await settle();
    expect(transport.requests.length, 1);
    expect(reporter.state.createState, PlayCreateState.ambiguous);
    await reporter.dispose();
    await controller.dispose();
  });
}
