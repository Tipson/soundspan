import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/playback/playback_command.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/queue_coordinator.dart';
import 'package:soundspan/playback/queue_snapshot.dart';

import '../support/media_fixtures.dart';

QueueEntry entry(String id, [String recording = 'same']) => QueueEntry(
  entryId: id,
  track: Track(ref: LibraryTrackRef(recording), title: id, artist: 'Synthetic'),
  context: const PlayContext(surface: PlaySurface.playlist),
);

class FakeEngine implements PlaybackEngine {
  final controller = StreamController<EngineEvent>.broadcast(sync: true);
  final loaded = <int>[];
  int generation = 0;
  int plays = 0;
  int stops = 0;
  Duration position = Duration.zero;
  @override
  Stream<EngineEvent> get events => controller.stream;
  @override
  Future<void> load(Uri uri, int generation) async {
    this.generation = generation;
    loaded.add(generation);
  }

  void emit({
    Duration? position,
    PlaybackProcessing processing = PlaybackProcessing.ready,
    bool playing = true,
    int? generation,
    Duration? duration,
  }) {
    controller.add(
      EngineEvent(
        generation: generation ?? this.generation,
        position: position ?? this.position,
        processing: processing,
        playing: playing,
        duration: duration,
      ),
    );
  }

  @override
  Future<void> play() {
    plays++;
    return Completer<void>().future;
  }

  @override
  Future<void> pause() async {}
  @override
  Future<void> stop() async {
    stops++;
  }

  @override
  Future<void> seek(Duration value) async {
    position = value;
  }

  @override
  Future<void> setVolume(double volume) async {}
  @override
  Future<void> dispose() => controller.close();
}

class _NativeStartEngine extends FakeEngine
    implements PlaybackStartConfirmation {
  final confirmation = Completer<bool>();

  @override
  bool get requiresNativeStartConfirmation => true;

  @override
  Future<bool> confirmPlaying() => confirmation.future;
}

void main() {
  late FakeEngine engine;
  late QueueCoordinator queue;
  late dynamic authority;
  late List<String> resolved;
  late List<String> revoked;
  setUp(() async {
    engine = FakeEngine();
    authority = await mediaAuthority(Uri.parse('https://audio.example'));
    resolved = [];
    revoked = [];
    queue = QueueCoordinator(
      authority: authority,
      engine: engine,
      prepare: (item, fence) async {
        resolved.add(item.entryId);
        return PreparedAudio(
          uri: Uri.parse('http://127.0.0.1/synthetic'),
          revoke: () async {
            revoked.add(item.entryId);
          },
        );
      },
    );
  });
  tearDown(() async {
    await queue.dispose();
  });

  test(
    'startup summary waits for native playing and contains no identity',
    () async {
      await queue.dispose();
      final native = _NativeStartEngine();
      final logs = <String>[];
      queue = QueueCoordinator(
        authority: authority,
        engine: native,
        debugStartupLog: logs.add,
        prepare: (_, _) async => PreparedAudio(
          uri: Uri.parse('file:///secret-audio-file.wav'),
          revoke: () async {},
        ),
      );
      await queue.dispatch(
        ReplaceQueue([
          entry('private-queue-entry', 'private-recording'),
        ], fence: authority.requireFence()),
      );
      native.emit(position: const Duration(seconds: 2));
      expect(logs, isEmpty);
      native.confirmation.complete(true);
      await pumpEventQueue();
      expect(logs, hasLength(1));
      expect(
        logs.single,
        matches(
          RegExp(
            r'^\[SoundspanStartup\] outcome=playing source=local source_ms=\d+ first_bytes_ms=- decoder_ms=\d+ playing_ms=\d+ failure=- http_status=-$',
          ),
        ),
      );
      expect(logs.single, isNot(contains('private')));
      expect(logs.single, isNot(contains('secret')));
    },
  );

  test(
    'duplicate recording retains distinct occurrence and attribution',
    () async {
      await queue.dispatch(
        ReplaceQueue([entry('a'), entry('b')], fence: authority.requireFence()),
      );
      await queue.dispatch(const Next());
      expect(queue.snapshot.currentEntryId, 'b');
      expect(queue.snapshot.entries.map((e) => e.entryId), ['a', 'b']);
      expect(resolved, ['a', 'b']);
    },
  );
  test('reorder current preserves 37s and native source', () async {
    await queue.dispatch(
      ReplaceQueue([entry('a'), entry('b')], fence: authority.requireFence()),
    );
    engine.emit(position: const Duration(seconds: 37));
    await queue.dispatch(const Reorder(['b', 'a']));
    expect(queue.snapshot.position.inSeconds, 37);
    expect(queue.snapshot.currentEntryId, 'a');
    expect(engine.loaded.length, 1);
  });

  test('Next after a failed source starts the next entry; a manual pause stays paused', () async {
    await queue.dispose();
    final logs = <String>[];
    queue = QueueCoordinator(
      authority: authority,
      engine: engine = FakeEngine(),
      debugStartupLog: logs.add,
      prepare: (item, _) async {
        if (item.entryId == 'unavailable') {
          throw const AppFailure(
            code: 'http_error',
            message: 'Fixture without playable bytes',
            statusCode: 502,
          );
        }
        return PreparedAudio(
          uri: Uri.parse('file:///synthetic'),
          revoke: () async {},
        );
      },
    );
    await queue.dispatch(
      ReplaceQueue([
        entry('unavailable'),
        entry('available'),
        entry('after-pause'),
      ], fence: authority.requireFence()),
    );
    expect(queue.snapshot.processing, PlaybackProcessing.failed);
    expect(engine.plays, 0);

    await queue.dispatch(const Next());
    expect(queue.snapshot.currentEntryId, 'available');
    expect(queue.snapshot.playing, isTrue);
    expect(engine.plays, 1);
    expect(logs.single, contains('failure=http_error http_status=502'));

    await queue.dispatch(const Pause());
    await queue.dispatch(const Next());
    expect(queue.snapshot.currentEntryId, 'after-pause');
    expect(queue.snapshot.playing, isFalse);
    expect(engine.plays, 1);
  });
  test('changing versions reloads only the captured occurrence and preserves the queue', () async {
    final fence = authority.requireFence();
    await queue.dispatch(ReplaceQueue([entry('a'), entry('b')], fence: fence));
    final full = queue.snapshot;
    engine.emit(position: const Duration(seconds: 31));
    await queue.dispatch(
      SetTrackAudioVersion(
        fence: fence,
        entryId: 'a',
        generation: full.generation,
        standard: true,
      ),
    );
    expect(queue.snapshot.effectiveOrder, ['a', 'b']);
    expect(queue.snapshot.currentEntry!.standardAudio, isTrue);
    expect(queue.snapshot.entries.last.standardAudio, isFalse);
    expect(queue.snapshot.position, Duration.zero);
    expect(resolved, ['a', 'a']);
    await queue.dispatch(const Next());
    await queue.dispatch(
      SetTrackAudioVersion(
        fence: fence,
        entryId: 'a',
        generation: full.generation,
        standard: false,
      ),
    );
    expect(queue.snapshot.currentEntryId, 'b');
    expect(resolved, ['a', 'a', 'b']);
  });
  test(
    'remove current selects successor then predecessor then stops',
    () async {
      await queue.dispatch(
        ReplaceQueue([
          entry('a'),
          entry('b'),
          entry('c'),
        ], fence: authority.requireFence()),
      );
      await queue.dispatch(const Remove('a'));
      expect(queue.snapshot.currentEntryId, 'b');
      await queue.dispatch(const PlayEntry('c'));
      await queue.dispatch(const Remove('c'));
      expect(queue.snapshot.currentEntryId, 'b');
      await queue.dispatch(const Remove('b'));
      expect(queue.snapshot.currentEntryId, isNull);
      expect(queue.snapshot.playingIntent, isFalse);
    },
  );
  test('previous at 3s restarts and at 2s selects previous', () async {
    await queue.dispatch(
      ReplaceQueue(
        [entry('a'), entry('b')],
        fence: authority.requireFence(),
        initialEntryId: 'b',
      ),
    );
    engine.emit(position: const Duration(seconds: 3));
    await queue.dispatch(const Previous());
    expect(queue.snapshot.currentEntryId, 'b');
    expect(engine.position, Duration.zero);
    engine.emit(position: const Duration(seconds: 2));
    await queue.dispatch(const Previous());
    expect(queue.snapshot.currentEntryId, 'a');
  });
  test('shuffle removal keeps duplicates and restores user order', () async {
    await queue.dispatch(
      ReplaceQueue([
        entry('a'),
        entry('b'),
        entry('c'),
      ], fence: authority.requireFence()),
    );
    await queue.dispatch(const SetShuffle(true));
    await queue.dispatch(const Remove('b'));
    expect(queue.snapshot.effectiveOrder.toSet(), {'a', 'c'});
    await queue.dispatch(const SetShuffle(false));
    expect(queue.snapshot.effectiveOrder, ['a', 'c']);
    expect(queue.snapshot.currentEntryId, 'a');
  });
  test('repeat one completion repeats but explicit next advances', () async {
    await queue.dispatch(
      ReplaceQueue([entry('a'), entry('b')], fence: authority.requireFence()),
    );
    await queue.dispatch(const SetRepeat(QueueRepeat.one));
    engine.emit(processing: PlaybackProcessing.completed);
    await pumpEventQueue();
    expect(queue.snapshot.currentEntryId, 'a');
    expect(resolved, ['a', 'a']);
    await queue.dispatch(const Next());
    expect(queue.snapshot.currentEntryId, 'b');
  });
  test('terminal repeat off ends without wrap and all wraps', () async {
    await queue.dispatch(
      ReplaceQueue([entry('a')], fence: authority.requireFence()),
    );
    await queue.dispatch(const Next());
    expect(queue.snapshot.processing, PlaybackProcessing.completed);
    expect(queue.snapshot.playingIntent, isFalse);
    await queue.dispatch(const SetRepeat(QueueRepeat.all));
    await queue.dispatch(const Next());
    expect(queue.snapshot.currentEntryId, 'a');
  });
  test('clear stops and revokes capability', () async {
    await queue.dispatch(
      ReplaceQueue([entry('a')], fence: authority.requireFence()),
    );
    await queue.dispatch(const Clear());
    expect(revoked, ['a']);
    expect(engine.stops, greaterThan(0));
    expect(queue.snapshot.entries, isEmpty);
  });
  test('late replace cannot load or play stale resolved source', () async {
    final pending = Completer<PreparedAudio>();
    await queue.dispose();
    queue = QueueCoordinator(
      authority: authority,
      engine: engine = FakeEngine(),
      prepare: (item, fence) async {
        if (item.entryId == 'a') return pending.future;
        return PreparedAudio(
          uri: Uri.parse('file:///synthetic.wav'),
          revoke: () async {},
        );
      },
    );
    final old = queue.dispatch(
      ReplaceQueue([entry('a')], fence: authority.requireFence()),
    );
    await pumpEventQueue();
    await queue.dispatch(
      ReplaceQueue([entry('b')], fence: authority.requireFence()),
    );
    pending.complete(
      PreparedAudio(
        uri: Uri.parse('file:///old.wav'),
        revoke: () async {
          revoked.add('a');
        },
      ),
    );
    await old;
    expect(queue.snapshot.currentEntryId, 'b');
    expect(engine.loaded.length, 1);
    expect(engine.plays, 1);
    expect(revoked, ['a']);
  });
  test('logout before late resolve prevents any native load', () async {
    final pending = Completer<PreparedAudio>();
    await queue.dispose();
    queue = QueueCoordinator(
      authority: authority,
      engine: engine = FakeEngine(),
      prepare: (_, _) => pending.future,
    );
    final old = queue.dispatch(
      ReplaceQueue([entry('a')], fence: authority.requireFence()),
    );
    await pumpEventQueue();
    await authority.invalidate();
    pending.complete(
      PreparedAudio(
        uri: Uri.parse('file:///old.wav'),
        revoke: () async {
          revoked.add('a');
        },
      ),
    );
    await old;
    expect(engine.loaded, isEmpty);
    expect(queue.snapshot.entries, isEmpty);
    expect(queue.snapshot.playingIntent, isFalse);
  });
  test('play Future waiting for pause never blocks next command', () async {
    await queue.dispatch(
      ReplaceQueue([entry('a'), entry('b')], fence: authority.requireFence()),
    );
    await queue.dispatch(const Next()).timeout(const Duration(seconds: 1));
    expect(engine.plays, 2);
  });
  test('stale native completion cannot advance replacement queue', () async {
    await queue.dispatch(
      ReplaceQueue([entry('a')], fence: authority.requireFence()),
    );
    final old = engine.generation;
    await queue.dispatch(
      ReplaceQueue([entry('b'), entry('c')], fence: authority.requireFence()),
    );
    engine.emit(processing: PlaybackProcessing.completed, generation: old);
    await pumpEventQueue();
    expect(queue.snapshot.currentEntryId, 'b');
  });
  test(
    'snapshot lists immutable and invalid reorder leaves queue intact',
    () async {
      await queue.dispatch(
        ReplaceQueue([entry('a'), entry('b')], fence: authority.requireFence()),
      );
      expect(() => queue.snapshot.entries.clear(), throwsUnsupportedError);
      await expectLater(
        queue.dispatch(const Reorder(['a', 'a'])),
        throwsArgumentError,
      );
      expect(queue.snapshot.effectiveOrder, ['a', 'b']);
    },
  );
  test('seek event distinct from audible advancement and buffering', () async {
    final events = <PlaybackEvent>[];
    final subscription = queue.events.listen(events.add);
    await queue.dispatch(
      ReplaceQueue([entry('a')], fence: authority.requireFence()),
    );
    await queue.dispatch(const Seek(Duration(seconds: 30)));
    engine.emit(position: const Duration(seconds: 31));
    engine.emit(
      position: const Duration(seconds: 31),
      processing: PlaybackProcessing.buffering,
    );
    await pumpEventQueue();
    expect(
      events.map((e) => e.kind),
      containsAll([
        PlaybackEventKind.seek,
        PlaybackEventKind.position,
        PlaybackEventKind.buffering,
      ]),
    );
    await subscription.cancel();
  });
  test(
    'native failure stops and revokes source with safe recoverable error',
    () async {
      await queue.dispatch(
        ReplaceQueue([entry('a')], fence: authority.requireFence()),
      );
      final before = engine.stops;
      engine.controller.add(
        EngineEvent(
          generation: engine.generation,
          position: Duration.zero,
          processing: PlaybackProcessing.ready,
          playing: true,
          failed: true,
        ),
      );
      await pumpEventQueue();
      expect(queue.snapshot.failure?.retryable, true);
      expect(revoked, ['a']);
      expect(engine.stops, greaterThan(before));
    },
  );
  test('monotonic clock and owner provenance survive position seek', () async {
    await queue.dispose();
    var clock = const Duration(seconds: 1);
    queue = QueueCoordinator(
      authority: authority,
      engine: engine = FakeEngine(),
      elapsed: () => clock,
      prepare: (_, _) async => PreparedAudio(
        uri: Uri.parse('file:///synthetic.wav'),
        revoke: () async {},
      ),
    );
    final events = <PlaybackEvent>[];
    final sub = queue.events.listen(events.add);
    await queue.dispatch(
      ReplaceQueue([entry('a')], fence: authority.requireFence()),
    );
    final fence = queue.snapshot.fence;
    clock = const Duration(seconds: 2);
    await queue.dispatch(const Seek(Duration(minutes: 10)));
    await pumpEventQueue();
    expect(events.last.elapsed, const Duration(seconds: 2));
    expect(events.last.snapshot.fence, fence);
    await queue.dispatch(const Clear());
    expect(queue.snapshot.fence, isNull);
    await sub.cancel();
  });
  test('authority generates independent IDs for repeated recording', () async {
    final track = entry('seed').track;
    final entries = queue.createEntries([
      track,
      track,
    ], const PlayContext(surface: PlaySurface.home));
    expect(entries[0].entryId, isNot(entries[1].entryId));
    expect(entries[0].context.surface, PlaySurface.home);
    await queue.dispatch(
      ReplaceQueue(entries, fence: authority.requireFence()),
    );
    expect(queue.snapshot.currentEntryId, entries[0].entryId);
  });
  test(
    'bounded preparation fails recoverably and revokes late result',
    () async {
      final pending = Completer<PreparedAudio>();
      final logs = <String>[];
      await queue.dispose();
      queue = QueueCoordinator(
        authority: authority,
        engine: engine = FakeEngine(),
        prepareTimeout: const Duration(milliseconds: 10),
        debugStartupLog: logs.add,
        prepare: (_, _) => pending.future,
      );
      await queue.dispatch(
        ReplaceQueue([entry('a')], fence: authority.requireFence()),
      );
      expect(queue.snapshot.processing, PlaybackProcessing.failed);
      expect(logs, hasLength(1));
      expect(logs.single, contains('outcome=failed'));
      expect(logs.single, contains('failure=playback_prepare_timeout'));
      pending.complete(
        PreparedAudio(
          uri: Uri.parse('file:///late.wav'),
          revoke: () async {
            revoked.add('a');
          },
        ),
      );
      await pumpEventQueue();
      expect(revoked, ['a']);
      expect(engine.loaded, isEmpty);
    },
  );
  test(
    'snapshot consumers can issue commands without stream reentrancy',
    () async {
      final cleared = Completer<void>();
      final sub = queue.snapshots.listen((state) async {
        if (state.processing == PlaybackProcessing.ready) {
          try {
            await queue.dispatch(const Clear());
            cleared.complete();
          } catch (error, stack) {
            cleared.completeError(error, stack);
          }
        }
      });
      await queue.dispatch(
        ReplaceQueue([entry('a')], fence: authority.requireFence()),
      );
      await cleared.future.timeout(const Duration(seconds: 1));
      expect(queue.snapshot.entries, isEmpty);
      await sub.cancel();
    },
  );
  test(
    'explicit retry reloads same occurrence and seeks to saved 37s',
    () async {
      await queue.dispatch(
        ReplaceQueue([entry('a')], fence: authority.requireFence()),
      );
      engine.emit(position: const Duration(seconds: 37));
      engine.controller.add(
        EngineEvent(
          generation: engine.generation,
          position: const Duration(seconds: 37),
          processing: PlaybackProcessing.ready,
          playing: true,
          failed: true,
        ),
      );
      await queue.dispatch(const Resume());
      expect(queue.snapshot.currentEntryId, 'a');
      expect(engine.position, const Duration(seconds: 37));
      expect(queue.snapshot.position, const Duration(seconds: 37));
      expect(resolved, ['a', 'a']);
    },
  );
}
