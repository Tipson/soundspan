import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/app/app_composition.dart';
import 'package:soundspan/app/app_environment.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/session/auth_models.dart';
import 'package:soundspan/core/session/auth_repository.dart';
import 'package:soundspan/core/session/session_authority.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/queue_coordinator.dart';

import 'playback/queue_coordinator_test.dart' show FakeEngine, entry;
import 'support/collection_fixtures.dart';

void main() {
  test(
    'owner change while constructing playback fails before any owner admission',
    () async {
      final f = _Fixture()..playbackGate = Completer<void>();
      final opening = AppComposition.create(f.environment);
      await f.playbackEntered.future;
      f.authority.switchOwner();
      final replacement = f.authority.active;
      f.playbackGate!.complete();
      final app = await opening;
      expect(app.phase, AppPhase.failed);
      expect(f.activations, 0);
      expect(f.scopes, isEmpty);
      expect(f.prepares, isEmpty);
      expect(f.authority.active, replacement);
      expect(f.engine.disposals, 1);
      expect(f.releases, 1);
      await app.close();
    },
  );
  test(
    'pending native play prepares only after restored owner is admitted',
    () async {
      final f = _Fixture();
      f.authority.active = null;
      f.auth.restored = collectionFence;
      f.ownerGate = Completer<void>();
      final opening = AppComposition.create(f.environment);
      await f.ownerEntered.future;
      expect(f.activations, 0);
      expect(f.prepares, isEmpty);
      f.ownerGate!.complete();
      final app = await opening;
      addTearDown(app.close);
      expect(app.phase, AppPhase.ready);
      expect(f.activations, 1);
      expect(f.prepares, [collectionFence]);
      expect(f.engine.loaded, hasLength(1));
      expect(f.engine.position, const Duration(seconds: 2));
      expect(f.queue.snapshot.playingIntent, isTrue);
      expect(f.auth.restores, 1);
    },
  );

  test(
    'signed out startup discards pending play before a later login',
    () async {
      final f = _Fixture();
      f.authority.active = null;
      final app = await AppComposition.create(f.environment);
      addTearDown(app.close);
      expect(app.phase, AppPhase.signedOut);
      expect(f.activations, 1);
      expect(f.prepares, isEmpty);
      f.authority.active = collectionFence;
      f.authority.updates.add(f.authority.state);
      await app.settled;
      expect(app.phase, AppPhase.ready);
      expect(f.queue.snapshot.playingIntent, isFalse);
      expect(f.prepares, isEmpty);
      expect(f.activations, 1);
      await app.playback.dispatch(const Resume());
      expect(f.prepares, [collectionFence]);
    },
  );

  test(
    'warm startup activates once and later owner changes do not reinitialize',
    () async {
      final f = _Fixture();
      final app = await AppComposition.create(f.environment);
      addTearDown(app.close);
      expect(f.auth.restores, 0);
      expect(f.activations, 1);
      f.authority.switchOwner();
      await app.settled;
      expect(app.phase, AppPhase.ready);
      expect(app.owner!.fence, f.authority.active);
      expect(f.activations, 1);
      expect(f.playbackCreates, 1);
      expect(f.prepares, [collectionFence]);
      expect(f.queue.snapshot.playingIntent, isFalse);
    },
  );

  test(
    'activation failure drains once and cannot resurrect on auth change',
    () async {
      final f = _Fixture()..activationError = StateError('configure failed');
      final app = await AppComposition.create(f.environment);
      expect(app.phase, AppPhase.failed);
      expect(app.owner, isNull);
      expect(f.activations, 1);
      expect(f.engine.disposals, 1);
      expect(f.releases, 1);
      expect(f.scopes.single.closes, 1);
      f.authority.switchOwner();
      await app.settled;
      expect(app.phase, AppPhase.failed);
      expect(f.activations, 1);
      await app.close();
      await app.close();
      expect(f.engine.disposals, 1);
      expect(f.releases, 1);
      expect(f.scopes.single.closes, 1);
    },
  );

  test(
    'failed owner factory never configures service and drains resources',
    () async {
      final f = _Fixture()..ownerError = StateError('restore owner failed');
      final app = await AppComposition.create(f.environment);
      expect(app.phase, AppPhase.failed);
      expect(f.activations, 0);
      expect(f.engine.disposals, 1);
      expect(f.releases, 1);
      await app.close();
      expect(f.engine.disposals, 1);
    },
  );

  test('owner change during initial hydration never admits replacement or pending play', () async {
    final f = _Fixture()..ownerGate = Completer<void>();
    final opening = AppComposition.create(f.environment);
    await f.ownerEntered.future;
    f.authority.switchOwner();
    final replacement = f.authority.active;
    f.ownerGate!.complete();
    final app = await opening;
    expect(app.phase, AppPhase.failed);
    expect(f.activations, 0);
    expect(f.prepares, isEmpty);
    expect(f.scopes, hasLength(1));
    expect(
      f.authority.active,
      replacement,
      reason: 'Cleanup must not logout the new owner',
    );
    expect(f.releases, 1);
    await app.close();
  });

  for (final signedOut in [false, true]) {
    test(
      'owner change during configure cannot transfer pending play (signedOut=$signedOut)',
      () async {
        final f = _Fixture()..activationGate = Completer<void>();
        if (signedOut) f.authority.active = null;
        final opening = AppComposition.create(f.environment);
        await f.activationEntered.future;
        f.authority.switchOwner();
        final replacement = f.authority.active;
        f.activationGate!.complete();
        final app = await opening;
        expect(app.phase, AppPhase.failed);
        expect(f.prepares, isEmpty);
        expect(f.engine.loaded, isEmpty);
        expect(f.scopes.length, signedOut ? 0 : 1);
        expect(f.authority.active, replacement);
        expect(f.activations, 1);
        expect(f.releases, 1);
        await app.close();
      },
    );
  }

  test(
    'restore result fence is not replaced by newer authority state',
    () async {
      final f = _Fixture();
      f.authority.active = null;
      f.auth.restored = collectionFence;
      f.auth.afterRestore = f.authority.switchOwner;
      final app = await AppComposition.create(f.environment);
      expect(app.phase, AppPhase.failed);
      expect(f.activations, 0);
      expect(f.scopes, isEmpty);
      expect(f.prepares, isEmpty);
      expect(f.authority.active!.owner, isNot(collectionOwner));
      await app.close();
    },
  );
}

class _Fixture {
  final authority = CollectionAuthority();
  final engine = _Engine();
  late final auth = _Auth(authority);
  late QueueCoordinator queue;
  final scopes = <_Scope>[];
  final prepares = <SessionFence>[];
  final ownerEntered = Completer<void>(),
      activationEntered = Completer<void>(),
      playbackEntered = Completer<void>();
  Completer<void>? ownerGate, activationGate, playbackGate;
  Object? ownerError, activationError;
  int activations = 0, playbackCreates = 0, releases = 0;

  AppEnvironment get environment => AppEnvironment(
    authority: authority,
    auth: auth,
    origin: collectionOrigin,
    createPlayback: (prepare) async {
      playbackCreates++;
      playbackEntered.complete();
      if (playbackGate != null) await playbackGate!.future;
      return queue = QueueCoordinator(
        authority: authority,
        engine: engine,
        prepare: prepare,
      );
    },
    createOwner: (fence, playback) async {
      if (!ownerEntered.isCompleted) ownerEntered.complete();
      if (ownerGate != null) await ownerGate!.future;
      if (ownerError != null) throw ownerError!;
      final scope = _Scope(fence, prepares);
      scopes.add(scope);
      final row = entry('saved');
      await playback.dispatch(
        RestoreQueue(
          QueueSnapshot(
            entries: [row],
            effectiveOrder: [row.entryId],
            currentEntryId: row.entryId,
            fence: fence,
            position: const Duration(seconds: 2),
          ),
          fence: fence,
          expectedLineage: playback.snapshot.lineage,
        ),
      );
      return scope;
    },
    processReady: () async {
      activations++;
      activationEntered.complete();
      if (activationGate != null) await activationGate!.future;
      if (activationError != null) throw activationError!;
      // Model the native plugin delivering its already queued command. The
      // coordinator, AppComposition prepare closure and owner are real code.
      await queue.dispatch(const Resume());
    },
    release: () async {
      releases++;
    },
  );
}

class _Scope implements AppOwnerScope {
  _Scope(this.fence, this.prepares);
  @override
  final SessionFence fence;
  final List<SessionFence> prepares;
  int closes = 0;
  @override
  Future<PreparedAudio> prepare(QueueEntry entry, SessionFence fence) async {
    prepares.add(fence);
    return PreparedAudio(
      uri: Uri.parse('file:///synthetic.wav'),
      revoke: () async {},
    );
  }

  @override
  Future<void> close() async {
    closes++;
  }
}

class _Engine extends FakeEngine {
  int disposals = 0;
  @override
  Future<void> dispose() {
    disposals++;
    return super.dispose();
  }
}

class _Auth implements AuthRepository {
  _Auth(this.authority);
  final CollectionAuthority authority;
  SessionFence? restored;
  void Function()? afterRestore;
  int restores = 0;
  @override
  Future<SessionState> restore(Uri origin) async {
    restores++;
    authority.active = restored;
    final result = authority.state;
    afterRestore?.call();
    return result;
  }

  @override
  Future<void> logout() => authority.invalidate();
  @override
  Future<AuthConfig> config(Uri origin) => throw UnimplementedError();
  @override
  Future<LoginResult> login(LoginInput input) => throw UnimplementedError();
  @override
  Future<AuthUser> me() => throw UnimplementedError();
}
