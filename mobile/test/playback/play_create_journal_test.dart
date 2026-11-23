import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/app/server_capabilities.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/core/storage/owner_store.dart';
import 'package:soundspan/features/recommendations/recommendation_repository.dart';
import 'package:soundspan/playback/feedback_outbox.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/play_create_journal.dart';
import 'package:soundspan/playback/play_create_protocol.dart';
import 'package:soundspan/playback/playback_event_models.dart';

import '../support/collection_fixtures.dart';

/// Copy-on-commit fixture models OwnerStore atomicity and owner namespaces.
class JournalStore implements OwnerStore {
  final rows = <String, Map<String, Map<String, Object?>>>{};
  String? failNextRemove;
  Completer<void>? holdJournalRead;
  Completer<void>? journalReadEntered;
  Future<void> _tail = Future.value();
  @override
  Future<T> transaction<T>(
    SessionFence fence,
    Future<T> Function(OwnerTransaction) operation,
  ) {
    final result = _tail.then((_) async {
      final owner = '${fence.owner.serverOrigin}:${fence.owner.userId}';
      final values =
          jsonDecode(jsonEncode(rows[owner] ?? {})) as Map<String, Object?>;
      final copy = values.map(
        (key, value) => MapEntry(key, (value as Map).cast<String, Object?>()),
      );
      final result = await operation(JournalTx(this, copy));
      rows[owner] = copy;
      return result;
    });
    _tail = result.then<void>((_) {}, onError: (Object _) {});
    return result;
  }
}

class JournalTx implements OwnerTransaction {
  JournalTx(this.store, this.rows);
  final JournalStore store;
  final Map<String, Map<String, Object?>> rows;
  @override
  Future<Map<String, Object?>?> read(String namespace, String key) async =>
      _read(namespace, key);
  Future<Map<String, Object?>?> _read(String namespace, String key) async {
    final value = rows['$namespace/$key'];
    final held = store.holdJournalRead;
    if (namespace == PlayCreateJournal.namespace && held != null) {
      store.holdJournalRead = null;
      store.journalReadEntered?.complete();
      await held.future;
    }
    return value;
  }

  @override
  Future<void> write(
    String namespace,
    String key,
    Map<String, Object?> value,
  ) async {
    rows['$namespace/$key'] = OwnerRecord(key: key, value: value).value;
  }

  @override
  Future<void> remove(String namespace, String key) async {
    if (store.failNextRemove == '$namespace/$key') {
      store.failNextRemove = null;
      throw StateError('injected journal remove failure');
    }
    rows.remove('$namespace/$key');
  }

  @override
  Future<List<OwnerRecord>> list(
    String namespace, {
    String? afterKey,
    int limit = 100,
  }) async {
    final prefix = '$namespace/';
    final keys =
        rows.keys
            .where((key) => key.startsWith(prefix))
            .map((key) => key.substring(prefix.length))
            .where((key) => afterKey == null || key.compareTo(afterKey) > 0)
            .toList()
          ..sort();
    return keys
        .take(limit)
        .map((key) => OwnerRecord(key: key, value: rows['$prefix$key']!))
        .toList();
  }
}

Map<String, Object?> createFeatures(
  int now, {
  bool enabled = true,
  bool replay = true,
  int epoch = 7,
}) => {
  'discovery': true,
  'autoPlaylists': false,
  'federation': false,
  'playCreation': {
    'version': 1,
    'newCreationsEnabled': enabled,
    'replaySupported': replay,
    'createPath': '/api/plays/idempotent',
    'ownerHistoryEpoch': epoch,
    'serverNowMs': now,
    'replayWindowSeconds': 86400,
    'futureSkewSeconds': 300,
    'capabilityTtlSeconds': 300,
    'allowedSources': enabled ? ['youtube', 'vk', 'yandex'] : [],
  },
};
ApiResponse createAck(ApiRequest request, {String id = 'known-play'}) =>
    ApiResponse(200, {
      'id': id,
      'playCreation': {
        'version': 1,
        'clientPlaybackId': request.body!['clientPlaybackId'],
        'disposition': 'replayed',
        'replayExpiresAt': DateTime.fromMillisecondsSinceEpoch(
          PlayCreateKey.parse(request.body!['clientPlaybackId'] as String)
              .expiresAtMs,
          isUtc: true,
        ).toIso8601String(),
      },
    });
QueueEntry journalEntry(String id) => QueueEntry(
  entryId: id,
  track: Track(
    ref: YoutubeTrackRef(id),
    title: 'Title',
    artist: 'Artist',
    duration: const Duration(seconds: 200),
  ),
  context: const PlayContext(surface: PlaySurface.wave),
);
Future<void> journalSettle() async {
  for (var i = 0; i < 12; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

class JournalFixture {
  JournalFixture({JournalStore? owners}) : store = owners ?? JournalStore() {
    transport = CollectionTransport((request, _) async {
      if (request.method == ApiMethod.get) {
        await beforeFeatures?.call();
        return ApiResponse(
          200,
          createFeatures(
            serverNow,
            enabled: enabled,
            replay: replay,
            epoch: historyEpoch,
          ),
        );
      }
      if (request.method == ApiMethod.patch) {
        return const ApiResponse(200, {'success': true});
      }
      posts.add(request);
      return await send?.call(request) ?? createAck(request);
    });
    repository = RecommendationRepository(transport: transport);
    capabilities = ServerCapabilitiesRepository(
      transport: transport,
      store: store,
      authority: authority,
      fence: collectionFence,
      policy: const NetworkPolicy.online(),
      elapsed: () => elapsed,
    );
    outbox = FeedbackOutbox(
      store: store,
      repository: repository,
      authority: authority,
    );
    journal = makeJournal();
  }
  final JournalStore store;
  final authority = CollectionAuthority();
  final posts = <ApiRequest>[];
  int serverNow = 1700000000000, historyEpoch = 7;
  Duration elapsed = Duration.zero;
  bool enabled = true, replay = true;
  Future<ApiResponse> Function(ApiRequest)? send;
  Future<void> Function()? beforeFeatures;
  late final CollectionTransport transport;
  late final RecommendationRepository repository;
  late final ServerCapabilitiesRepository capabilities;
  late final FeedbackOutbox outbox;
  late PlayCreateJournal journal;
  PlayCreateJournal makeJournal() => PlayCreateJournal(
    store: store,
    repository: repository,
    outbox: outbox,
    capabilities: capabilities,
    authority: authority,
    fence: collectionFence,
    elapsed: () => elapsed,
  );
  Future<PlayCreateTicket> begin(String id) async {
    await capabilities.refresh();
    return journal.begin(
      journalEntry(id),
      capabilities.playCreationGrant!,
      playbackRunId: 'run_$id',
    );
  }

  void advance(int seconds) {
    elapsed += Duration(seconds: seconds);
    serverNow += seconds * 1000;
  }

  Future<Map<String, Object?>?> row(String key) => store.transaction(
    collectionFence,
    (tx) => tx.read(PlayCreateJournal.namespace, key),
  );
  Future<void> close() async {
    await journal.close();
    await capabilities.close();
    await authority.updates.close();
  }
}

void main() {
  for (final isFinal in [false, true]) {
    test(
      'a persisted v1 zero skipped ${isFinal ? 'final' : 'seed'} is ${isFinal ? 'retained' : 'unobserved'}',
      () async {
        final f = JournalFixture();
        try {
          final ticket = await f.begin('v1-seed');
          await ticket.created;
          await f.store.transaction(collectionFence, (tx) async {
            final row = await tx.read(
              PlayCreateJournal.namespace,
              ticket.key.value,
            );
            await tx.write(PlayCreateJournal.namespace, ticket.key.value, {
              ...row!,
              'totals': const PlayEngagement(
                listenedSeconds: 0,
                completionRatio: 0,
                outcome: PlayOutcome.skipped,
              ).toJson(),
              'final': isFinal,
            });
          });
          await f.journal.checkpoint(
            ticket,
            const PlayEngagement(
              listenedSeconds: 0,
              completionRatio: 0,
              outcome: PlayOutcome.failed,
            ),
            finalTotals: true,
          );
          await f.outbox.flush(collectionFence);
          final patch = f.transport.requests
              .where((r) => r.method == ApiMethod.patch)
              .single;
          expect(patch.body!['outcome'], isFinal ? 'skipped' : 'failed');
        } finally {
          await f.close();
        }
      },
    );
  }
  for (final boundary in ['ten sends', 'fifteen seconds', 'expired grant']) {
    test('late READY wakes after the bounded pass: $boundary', () async {
      final f = JournalFixture();
      final initial = boundary == 'fifteen seconds' ? 2 : 10;
      final first = Completer<void>();
      final last = Completer<void>();
      final entered = Completer<void>();
      f.send = (request) async {
        if (f.posts.length == 1) await first.future;
        if (f.posts.length == initial) {
          entered.complete();
          await last.future;
        }
        return createAck(
          request,
          id: 'play-${request.body!['youtubeVideoId']}',
        );
      };
      try {
        await f.capabilities.refresh();
        for (var i = 0; i < initial; i++) {
          final ticket = f.journal.begin(
            journalEntry('bounded-$i'),
            f.capabilities.playCreationGrant!,
            playbackRunId: 'bounded_$i',
          );
          await ticket.persisted;
        }
        final draining = f.journal.flush(refresh: false);
        first.complete();
        await entered.future;
        final late = f.journal.begin(
          journalEntry('late-bounded'),
          f.capabilities.playCreationGrant!,
          playbackRunId: 'late_bounded',
        );
        await late.persisted;
        await journalSettle();
        if (boundary == 'fifteen seconds') f.advance(16);
        if (boundary == 'expired grant') f.advance(301);
        last.complete();
        await draining;
        expect(
          f.posts.length,
          initial,
          reason: 'new work must not exceed the current pass budget',
        );
        expect((await f.row(late.key.value))!['state'], 'ready');
        await Future<void>.delayed(const Duration(milliseconds: 1250));
        expect(
          f.posts.length,
          initial + 1,
          reason: 'durably accepted work needs its own bounded wake',
        );
        expect(await late.created, 'play-late-bounded');
      } finally {
        if (!first.isCompleted) first.complete();
        if (!last.isCompleted) last.complete();
        await f.close();
      }
    });
  }
  test('late READY wakes after the hundred-seen bound without repeating terminal rows', () async {
    final f = JournalFixture();
    final first = Completer<void>();
    final second = Completer<void>();
    final entered = Completer<void>();
    f.send = (request) async {
      if (f.posts.length == 1) await first.future;
      if (f.posts.length == 2) {
        entered.complete();
        await second.future;
      }
      return createAck(request, id: 'play-${request.body!['youtubeVideoId']}');
    };
    try {
      final ticket = await f.begin('seen-first');
      await ticket.persisted;
      await journalSettle();
      await f.journal.checkpoint(
        ticket,
        const PlayEngagement(
          listenedSeconds: 200,
          completionRatio: 1,
          outcome: PlayOutcome.completed,
        ),
        finalTotals: true,
      );
      final template = (await f.row(ticket.key.value))!;
      await f.store.transaction(collectionFence, (tx) async {
        for (var i = 0; i < 98; i++) {
          final key = PlayCreateKey.issue(
            epoch: 7,
            issuedAtMs: f.serverNow - 1000,
            nonce: i.toRadixString(36).padLeft(32, 'A'),
          );
          await tx.write(PlayCreateJournal.namespace, key.value, {
            ...template,
            'state': 'terminal',
            'dto': null,
            'totals': null,
            'playId': null,
            'final': true,
          });
        }
      });
      final next = f.journal.begin(
        journalEntry('seen-second'),
        f.capabilities.playCreationGrant!,
        playbackRunId: 'seen_second',
      );
      await next.persisted;
      final draining = f.journal.flush(refresh: false);
      first.complete();
      await entered.future;
      final late = f.journal.begin(
        journalEntry('seen-late'),
        f.capabilities.playCreationGrant!,
        playbackRunId: 'seen_late',
      );
      await late.persisted;
      await journalSettle();
      second.complete();
      await draining;
      expect(f.posts.length, 2);
      expect((await f.row(late.key.value))!['state'], 'ready');
      await Future<void>.delayed(const Duration(milliseconds: 1250));
      expect(f.posts.length, 3);
      expect(await late.created, 'play-seen-late');
    } finally {
      if (!first.isCompleted) first.complete();
      if (!second.isCompleted) second.complete();
      await f.close();
    }
  });
  test(
    'a full terminal journal and feature callback do not start polling',
    () async {
      final f = JournalFixture()
        ..send = (_) async => const ApiResponse(410, null);
      try {
        final ticket = await f.begin('terminal-template');
        await ticket.persisted;
        await f.journal.flush(refresh: false);
        final template = (await f.row(ticket.key.value))!;
        await f.store.transaction(collectionFence, (tx) async {
          await tx.remove(PlayCreateJournal.namespace, ticket.key.value);
          for (var i = 0; i < 100; i++) {
            final key = PlayCreateKey.issue(
              epoch: 7,
              issuedAtMs: f.serverNow - 1000,
              nonce: i.toRadixString(36).padLeft(32, 'A'),
            );
            await tx.write(PlayCreateJournal.namespace, key.value, template);
          }
        });
        f.capabilities.onPlayCreationRefresh = () =>
            unawaited(f.journal.flush(refresh: false));
        await f.journal.recover();
        final reads = f.transport.requests
            .where((r) => r.method == ApiMethod.get)
            .length;
        await Future<void>.delayed(const Duration(milliseconds: 1250));
        expect(
          f.transport.requests.where((r) => r.method == ApiMethod.get).length,
          reads,
        );
        expect(f.posts.length, 1);
      } finally {
        await f.close();
      }
    },
  );
  test('online refresh during an OwnerStore wait pauses admission without terminalizing the run', () async {
    final f = JournalFixture();
    final held = f.store.holdJournalRead = Completer<void>();
    final entered = f.store.journalReadEntered = Completer<void>();
    try {
      final ticket = await f.begin('grant-race');
      await ticket.persisted;
      await entered.future;
      final refreshing = f.capabilities.refresh();
      await journalSettle();
      expect(f.capabilities.playCreationGrant, isNull);
      held.complete();
      await refreshing;
      await f.journal.flush(refresh: false);
      expect(
        (await f.row(ticket.key.value))!['state'],
        isNot('terminal'),
        reason: 'after fresh permission the valid flight may already have received its ACK',
      );
      await f.journal.recover();
      expect(await ticket.created, 'known-play');
      expect(f.posts.length, 1);
    } finally {
      if (!held.isCompleted) held.complete();
      await f.close();
    }
  });
  test(
    'a slow fresh capability read does not consume the first send admission',
    () async {
      final f = JournalFixture();
      f.send = (request) async {
        if (f.posts.length == 1) throw StateError('unknown');
        return createAck(request);
      };
      try {
        final ticket = await f.begin('slow-cap');
        await ticket.persisted;
        await f.journal.flush();
        await f.journal.close();
        f.journal = f.makeJournal();
        f.advance(1);
        f.beforeFeatures = () async {
          f.advance(16);
        };
        await f.journal.recover();
        expect(f.posts.length, 2);
      } finally {
        await f.close();
      }
    },
  );
  test(
    'work beyond the ten-send pass wakes once and does not strand a ready run',
    () async {
      final f = JournalFixture();
      final gate = Completer<void>();
      f.send = (request) async {
        if (f.posts.length == 1) await gate.future;
        return createAck(
          request,
          id: 'play-${request.body!['youtubeVideoId']}',
        );
      };
      try {
        await f.capabilities.refresh();
        for (var i = 0; i < 11; i++) {
          final ticket = f.journal.begin(
            journalEntry('batch-$i'),
            f.capabilities.playCreationGrant!,
            playbackRunId: 'batch_$i',
          );
          await ticket.persisted;
        }
        final pass = f.journal.flush(refresh: false);
        gate.complete();
        await pass;
        expect(f.posts.length, 10);
        await Future<void>.delayed(const Duration(milliseconds: 1100));
        expect(f.posts.length, 11);
      } finally {
        if (!gate.isCompleted) gate.complete();
        await f.close();
      }
    },
  );
  test('empty startup journal does not add capability network traffic to playback preparation', () async {
    final f = JournalFixture();
    try {
      await f.journal.recover();
      expect(f.transport.requests, isEmpty);
    } finally {
      await f.close();
    }
  });
  test('one restart wake purges an expired terminal row using its fresh server clock', () async {
    final f = JournalFixture()
      ..send = (_) async => const ApiResponse(410, null);
    try {
      final ticket = await f.begin('terminal-expiry');
      await ticket.persisted;
      await f.journal.flush();
      await f.journal.close();
      f.journal = f.makeJournal();
      f.advance(86400);
      await f.journal.recover();
      expect(await f.row(ticket.key.value), isNull);
      expect(f.posts.length, 1);
    } finally {
      await f.close();
    }
  });
  test('lost ACK recovers the same frozen key and hands final totals off atomically', () async {
    final f = JournalFixture();
    final committed = <String>{};
    f.send = (request) async {
      final key = request.body!['clientPlaybackId'] as String;
      committed.add(key);
      expect(
        await f.row(key),
        isNotNull,
        reason: 'journal and operation reservation must precede wire handoff',
      );
      if (f.posts.length == 1) throw StateError('accepted but ACK lost');
      return createAck(request);
    };
    try {
      final ticket = await f.begin('video');
      await ticket.persisted;
      await f.journal.flush();
      await f.journal.checkpoint(
        ticket,
        const PlayEngagement(
          listenedSeconds: 200,
          completionRatio: 1,
          outcome: PlayOutcome.completed,
        ),
        finalTotals: true,
      );
      await f.journal.close();
      f.journal = f.makeJournal();
      f.advance(1);
      await f.journal.recover();
      expect(f.posts.length, 2);
      expect(committed.length, 1);
      expect(f.posts[1].body, f.posts[0].body);
      expect(await f.row(ticket.key.value), isNull);
      final patch = await f.store.transaction(
        collectionFence,
        (tx) => tx.read(FeedbackOutbox.namespace, 'known-play'),
      );
      expect(patch, containsPair('listenedSeconds', 200));
      expect(patch, containsPair('outcome', 'completed'));
    } finally {
      await f.close();
    }
  });
  test('ACK before final persists known ID; failed atomic handoff can recover without create permission', () async {
    final f = JournalFixture();
    try {
      final ticket = await f.begin('known');
      expect(await ticket.created, 'known-play');
      expect((await f.row(ticket.key.value))!['state'], 'known');
      f.store.failNextRemove =
          '${PlayCreateJournal.namespace}/${ticket.key.value}';
      await expectLater(
        f.journal.checkpoint(
          ticket,
          const PlayEngagement(
            listenedSeconds: 200,
            completionRatio: 1,
            outcome: PlayOutcome.completed,
          ),
          finalTotals: true,
        ),
        throwsStateError,
      );
      expect(await f.row(ticket.key.value), isNotNull);
      expect(
        (await f.row(ticket.key.value))!['totals'],
        containsPair('listenedSeconds', 200),
      );
      expect(
        await f.store.transaction(
          collectionFence,
          (tx) => tx.read(FeedbackOutbox.namespace, 'known-play'),
        ),
        isNull,
      );
      f.enabled = false;
      f.replay = false;
      f.advance(90000);
      await f.journal.close();
      f.journal = f.makeJournal();
      await f.journal.recover();
      expect(f.posts.length, 1);
      expect(await f.row(ticket.key.value), isNull);
      expect(
        await f.store.transaction(
          collectionFence,
          (tx) => tx.read(FeedbackOutbox.namespace, 'known-play'),
        ),
        isNotNull,
      );
    } finally {
      await f.close();
    }
  });
  test('known live key expiry hands off totals and later checkpoints still use the known PATCH ID', () async {
    final f = JournalFixture();
    try {
      final ticket = await f.begin('long');
      await ticket.created;
      f.advance(90000);
      await f.journal.recover();
      expect(await f.row(ticket.key.value), isNull);
      await f.journal.checkpoint(
        ticket,
        const PlayEngagement(
          listenedSeconds: 200,
          completionRatio: 1,
          outcome: PlayOutcome.completed,
        ),
        finalTotals: true,
      );
      final row = await f.store.transaction(
        collectionFence,
        (tx) => tx.read(FeedbackOutbox.namespace, 'known-play'),
      );
      expect(row, containsPair('listenedSeconds', 200));
      expect(f.posts.length, 1);
    } finally {
      await f.close();
    }
  });
  test('corrupt journal fields are purged without replaying a stored arbitrary payload', () async {
    final f = JournalFixture()..send = (_) async => throw StateError('unknown');
    try {
      final ticket = await f.begin('corrupt');
      await ticket.persisted;
      await f.journal.flush();
      await f.store.transaction(collectionFence, (tx) async {
        final row = await tx.read(
          PlayCreateJournal.namespace,
          ticket.key.value,
        );
        await tx.write(PlayCreateJournal.namespace, ticket.key.value, {
          ...row!,
          'unexpected': {'mediaUrl': 'private'},
        });
      });
      await f.journal.close();
      f.journal = f.makeJournal();
      f.advance(1);
      await f.journal.recover();
      expect(f.posts.length, 1);
      expect(await f.row(ticket.key.value), isNull);
    } finally {
      await f.close();
    }
  });
  for (final status in [400, 401, 403, 404, 409, 410]) {
    test(
      'terminal create status$status never falls back or sends another key',
      () async {
        final f = JournalFixture()
          ..send = (_) async => ApiResponse(status, null);
        try {
          final ticket = await f.begin('terminal');
          await ticket.persisted;
          await f.journal.flush();
          await f.journal.recover();
          expect(f.posts.length, 1);
          final row = await f.row(ticket.key.value);
          expect(row == null || row['state'] == 'terminal', isTrue);
          expect(row?['dto'], isNull);
        } finally {
          await f.close();
        }
      },
    );
  }
  test(
    'durable503 holdoff and three-operation budget survive journal restart',
    () async {
      final f = JournalFixture()
        ..send = (_) async =>
            const ApiResponse(503, null, retryAfter: Duration(seconds: 30));
      try {
        final ticket = await f.begin('hold');
        await ticket.persisted;
        await f.journal.flush();
        await f.journal.close();
        f.journal = f.makeJournal();
        for (var i = 0; i < 10; i++) {
          await f.journal.recover();
        }
        expect(f.posts.length, 1);
        f.advance(30);
        await f.journal.recover();
        expect(f.posts.length, 2);
        f.advance(30);
        await f.journal.recover();
        expect(f.posts.length, 3);
        f.advance(30);
        await f.journal.recover();
        expect(f.posts.length, 3);
        expect(
          f.posts.map((request) => request.body!['clientPlaybackId']).toSet(),
          {ticket.key.value},
        );
      } finally {
        await f.close();
      }
    },
  );
  test('replay-only rollback recovers an already dispatched key but admits no new run', () async {
    final f = JournalFixture();
    f.send = (request) async {
      if (f.posts.length == 1) throw StateError('unknown ACK');
      return createAck(request);
    };
    try {
      final ticket = await f.begin('rollback');
      await ticket.persisted;
      await f.journal.flush();
      await f.journal.close();
      f.journal = f.makeJournal();
      f.enabled = false;
      f.advance(1);
      await f.journal.recover();
      expect(f.posts.length, 2);
      expect(f.posts.last.body, f.posts.first.body);
      expect(
        () => f.journal.begin(
          journalEntry('new'),
          f.capabilities.playCreationGrant!,
          playbackRunId: 'new',
        ),
        throwsA(isA<Exception>()),
      );
    } finally {
      await f.close();
    }
  });
  for (final reason in ['ten-minute age', 'key expiry', 'history epoch']) {
    test(
      '$reason stops unknown replay without changing key or using legacy',
      () async {
        final f = JournalFixture()
          ..send = (_) async => throw StateError('unknown');
        try {
          final ticket = await f.begin('expired');
          await ticket.persisted;
          await f.journal.flush();
          if (reason == 'history epoch') {
            f.historyEpoch++;
            f.advance(1);
          } else {
            f.advance(reason == 'ten-minute age' ? 600 : 86400);
          }
          await f.journal.recover();
          expect(f.posts.length, 1);
          final retained = await f.row(ticket.key.value);
          if (reason == 'key expiry') {
            expect(retained, isNull);
          } else {
            expect(retained!['dto'], isNull);
          }
          expect(f.posts.single.path, '/api/plays/idempotent');
        } finally {
          await f.close();
        }
      },
    );
  }
  test(
    'server-time rollback cannot shorten a persisted Retry-After after restart',
    () async {
      final f = JournalFixture()
        ..send = (_) async =>
            const ApiResponse(429, null, retryAfter: Duration(seconds: 30));
      try {
        final ticket = await f.begin('clock');
        await ticket.persisted;
        await f.journal.flush();
        await f.journal.close();
        f.journal = f.makeJournal();
        f.serverNow -= 60000;
        await f.journal.recover();
        expect(f.posts.length, 1);
        f.serverNow += 90000;
        f.elapsed += const Duration(seconds: 30);
        await f.journal.recover();
        expect(f.posts.length, 2);
      } finally {
        await f.close();
      }
    },
  );
  test(
    'owner journal capacity rejects a new reservation before network handoff',
    () async {
      final f = JournalFixture();
      final gate = Completer<ApiResponse>();
      f.send = (_) => gate.future;
      try {
        await f.capabilities.refresh();
        for (var i = 0; i < 100; i++) {
          final ticket = f.journal.begin(
            journalEntry('row-$i'),
            f.capabilities.playCreationGrant!,
            playbackRunId: 'run_$i',
          );
          await ticket.persisted;
        }
        final rejected = f.journal.begin(
          journalEntry('overflow'),
          f.capabilities.playCreationGrant!,
          playbackRunId: 'overflow',
        );
        await expectLater(rejected.persisted, throwsA(isA<Exception>()));
        final rows = await f.store.transaction(
          collectionFence,
          (tx) => tx.list(PlayCreateJournal.namespace, limit: 100),
        );
        expect(rows.length, 100);
        expect(f.posts.length, 1);
      } finally {
        if (!gate.isCompleted) gate.complete(createAck(f.posts.first));
        await f.close();
      }
    },
  );
}
