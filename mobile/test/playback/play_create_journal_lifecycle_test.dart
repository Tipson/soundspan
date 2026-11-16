import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/playback_reporter.dart';
import 'package:soundspan/playback/play_create_journal.dart';
import 'package:soundspan/playback/feedback_outbox.dart';

import '../support/collection_fixtures.dart';
import '../support/wave_reporting_fixtures.dart';
import 'play_create_journal_test.dart';

import 'package:soundspan/app/server_capabilities.dart';
import 'package:soundspan/core/model/owner_key.dart';

void main() {
  for (final delayedAck in [false, true]) {
    test(
      'terminal provider failure remains failed with ${delayedAck ? 'delayed' : 'known'} create ACK',
      () async {
        final f = JournalFixture();
        final ack = Completer<ApiResponse>();
        if (delayedAck) f.send = (_) => ack.future;
        await f.capabilities.refresh();
        final controller = ReportingController();
        final reporter = PlaybackReporter(
          controller: controller,
          repository: f.repository,
          outbox: f.outbox,
          authority: f.authority,
          journal: f.journal,
        );
        try {
          controller.emit(reportSnapshot(collectionFence), seconds: 0);
          await journalSettle();
          expect(f.posts.single.path, '/api/plays/idempotent');
          controller.emit(
            reportSnapshot(collectionFence, position: 30),
            seconds: 30,
          );
          await journalSettle();
          expect(
            f.transport.requests.where((r) => r.method == ApiMethod.patch),
            isEmpty,
            reason: 'an unfinished early run is neither skipped nor failed',
          );
          controller.emit(
            reportSnapshot(
              collectionFence,
              position: 30,
              audible: false,
              processing: PlaybackProcessing.failed,
            ),
            kind: PlaybackEventKind.failure,
            seconds: 30,
          );
          await journalSettle();
          if (delayedAck) {
            expect(
              f.transport.requests.where((r) => r.method == ApiMethod.patch),
              isEmpty,
            );
            ack.complete(createAck(f.posts.single));
            await journalSettle();
          }
          await f.outbox.flush(collectionFence);
          final patch = f.transport.requests
              .where((r) => r.method == ApiMethod.patch)
              .single;
          expect(patch.path, '/api/plays/known-play/engagement');
          expect(patch.body, {
            'listenedSeconds': 30,
            'completionRatio': 0.15,
            'outcome': 'failed',
          });
          expect(f.posts.length, 1);
          expect(controller.commands, isEmpty);
        } finally {
          if (delayedAck && !ack.isCompleted && f.posts.isNotEmpty) {
            ack.complete(createAck(f.posts.single));
          }
          await reporter.dispose();
          await controller.dispose();
          await f.close();
        }
      },
    );
  }
  for (final boundary in ['restart', 'key expiry']) {
    test(
      'a known create without observations sends no engagement at $boundary',
      () async {
        final f = JournalFixture();
        try {
          final ticket = await f.begin('unobserved');
          expect(await ticket.created, 'known-play');
          if (boundary == 'restart') {
            await f.journal.close();
            f.journal = f.makeJournal();
          } else {
            f.advance(90000);
          }
          await f.journal.recover();
          await f.outbox.flush(collectionFence);
          expect(
            f.transport.requests.where((r) => r.method == ApiMethod.patch),
            isEmpty,
            reason: 'create recovery cannot invent a listening outcome',
          );
          expect(f.posts.length, 1);
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
          expect(patch.path, '/api/plays/known-play/engagement');
          expect(patch.body!['outcome'], 'failed');
          expect(f.posts.length, 1);
        } finally {
          await f.close();
        }
      },
    );
  }
  for (final outcome in ['skipped', 'meaningful', 'completed']) {
    test('journal reporting preserves a real $outcome observation', () async {
      final f = JournalFixture();
      await f.capabilities.refresh();
      final controller = ReportingController();
      final reporter = PlaybackReporter(
        controller: controller,
        repository: f.repository,
        outbox: f.outbox,
        authority: f.authority,
        journal: f.journal,
      );
      try {
        controller.emit(reportSnapshot(collectionFence), seconds: 0);
        await journalSettle();
        if (outcome == 'skipped') {
          controller.emit(QueueSnapshot(), kind: PlaybackEventKind.transition);
        } else if (outcome == 'meaningful') {
          controller.emit(
            reportSnapshot(collectionFence, position: 60),
            seconds: 60,
          );
          await journalSettle();
          controller.emit(
            reportSnapshot(
              collectionFence,
              position: 60,
              audible: false,
              processing: PlaybackProcessing.failed,
            ),
            kind: PlaybackEventKind.failure,
            seconds: 60,
          );
        } else {
          controller.emit(
            reportSnapshot(
              collectionFence,
              position: 200,
              audible: false,
              processing: PlaybackProcessing.completed,
            ),
            kind: PlaybackEventKind.completed,
            seconds: 200,
          );
        }
        await journalSettle();
        await f.outbox.flush(collectionFence);
        final patch = f.transport.requests
            .where((r) => r.method == ApiMethod.patch)
            .single;
        expect(patch.body, {
          'listenedSeconds': outcome == 'skipped'
              ? 0
              : (outcome == 'meaningful' ? 60 : 200),
          'completionRatio': outcome == 'skipped'
              ? 0
              : (outcome == 'meaningful' ? 0.3 : 1),
          'outcome': outcome,
        });
        expect(f.posts.length, 1);
      } finally {
        await reporter.dispose();
        await controller.dispose();
        await f.close();
      }
    });
  }
  test('new login of the same owner purges old-epoch unknown journal without sending it', () async {
    final f = JournalFixture()..send = (_) async => throw StateError('unknown');
    ServerCapabilitiesRepository? currentCaps;
    try {
      final ticket = await f.begin('old-login');
      await ticket.persisted;
      await f.journal.flush();
      await f.journal.close();
      final freshFence = SessionFence(
        owner: collectionOwner,
        epoch: collectionFence.epoch + 1,
      );
      f.authority.active = freshFence;
      currentCaps = ServerCapabilitiesRepository(
        transport: f.transport,
        store: f.store,
        authority: f.authority,
        fence: freshFence,
        policy: const NetworkPolicy.online(),
      );
      f.journal = PlayCreateJournal(
        store: f.store,
        repository: f.repository,
        outbox: f.outbox,
        capabilities: currentCaps,
        authority: f.authority,
        fence: freshFence,
      );
      await f.journal.recover();
      expect(f.posts.length, 1);
      expect(
        await f.store.transaction(
          freshFence,
          (tx) => tx.list(PlayCreateJournal.namespace),
        ),
        isEmpty,
      );
    } finally {
      await f.close();
      await currentCaps?.close();
    }
  });
  test('reporter disposal drains accepted known-run totals through the existing PATCH writer', () async {
    final f = JournalFixture();
    await f.capabilities.refresh();
    final controller = ReportingController();
    final reporter = PlaybackReporter(
      controller: controller,
      repository: f.repository,
      outbox: f.outbox,
      authority: f.authority,
      journal: f.journal,
    );
    try {
      controller.emit(reportSnapshot(collectionFence), seconds: 0);
      await journalSettle();
      controller.emit(
        reportSnapshot(collectionFence, position: 60),
        seconds: 60,
      );
      await journalSettle();
      final disposing = reporter.dispose();
      await f.journal.close();
      await disposing;
      final row = await f.store.transaction(
        collectionFence,
        (tx) => tx.read(FeedbackOutbox.namespace, 'known-play'),
      );
      expect(row, containsPair('listenedSeconds', 60));
      expect(row, containsPair('outcome', 'meaningful'));
    } finally {
      await reporter.dispose();
      await controller.dispose();
      await f.close();
    }
  });
  test(
    'keyed unknown response is visible while its durable holdoff waits',
    () async {
      final f = JournalFixture()
        ..send = (_) async => throw StateError('unknown ACK');
      await f.capabilities.refresh();
      final controller = ReportingController();
      final reporter = PlaybackReporter(
        controller: controller,
        repository: f.repository,
        outbox: f.outbox,
        authority: f.authority,
        journal: f.journal,
      );
      try {
        controller.emit(reportSnapshot(collectionFence), seconds: 0);
        await journalSettle();
        expect(reporter.state.createState, PlayCreateState.ambiguous);
        expect(f.posts.length, 1);
      } finally {
        await reporter.dispose();
        await controller.dispose();
        await f.close();
      }
    },
  );
  test('reporter durably finishes before lost create ACK and never updates a different run', () async {
    final f = JournalFixture();
    final ack = Completer<ApiResponse>();
    f.send = (_) => ack.future;
    await f.capabilities.refresh();
    final controller = ReportingController();
    final reporter = PlaybackReporter(
      controller: controller,
      repository: f.repository,
      outbox: f.outbox,
      authority: f.authority,
      journal: f.journal,
    );
    try {
      controller.emit(reportSnapshot(collectionFence), seconds: 0);
      await journalSettle();
      expect(f.posts.single.path, '/api/plays/idempotent');
      final key = f.posts.single.body!['clientPlaybackId'] as String;
      controller.emit(
        reportSnapshot(
          collectionFence,
          position: 200,
          audible: false,
          processing: PlaybackProcessing.completed,
        ),
        kind: PlaybackEventKind.completed,
        seconds: 200,
      );
      await journalSettle();
      expect(
        (await f.row(key))!['totals'],
        containsPair('listenedSeconds', 200),
      );
      expect((await f.row(key))!['final'], isTrue);
      ack.complete(createAck(f.posts.single));
      await journalSettle();
      expect(await f.row(key), isNull);
      final finalRow = await f.store.transaction(
        collectionFence,
        (tx) => tx.read(FeedbackOutbox.namespace, 'known-play'),
      );
      expect(finalRow, containsPair('listenedSeconds', 200));
      expect(finalRow, containsPair('outcome', 'completed'));
      expect(controller.commands, isEmpty);
    } finally {
      if (!ack.isCompleted && f.posts.isNotEmpty) {
        ack.complete(createAck(f.posts.single));
      }
      await reporter.dispose();
      await controller.dispose();
      await f.close();
    }
  });
  test('late capability never upgrades an ambiguous legacy run', () async {
    final f = JournalFixture()
      ..send = (_) async => throw StateError('legacy ACK lost');
    final controller = ReportingController();
    final reporter = PlaybackReporter(
      controller: controller,
      repository: f.repository,
      outbox: f.outbox,
      authority: f.authority,
      journal: f.journal,
    );
    try {
      controller.emit(reportSnapshot(collectionFence), seconds: 0);
      await journalSettle();
      expect(f.posts.single.path, '/api/plays');
      await f.capabilities.refresh();
      controller.emit(
        reportSnapshot(collectionFence, position: 60),
        seconds: 60,
      );
      await journalSettle();
      await f.journal.recover();
      expect(f.posts.length, 1);
      expect(
        await f.store.transaction(
          collectionFence,
          (tx) => tx.list(PlayCreateJournal.namespace),
        ),
        isEmpty,
      );
    } finally {
      await reporter.dispose();
      await controller.dispose();
      await f.close();
    }
  });
  test(
    'offline audible playback creates no new server Play or journal',
    () async {
      final f = JournalFixture();
      await f.capabilities.refresh();
      final controller = ReportingController();
      final reporter = PlaybackReporter(
        controller: controller,
        repository: f.repository,
        outbox: f.outbox,
        authority: f.authority,
        journal: f.journal,
        networkPolicy: const NetworkPolicy.offline(),
      );
      try {
        controller.emit(reportSnapshot(collectionFence), seconds: 0);
        controller.emit(
          reportSnapshot(collectionFence, position: 60),
          seconds: 60,
        );
        await journalSettle();
        expect(controller.snapshot.audible, isTrue);
        expect(controller.commands, isEmpty);
        expect(f.posts, isEmpty);
        expect(
          await f.store.transaction(
            collectionFence,
            (tx) => tx.list(PlayCreateJournal.namespace),
          ),
          isEmpty,
        );
      } finally {
        await reporter.dispose();
        await controller.dispose();
        await f.close();
      }
    },
  );
}
