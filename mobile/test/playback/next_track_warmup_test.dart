import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/playback/next_track_warmup.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/resolved_media.dart';

import '../support/media_fixtures.dart';
import '../support/wave_reporting_fixtures.dart';

void main() {
  test(
    'warms the exact next occurrence after progress, once, without Play',
    () async {
      final authority = await mediaAuthority(Uri.parse('https://warm.test'));
      final fence = authority.requireFence();
      final controller = ReportingController();
      final entries = controller.createEntries([
        waveTrack('a'),
        waveTrack('b'),
        waveTrack('c'),
      ], const PlayContext(surface: PlaySurface.library));
      final calls = <String>[];
      final warmer = NextTrackWarmup(
        controller: controller,
        authority: authority,
        networkAllowed: () => true,
        warm: (entry, captured, cancellation) async {
          expect(captured, fence);
          calls.add(entry.entryId);
        },
      );
      addTearDown(() async {
        await warmer.close();
        await controller.dispose();
      });
      void emit(
        int seconds, {
        bool audible = true,
        QueueRepeat repeat = QueueRepeat.off,
        List<String>? order,
      }) => controller.emit(
        QueueSnapshot(
          entries: entries,
          effectiveOrder: order ?? entries.map((e) => e.entryId).toList(),
          currentEntryId: entries.first.entryId,
          fence: fence,
          generation: 1,
          lineage: 1,
          playingIntent: true,
          audible: audible,
          position: Duration(seconds: seconds),
          processing: PlaybackProcessing.ready,
          repeat: repeat,
        ),
      );
      emit(0);
      emit(1);
      emit(2, audible: false);
      await settle();
      expect(calls, isEmpty);
      emit(2);
      await settle();
      expect(calls, [entries[1].entryId]);
      emit(3);
      emit(4);
      await settle();
      expect(calls.length, 1);
      emit(
        5,
        order: [entries[0].entryId, entries[2].entryId, entries[1].entryId],
      );
      await settle();
      expect(calls.last, entries[2].entryId);
      expect(controller.commands, isEmpty);
    },
  );

  for (final action in [
    'pause',
    'offline',
    'logout',
    'replace',
    'close',
    'timeout',
  ]) {
    test('$action cancels warmup without changing the queue', () async {
      final authority = await mediaAuthority(Uri.parse('https://warm.test'));
      final fence = authority.requireFence();
      final controller = ReportingController();
      final entries = controller.createEntries([
        waveTrack('a'),
        waveTrack('b'),
      ], const PlayContext(surface: PlaySurface.library));
      final gate = Completer<void>();
      final tokens = <MediaCancellation>[];
      var online = true;
      final warmer = NextTrackWarmup(
        controller: controller,
        authority: authority,
        networkAllowed: () => online,
        timeout: const Duration(milliseconds: 20),
        warm: (_, _, token) {
          tokens.add(token);
          return gate.future;
        },
      );
      addTearDown(() async {
        if (!gate.isCompleted) gate.complete();
        await warmer.close();
        await controller.dispose();
      });
      QueueSnapshot state({bool play = true, int generation = 1}) =>
          QueueSnapshot(
            entries: entries,
            effectiveOrder: entries.map((e) => e.entryId),
            currentEntryId: entries.first.entryId,
            fence: fence,
            generation: generation,
            lineage: 1,
            playingIntent: play,
            audible: play,
            position: const Duration(seconds: 3),
            processing: PlaybackProcessing.ready,
          );
      controller.emit(state());
      await settle();
      expect(tokens.length, 1);
      switch (action) {
        case 'pause':
          controller.emit(state(play: false));
        case 'offline':
          online = false;
          warmer.cancelNetwork();
        case 'logout':
          await authority.invalidate();
        case 'replace':
          controller.emit(state(generation: 2));
        case 'close':
          await warmer.close();
        case 'timeout':
          await Future<void>.delayed(const Duration(milliseconds: 40));
      }
      await settle();
      expect(tokens.single.isCancelled, true);
      expect(controller.commands, isEmpty);
    });
  }

  test(
    'late cancelled work never creates overlapping operations or retry loops',
    () async {
      final authority = await mediaAuthority(Uri.parse('https://warm.test'));
      final fence = authority.requireFence();
      final controller = ReportingController();
      final entries = controller.createEntries([
        waveTrack('a'),
        waveTrack('b'),
        waveTrack('c'),
      ], const PlayContext(surface: PlaySurface.library));
      final gates = <Completer<void>>[];
      final warmer = NextTrackWarmup(
        controller: controller,
        authority: authority,
        networkAllowed: () => true,
        warm: (_, _, _) {
          final gate = Completer<void>();
          gates.add(gate);
          return gate.future;
        },
      );
      addTearDown(() async {
        for (final gate in gates) {
          if (!gate.isCompleted) gate.complete();
        }
        await warmer.close();
        await controller.dispose();
      });
      void emit(int generation) => controller.emit(
        QueueSnapshot(
          entries: entries,
          effectiveOrder: entries.map((e) => e.entryId),
          currentEntryId: entries[generation - 1].entryId,
          fence: fence,
          generation: generation,
          lineage: 1,
          playingIntent: true,
          audible: true,
          position: const Duration(seconds: 3),
          processing: PlaybackProcessing.ready,
        ),
      );
      emit(1);
      await settle();
      emit(2);
      await settle();
      expect(gates.length, 1);
      gates.first.complete();
      await settle();
      expect(gates.length, 2);
      gates.last.completeError(StateError('preload unavailable'));
      await settle();
      emit(2);
      await settle();
      expect(gates.length, 2);
      expect(controller.snapshot.failure, isNull);
    },
  );

  test('repeat one, terminal queue and offline never start a warmup', () async {
    final authority = await mediaAuthority(Uri.parse('https://warm.test'));
    final fence = authority.requireFence();
    final controller = ReportingController();
    final entries = controller.createEntries([
      waveTrack('a'),
      waveTrack('b'),
    ], const PlayContext(surface: PlaySurface.library));
    var online = true, calls = 0;
    final warmer = NextTrackWarmup(
      controller: controller,
      authority: authority,
      networkAllowed: () => online,
      warm: (_, _, _) async {
        calls++;
      },
    );
    addTearDown(() async {
      await warmer.close();
      await controller.dispose();
    });
    void emit(int index, QueueRepeat repeat) => controller.emit(
      QueueSnapshot(
        entries: entries,
        effectiveOrder: entries.map((e) => e.entryId),
        currentEntryId: entries[index].entryId,
        fence: fence,
        playingIntent: true,
        audible: true,
        position: const Duration(seconds: 3),
        processing: PlaybackProcessing.ready,
        repeat: repeat,
      ),
    );
    emit(0, QueueRepeat.one);
    emit(1, QueueRepeat.off);
    online = false;
    emit(0, QueueRepeat.off);
    await settle();
    expect(calls, 0);
    online = true;
    emit(1, QueueRepeat.all);
    await settle();
    expect(calls, 1);
  });
}
