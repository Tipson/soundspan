import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/features/playlists/playlist_controller.dart';
import 'package:soundspan/features/playlists/playlist_repository.dart';
import 'package:soundspan/features/playlists/playlist_smart_shuffle.dart';
import 'package:soundspan/features/radio/radio_repository.dart';
import 'package:soundspan/playback/finite_queue_admission_api.dart';
import 'package:soundspan/playback/finite_queue_admission_coordinator.dart';
import 'package:soundspan/playback/playback_command.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/queue_coordinator.dart';
import 'package:soundspan/playback/queue_snapshot.dart';

import '../support/collection_fixtures.dart';
import '../playback/queue_coordinator_test.dart' show FakeEngine;
import '../playback/smart_shuffle_test.dart' show ownEntry;
import 'playlist_journey_test.dart' as fixture;

final class MutablePolicy implements NetworkPolicy {
  @override
  bool networkAllowed = true;
  @override
  void requireNetwork() {
    if (!networkAllowed) {
      throw const AppFailure(code: 'offline_mode', message: 'Offline');
    }
  }
}

final class HoldingAuthority extends CollectionAuthority {
  Completer<void>? next;
  final held = Completer<void>();
  @override
  Future<void> assertCurrent(fence) async {
    final gate = next;
    next = null;
    if (gate != null) {
      if (!held.isCompleted) held.complete();
      await gate.future;
    }
    await super.assertCurrent(fence);
  }
}

final class Harness {
  Harness({this.count = 7, this.denied = 'find-1', this.fullOwner = true}) {
    transport = CollectionTransport((request, _) async {
      if (request.path == '/api/playlists/p') {
        final full = request.query.isEmpty;
        final rows = List.generate(
          full ? count : min(count, 100),
          fixture.item,
        );
        final dto = fixture.detail(
          rows,
          total: count,
          cursor: !full && count > 100 ? 'next' : null,
          owner: full ? fullOwner : true,
        );
        if (full) dto.remove('pagination');
        return ApiResponse(200, dto);
      }
      if (request.path == '/api/library/radio') {
        if (!poolStarted.isCompleted) poolStarted.complete();
        if (poolGate != null) return poolGate!.future;
        if (outage) {
          throw const AppFailure(
            code: 'network_unavailable',
            message: 'Unavailable',
            retryable: true,
          );
        }
        return poolResponse();
      }
      if (request.path == '/api/personalized/queue-admission') {
        onAdmission?.call();
        if (!admissionStarted.isCompleted) admissionStarted.complete();
        if (admissionGate != null) await admissionGate!.future;
        final refs = request.body!['references'] as List;
        return ApiResponse(200, {
          'version': 1,
          'appliesTo': 'recommended_future',
          'decisions': [
            for (final raw in refs)
              {
                'source': (raw as Map)['source'],
                'id': raw['id'],
                'state': denyAll || raw['id'] == denied ? 'denied' : 'allowed',
              },
          ],
        });
      }
      return const ApiResponse(404, null);
    });
    playlists = PlaylistController(
      repository: PlaylistRepository(
        transport: transport,
        authority: authority,
        fence: collectionFence,
        networkPolicy: policy,
      ),
    );
    queue = QueueCoordinator(
      authority: authority,
      engine: engine,
      prepare: (entry, _) async {
        if ((holdEveryPreparation || entry.smartShuffle?.injected == true) &&
            prepareGate != null) {
          if (!prepareStarted.isCompleted) prepareStarted.complete();
          await prepareGate!.future;
        }
        return PreparedAudio(
          uri: Uri.parse('http://127.0.0.1/fixture'),
          revoke: () async {},
        );
      },
    );
    admission = FiniteQueueAdmissionCoordinator(
      api: FiniteQueueAdmissionApi(transport: transport),
      authority: authority,
      snapshot: () => queue.snapshot,
      snapshots: queue.snapshots,
    );
    queue.finiteAdmission = admission;
    smart = PlaylistSmartShuffle(
      playlist: playlists,
      playback: queue,
      admission: admission,
      radio: RadioRepository(
        transport: transport,
        authority: authority,
        fence: collectionFence,
        networkPolicy: policy,
      ),
      random: Random(42),
    );
  }
  final int count;
  String denied;
  final bool fullOwner;
  final authority = HoldingAuthority(),
      policy = MutablePolicy(),
      engine = FakeEngine();
  late final CollectionTransport transport;
  late final PlaylistController playlists;
  late final QueueCoordinator queue;
  late final FiniteQueueAdmissionCoordinator admission;
  late final PlaylistSmartShuffle smart;
  final poolStarted = Completer<void>(), admissionStarted = Completer<void>();
  Completer<ApiResponse>? poolGate;
  Completer<void>? admissionGate;
  bool outage = false;
  bool denyAll = false;
  bool holdEveryPreparation = false;
  void Function()? onAdmission;
  Completer<void>? prepareGate;
  final prepareStarted = Completer<void>();
  ApiResponse poolResponse() => ApiResponse(200, {
    'generationId': 'radio-generation',
    'tracks': [
      ...List.generate(
        7,
        (i) => {...fixture.item(i)['track'] as Map, 'id': 'find-$i'},
      ),
      {...fixture.item(0)['track'] as Map, 'id': 'find-0'},
      fixture.item(0)['track'],
    ],
  });
  Future<void> open() => playlists.open('p');
  Future<void> close() async {
    smart.dispose();
    playlists.dispose();
    await admission.close();
    await queue.dispose();
    await authority.updates.close();
  }
}

void main() {
  test(
    'cancel at last owner await preserves old injected source permit',
    () async {
      final h = Harness(denied: 'none');
      addTearDown(h.close);
      await h.open();
      await h.smart.toggle();
      final own = h.queue.snapshot.entries
          .where((entry) => entry.smartShuffle?.injected == false)
          .toList();
      await h.queue.dispatch(PlayEntry(own[2].entryId));
      h.prepareGate = Completer<void>();
      h.engine.emit(processing: PlaybackProcessing.completed);
      await h.prepareStarted.future.timeout(const Duration(seconds: 2));
      final current = h.queue.snapshot.currentEntryId;
      expect(h.queue.snapshot.currentEntry!.smartShuffle?.injected, true);
      await h.smart.toggle();
      final oldIds = h.queue.snapshot.effectiveOrder.toList();
      final lastOwner = Completer<void>();
      h.onAdmission = () => h.authority.next = lastOwner;
      final preparing = h.smart.toggle();
      await h.authority.held.future.timeout(const Duration(seconds: 2));
      h.smart.cancel();
      lastOwner.complete();
      h.prepareGate!.complete();
      await preparing.timeout(const Duration(seconds: 2));
      for (var i = 0; i < 20; i++) {
        await Future<void>.delayed(Duration.zero);
      }
      expect(
        h.queue.snapshot.effectiveOrder,
        oldIds,
        reason: 'A cancelled preparation must not attach its queue',
      );
      expect(h.queue.snapshot.currentEntryId, current);
      expect(
        h.queue.snapshot.processing,
        PlaybackProcessing.ready,
        reason:
            'Its rejected replacement must not revoke the old source permit',
      );
    },
  );
  test('manual Pause wins over preparation held at last owner await', () async {
    final h = Harness(denied: 'none');
    addTearDown(h.close);
    await h.open();
    await h.queue.dispatch(
      ReplaceQueue([ownEntry(99)], fence: collectionFence),
    );
    final oldIds = h.queue.snapshot.effectiveOrder.toList();
    final lastOwner = Completer<void>();
    h.onAdmission = () => h.authority.next = lastOwner;
    final preparing = h.smart.toggle();
    await h.authority.held.future.timeout(const Duration(seconds: 2));
    await h.queue.dispatch(const Pause());
    final plays = h.engine.plays;
    expect(h.queue.snapshot.playingIntent, false);
    lastOwner.complete();
    await preparing.timeout(const Duration(seconds: 2));
    for (var i = 0; i < 20; i++) {
      await Future<void>.delayed(Duration.zero);
    }
    expect(
      h.queue.snapshot.playingIntent,
      false,
      reason: 'Late preparation cannot restart audio after explicit Pause',
    );
    expect(h.queue.snapshot.effectiveOrder, oldIds);
    expect(h.engine.plays, plays);
  });
  test('queue attachment ends preparation UI before source load; disable stays authoritative', () async {
    final h = Harness(denied: 'none');
    addTearDown(h.close);
    await h.open();
    h.holdEveryPreparation = true;
    h.prepareGate = Completer<void>();
    final playing = h.smart.toggle();
    await h.prepareStarted.future;
    await Future<void>.delayed(Duration.zero);
    expect(h.smart.busy, false);
    expect(h.smart.active, true);
    await h.smart.toggle();
    h.prepareGate!.complete();
    await playing;
    expect(h.smart.active, false);
    expect(h.smart.notice, contains('выключены'));
    expect(h.queue.snapshot.entries, hasLength(7));
  });
  test(
    'preference mutation in final owner await cannot attach stale discoveries',
    () async {
      final h = Harness(denied: 'none');
      addTearDown(h.close);
      await h.open();
      final gate = Completer<void>();
      h.onAdmission = () => h.authority.next = gate;
      final pending = h.smart.toggle();
      await h.authority.held.future;
      final mutation = h.admission.beginMutation();
      h.admission.finishMutation(mutation);
      gate.complete();
      await pending;
      expect(h.queue.snapshot.entries, isEmpty);
    },
  );
  test('full snapshot GET + exact admitted pool preserve own duplicates and never write playlist', () async {
    final h = Harness();
    addTearDown(h.close);
    await h.open();
    final original = jsonEncode(
      h.playlists.state.detail!.items
          .map((item) => [item.id, item.sort, item.track.ref.identityKey])
          .toList(),
    );
    await h.smart.toggle();
    expect(h.smart.failure, isNull);
    expect(h.smart.active, true);
    final entries = h.queue.snapshot.entries,
        own = entries.where((entry) => !entry.smartShuffle!.injected).toList();
    expect(
      own.map((entry) => entry.smartShuffle!.occurrenceId),
      List.generate(7, (i) => 'own:item-$i'),
    );
    expect(
      own.map((entry) => entry.track.ref.identityKey).toSet(),
      hasLength(2),
    );
    expect(
      own.every((entry) => entry.context.recommendationScopeKey == null),
      true,
    );
    final injected = entries
        .where((entry) => entry.smartShuffle!.injected)
        .toList();
    expect(injected, hasLength(2));
    expect(
      injected.any((entry) => entry.track.ref.identityKey == 'library:find-1'),
      false,
    );
    expect(
      injected.every(
        (entry) =>
            entry.context.surface == PlaySurface.playlist &&
            entry.context.recommendationSessionId!.startsWith('smart-shuffle:'),
      ),
      true,
    );
    expect(
      h.transport.requests
          .where((request) => request.path == '/api/library/radio')
          .single
          .query,
      {'type': 'playlist', 'value': 'p', 'limit': '50'},
    );
    expect(
      h.transport.requests
          .where((request) => request.method != ApiMethod.get)
          .every(
            (request) => request.path == '/api/personalized/queue-admission',
          ),
      true,
    );
    expect(
      jsonEncode(
        h.playlists.state.detail!.items
            .map((item) => [item.id, item.sort, item.track.ref.identityKey])
            .toList(),
      ),
      original,
    );
    final before = h.queue.snapshot,
        loads = h.engine.loaded.length,
        stops = h.engine.stops;
    await h.smart.toggle();
    expect(h.smart.active, false);
    expect(h.smart.canUndo, true);
    expect(h.queue.snapshot.entries, hasLength(7));
    await h.smart.undo();
    expect(h.queue.snapshot.effectiveOrder, before.effectiveOrder);
    expect(h.engine.loaded.length, loads);
    expect(h.engine.stops, stops);
  });
  test('held pool loses to manual Play, Cancel and navigation', () async {
    for (final change in ['play', 'cancel', 'navigation']) {
      final h = Harness();
      try {
        await h.open();
        h.poolGate = Completer<ApiResponse>();
        var presented = true;
        final pending = h.smart.toggle(presented: () => presented);
        await h.poolStarted.future;
        if (change == 'play') {
          await h.queue.dispatch(
            ReplaceQueue([ownEntry(99)], fence: collectionFence, play: false),
          );
        }
        if (change == 'cancel') h.smart.cancel();
        if (change == 'navigation') presented = false;
        h.poolGate!.complete(h.poolResponse());
        await pending;
        expect(
          h.queue.snapshot.entries.map((entry) => entry.entryId),
          change == 'play' ? ['own-99'] : isEmpty,
        );
        expect(
          h.transport.requests.where(
            (request) => request.path == '/api/personalized/queue-admission',
          ),
          isEmpty,
        );
      } finally {
        await h.close();
      }
    }
  });
  test('late owner and preference mutation during admission cannot insert or revive queue', () async {
    for (final change in ['owner', 'preference']) {
      final h = Harness();
      try {
        await h.open();
        h.admissionGate = Completer<void>();
        final pending = h.smart.toggle();
        await h.admissionStarted.future;
        if (change == 'owner') {
          h.authority.switchOwner();
        } else {
          final ticket = h.admission.beginMutation();
          h.admission.finishMutation(ticket);
        }
        h.admissionGate!.complete();
        await pending;
        expect(h.queue.snapshot.entries, isEmpty);
      } finally {
        await h.close();
      }
    }
  });
  test(
    'outage and explicit offline fallback play only a complete owned snapshot',
    () async {
      for (final offline in [false, true]) {
        final h = Harness();
        try {
          await h.open();
          h.outage = true;
          h.policy.networkAllowed = !offline;
          final requests = h.transport.requests.length;
          await h.smart.toggle();
          expect(h.smart.failure, isNull);
          expect(h.smart.active, false);
          expect(h.queue.snapshot.entries, hasLength(7));
          expect(
            h.queue.snapshot.entries.every(
              (entry) => !entry.smartShuffle!.injected,
            ),
            true,
          );
          if (offline) expect(h.transport.requests.length, requests);
        } finally {
          await h.close();
        }
      }
    },
  );
  test(
    '2000/5000 own and nonowner reject before radio or queue mutation',
    () async {
      for (final config in [(2000, true), (5000, true), (7, false)]) {
        final h = Harness(count: config.$1, fullOwner: config.$2);
        try {
          await h.open();
          await h.smart.toggle();
          expect(h.queue.snapshot.entries, isEmpty);
          expect(
            h.transport.requests.where(
              (request) => request.path == '/api/library/radio',
            ),
            isEmpty,
          );
        } finally {
          await h.close();
        }
      }
    },
  );
  test('Undo rechecks bans and loses after manual edit', () async {
    final h = Harness(denied: 'none');
    addTearDown(h.close);
    await h.open();
    await h.smart.toggle();
    await h.smart.toggle();
    await h.queue.dispatch(SetShuffle(true));
    final changed = h.queue.snapshot.effectiveOrder;
    expect(h.smart.canUndo, false);
    await h.smart.undo();
    expect(h.queue.snapshot.effectiveOrder, changed);
  });
  test(
    'Undo tolerates retained ordinary history before the smart session',
    () async {
      final h = Harness(denied: 'none');
      addTearDown(h.close);
      await h.open();
      await h.smart.toggle();
      await h.queue.dispatch(Enqueue([ownEntry(99)], fence: collectionFence));
      final ids = h.queue.snapshot.entries
          .map((entry) => entry.entryId)
          .toList();
      await h.queue.dispatch(
        Reorder(['own-99', ...ids.where((id) => id != 'own-99')]),
      );
      final before = h.queue.snapshot.effectiveOrder;
      await h.smart.toggle();
      await h.smart.undo();
      expect(h.queue.snapshot.effectiveOrder, before);
    },
  );
  test(
    'Undo with every newly denied future stays own-only and mode off',
    () async {
      final h = Harness(denied: 'none');
      addTearDown(h.close);
      await h.open();
      await h.smart.toggle();
      await h.smart.toggle();
      h.denyAll = true;
      await h.smart.undo();
      expect(h.queue.snapshot.entries, hasLength(7));
      expect(h.smart.active, false);
      expect(
        h.queue.snapshot.entries.every(
          (entry) => entry.smartShuffle?.enabled == false,
        ),
        true,
      );
    },
  );
  test(
    'END held in admission survives disable; intervening Pause stays paused',
    () async {
      for (final paused in [false, true]) {
        final h = Harness(denied: 'none');
        try {
          await h.open();
          await h.smart.toggle();
          final own = h.queue.snapshot.entries
              .where((entry) => entry.smartShuffle?.injected == false)
              .toList();
          await h.queue.dispatch(PlayEntry(own[2].entryId));
          h.admissionGate = Completer<void>();
          final started = Completer<void>();
          h.onAdmission = () {
            if (!started.isCompleted) started.complete();
          };
          h.engine.emit(processing: PlaybackProcessing.completed);
          await started.future;
          await h.smart.toggle();
          if (paused) await h.queue.dispatch(const Pause());
          final plays = h.engine.plays;
          h.admissionGate!.complete();
          for (var i = 0; i < 15; i++) {
            await Future<void>.delayed(Duration.zero);
          }
          if (paused) {
            expect(h.queue.snapshot.playingIntent, false);
            expect(h.engine.plays, plays);
          } else {
            expect(h.queue.snapshot.currentEntryId, own[3].entryId);
            expect(h.queue.snapshot.processing, PlaybackProcessing.ready);
          }
        } finally {
          await h.close();
        }
      }
    },
  );
  test(
    'cancelled new preparation never revokes current injected source permit',
    () async {
      final h = Harness(denied: 'none');
      addTearDown(h.close);
      await h.open();
      await h.smart.toggle();
      final own = h.queue.snapshot.entries
          .where((entry) => entry.smartShuffle?.injected == false)
          .toList();
      await h.queue.dispatch(PlayEntry(own[2].entryId));
      h.prepareGate = Completer<void>();
      h.engine.emit(processing: PlaybackProcessing.completed);
      await h.prepareStarted.future;
      final current = h.queue.snapshot.currentEntryId;
      await h.smart.toggle();
      h.poolGate = Completer<ApiResponse>();
      final newPreparation = h.smart.toggle();
      for (var i = 0; i < 5; i++) {
        await Future<void>.delayed(Duration.zero);
      }
      h.smart.cancel();
      h.poolGate!.complete(h.poolResponse());
      h.prepareGate!.complete();
      await newPreparation;
      for (var i = 0; i < 15; i++) {
        await Future<void>.delayed(Duration.zero);
      }
      expect(h.queue.snapshot.currentEntryId, current);
      expect(h.queue.snapshot.processing, PlaybackProcessing.ready);
    },
  );
}
