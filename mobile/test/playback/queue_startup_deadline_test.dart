import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/queue_coordinator.dart';

import '../support/media_fixtures.dart';
import 'queue_coordinator_test.dart' show FakeEngine, entry;
import 'playback_admission_test.dart' show CachedAuthority;

final class HeldLoadEngine extends FakeEngine {
  final started = Completer<void>();
  final gate = Completer<void>();

  @override
  Future<void> load(Uri uri, int generation) async {
    await super.load(uri, generation);
    started.complete();
    await gate.future;
  }
}

final class SilentRefusalEngine extends FakeEngine {
  bool refusing = true;
  @override
  Future<void> play() {
    if (!refusing) return super.play();
    plays++;
    emit(playing: false);
    return Completer<void>().future;
  }
}

void main() {
  for (final stage in ['preparation', 'resume']) {
    test(
      '$stage bounds delayed broker admission and fences its late response',
      () async {
        final authority = CachedAuthority(
          await mediaAuthority(Uri.parse('https://audio.example')),
        );
        final engine = FakeEngine();
        final queue = QueueCoordinator(
          authority: authority,
          engine: engine,
          prepareTimeout: const Duration(milliseconds: 20),
          prepare: (_, _) async {
            if (stage == 'preparation') authority.gateAdmissions = true;
            return PreparedAudio(
              uri: Uri.parse('file:///admission.wav'),
              revoke: () async {},
            );
          },
        );
        final initial = queue.dispatch(
          ReplaceQueue(
            [entry('a')],
            fence: authority.requireFence(),
            play: false,
          ),
        );
        Future<void> pending = initial;
        if (stage == 'resume') {
          await initial;
          authority.gateAdmissions = true;
          pending = queue.dispatch(const Resume());
        }
        addTearDown(() async {
          authority.gateAdmissions = false;
          for (final gate in authority.pendingAdmissions) {
            if (!gate.isCompleted) gate.complete();
          }
          await pending;
          await queue.dispose();
        });
        await Future<void>.delayed(const Duration(milliseconds: 80));
        expect(queue.snapshot.processing, PlaybackProcessing.failed);
        expect(
          queue.snapshot.failure?.code,
          stage == 'preparation'
              ? 'playback_prepare_timeout'
              : 'playback_start_timeout',
        );
        authority.gateAdmissions = false;
        authority.pendingAdmissions.single.complete();
        await pending;
        expect(engine.plays, 0);
      },
    );
  }

  test('specific resolver failure reaches the retry UI', () async {
    final authority = await mediaAuthority(Uri.parse('https://audio.example'));
    final queue = QueueCoordinator(
      authority: authority,
      engine: FakeEngine(),
      prepare: (_, _) async => throw const AppFailure(
        code: 'recording_unavailable',
        message: 'Эта запись сейчас недоступна',
        retryable: true,
      ),
    );
    addTearDown(queue.dispose);
    await queue.dispatch(
      ReplaceQueue([entry('a')], fence: authority.requireFence()),
    );
    expect(queue.snapshot.failure?.code, 'recording_unavailable');
    expect(queue.snapshot.failure?.retryable, true);
  });
  test(
    'late native load interruption after Clear revokes its resource once',
    () async {
      final authority = await mediaAuthority(
        Uri.parse('https://audio.example'),
      );
      final engine = HeldLoadEngine();
      var revocations = 0;
      final queue = QueueCoordinator(
        authority: authority,
        engine: engine,
        prepare: (_, _) async => PreparedAudio(
          uri: Uri.parse('file:///interrupted.wav'),
          revoke: () async {
            revocations++;
          },
        ),
      );
      addTearDown(queue.dispose);
      final loading = queue.dispatch(
        ReplaceQueue([entry('a')], fence: authority.requireFence()),
      );
      await engine.started.future;
      await queue.dispatch(const Clear());
      engine.gate.completeError(StateError('native load interrupted by stop'));
      await loading;
      expect(revocations, 1);
      expect(queue.snapshot.failure, isNull);
      expect(queue.snapshot.entries, isEmpty);
    },
  );

  test('a native Play refusal becomes retryable instead of silently playing forever', () async {
    final authority = await mediaAuthority(Uri.parse('https://audio.example'));
    final engine = SilentRefusalEngine();
    final queue = QueueCoordinator(
      authority: authority,
      engine: engine,
      prepareTimeout: const Duration(milliseconds: 20),
      prepare: (_, _) async => PreparedAudio(
        uri: Uri.parse('file:///refused.wav'),
        revoke: () async {},
      ),
    );
    addTearDown(queue.dispose);
    await queue.dispatch(
      ReplaceQueue([entry('a')], fence: authority.requireFence()),
    );
    await Future<void>.delayed(const Duration(milliseconds: 80));
    expect(queue.snapshot.processing, PlaybackProcessing.failed);
    expect(queue.snapshot.playingIntent, false);
    expect(queue.snapshot.failure?.retryable, true);
    expect(queue.snapshot.failure?.code, 'playback_start_timeout');
    engine.refusing = false;
    await queue.dispatch(const Resume());
    engine.emit(position: const Duration(milliseconds: 300));
    await Future<void>.delayed(const Duration(milliseconds: 80));
    expect(queue.snapshot.failure, isNull);
    expect(queue.snapshot.playingIntent, true);
    expect(queue.snapshot.audible, true);
  });

  test(
    'optimistic native playing without clock progress still times out',
    () async {
      final authority = await mediaAuthority(
        Uri.parse('https://audio.example'),
      );
      final engine = FakeEngine();
      final queue = QueueCoordinator(
        authority: authority,
        engine: engine,
        prepareTimeout: const Duration(milliseconds: 20),
        prepare: (_, _) async => PreparedAudio(
          uri: Uri.parse('file:///frozen.wav'),
          revoke: () async {},
        ),
      );
      addTearDown(queue.dispose);
      await queue.dispatch(
        ReplaceQueue([entry('a')], fence: authority.requireFence()),
      );
      engine.emit(playing: true);
      await Future<void>.delayed(const Duration(milliseconds: 80));
      expect(queue.snapshot.failure?.code, 'playback_start_timeout');
    },
  );

  test(
    'real progress confirms a healthy start and focus pause retains intent',
    () async {
      final authority = await mediaAuthority(
        Uri.parse('https://audio.example'),
      );
      final engine = FakeEngine();
      final queue = QueueCoordinator(
        authority: authority,
        engine: engine,
        prepareTimeout: const Duration(milliseconds: 20),
        prepare: (_, _) async => PreparedAudio(
          uri: Uri.parse('file:///healthy.wav'),
          revoke: () async {},
        ),
      );
      addTearDown(queue.dispose);
      await queue.dispatch(
        ReplaceQueue([entry('a')], fence: authority.requireFence()),
      );
      engine.emit(position: const Duration(milliseconds: 300));
      await Future<void>.delayed(const Duration(milliseconds: 80));
      expect(queue.snapshot.failure, isNull);
      expect(queue.snapshot.audible, true);
      await queue.dispatch(const Pause());
      await queue.dispatch(const Resume());
      await queue.suspendForFocus();
      await Future<void>.delayed(const Duration(milliseconds: 80));
      expect(queue.snapshot.failure, isNull);
      expect(queue.snapshot.focusSuspended, true);
      expect(queue.snapshot.playingIntent, true);
    },
  );

  test('native load shares the bounded preparation deadline', () async {
    final authority = await mediaAuthority(Uri.parse('https://audio.example'));
    final engine = HeldLoadEngine();
    var revocations = 0;
    final queue = QueueCoordinator(
      authority: authority,
      engine: engine,
      prepareTimeout: const Duration(milliseconds: 10),
      prepare: (_, _) async => PreparedAudio(
        uri: Uri.parse('file:///held.wav'),
        revoke: () async => revocations++,
      ),
    );
    final loading = queue.dispatch(
      ReplaceQueue([entry('a')], fence: authority.requireFence()),
    );
    addTearDown(() async {
      if (!engine.gate.isCompleted) engine.gate.complete();
      await loading;
      await queue.dispose();
    });
    await engine.started.future;
    await Future<void>.delayed(const Duration(milliseconds: 80));
    expect(queue.snapshot.processing, PlaybackProcessing.failed);
    expect(queue.snapshot.failure?.retryable, true);
    expect(queue.snapshot.playingIntent, false);
    expect(revocations, 1);
    engine.gate.complete();
    await loading;
    engine.emit(playing: true);
    await pumpEventQueue();
    expect(engine.plays, 0);
    expect(queue.snapshot.processing, PlaybackProcessing.failed);
  });

  test(
    'a timed out preparation cannot revoke or play a replacement queue',
    () async {
      final authority = await mediaAuthority(
        Uri.parse('https://audio.example'),
      );
      final engine = HeldLoadEngine();
      final queue = QueueCoordinator(
        authority: authority,
        engine: engine,
        prepareTimeout: const Duration(milliseconds: 10),
        prepare: (_, _) async => PreparedAudio(
          uri: Uri.parse('file:///held.wav'),
          revoke: () async {},
        ),
      );
      final loading = queue.dispatch(
        ReplaceQueue([entry('a')], fence: authority.requireFence()),
      );
      addTearDown(() async {
        if (!engine.gate.isCompleted) engine.gate.complete();
        await loading;
        await queue.dispose();
      });
      await engine.started.future;
      await queue.dispatch(const Clear());
      await Future<void>.delayed(const Duration(milliseconds: 80));
      engine.gate.complete();
      await loading;
      expect(queue.snapshot.processing, PlaybackProcessing.idle);
      expect(queue.snapshot.failure, isNull);
      expect(engine.plays, 0);
    },
  );
}
