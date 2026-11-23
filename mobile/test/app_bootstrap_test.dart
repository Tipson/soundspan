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

import 'support/collection_fixtures.dart';

void main() {
  test(
    'bootstrap owns one playback graph and restores without playing',
    () async {
      final fixture = _Fixture();
      fixture.authority.active = null;
      fixture.auth.onRestore = () {
        fixture.authority.active = collectionFence;
        fixture.authority.restoreLocally();
      };
      final app = await AppComposition.create(fixture.environment);
      addTearDown(app.close);
      expect(fixture.playbackCreates, 1);
      expect(fixture.auth.restores, 1);
      expect(app.phase, AppPhase.ready);
      expect(app.owner?.fence, collectionFence);
      expect(fixture.playback.commands.whereType<Resume>(), isEmpty);
      expect(fixture.playback.commands.whereType<ReplaceQueue>(), isEmpty);
      expect(identical(app.playback, fixture.playback), isTrue);
      fixture.authority.updates.add(
        const SessionState(status: SessionStatus.authenticated, fence: null),
      );
      await app.settled;
      expect(fixture.playbackCreates, 1);
      expect(fixture.scopes, hasLength(1));
    },
  );

  test('live broker session is not restored or interrupted again', () async {
    final fixture = _Fixture();
    final app = await AppComposition.create(fixture.environment);
    addTearDown(app.close);
    expect(fixture.auth.restores, 0);
    final clears = fixture.playback.commands.whereType<Clear>().length;
    fixture.authority.updates.add(
      SessionState(
        status: SessionStatus.authenticated,
        fence: collectionFence,
        tokenRevision: 25,
      ),
    );
    await app.settled;
    expect(fixture.scopes, hasLength(1));
    expect(fixture.playback.commands.whereType<Clear>().length, clears);
  });

  test(
    'process close checkpoints paused metadata before clearing service queue',
    () async {
      final fixture = _Fixture();
      final app = await AppComposition.create(fixture.environment);
      final scope = fixture.scopes.single;
      List<Type>? commandsAtOwnerClose;
      scope.onClose = () {
        commandsAtOwnerClose = fixture.playback.commands
            .map((c) => c.runtimeType)
            .toList();
      };
      await app.close();
      expect(commandsAtOwnerClose, contains(Pause));
      expect(commandsAtOwnerClose, isNot(contains(Clear)));
      expect(fixture.playback.commands.last, isA<Clear>());
      expect(fixture.authority.active, collectionFence);
    },
  );

  test(
    'replacement waits old owner cancellation before admitting new scope',
    () async {
      final fixture = _Fixture();
      final app = await AppComposition.create(fixture.environment);
      addTearDown(app.close);
      final old = fixture.scopes.single;
      old.closeGate = Completer<void>();
      fixture.authority.switchOwner();
      expect(app.owner, isNull);
      await Future<void>.delayed(Duration.zero);
      expect(old.closeCalls, 1);
      expect(fixture.scopes, hasLength(1));
      old.closeGate!.complete();
      await app.settled;
      expect(fixture.scopes, hasLength(2));
      expect(app.owner?.fence, fixture.authority.active);
    },
  );

  test('late created ABA owner closes before latest epoch starts', () async {
    final fixture = _Fixture();
    final app = await AppComposition.create(fixture.environment);
    addTearDown(app.close);
    final factoryGate = Completer<AppOwnerScope>();
    fixture.nextScope = factoryGate.future;
    fixture.authority.switchOwner();
    await Future<void>.delayed(Duration.zero);
    final b = _Scope(fixture.authority.active!);
    fixture.authority.active = SessionFence(owner: collectionOwner, epoch: 3);
    fixture.authority.updates.add(fixture.authority.state);
    factoryGate.complete(b);
    await app.settled;
    expect(b.closeCalls, 1);
    expect(app.owner?.fence.epoch, 3);
    expect(app.owner?.fence, isNot(collectionFence));
  });

  test(
    'failed owner cleanup blocks replacement and does not expose old data',
    () async {
      final fixture = _Fixture();
      final app = await AppComposition.create(fixture.environment);
      final old = fixture.scopes.single;
      old.closeError = StateError('fixture cleanup');
      fixture.authority.switchOwner();
      await app.settled;
      expect(app.owner, isNull);
      expect(app.phase, AppPhase.failed);
      expect(fixture.scopes, hasLength(1));
      old.closeError = null;
      await app.close();
    },
  );

  test(
    'late owner creation during app close is drained before playback disposal',
    () async {
      final fixture = _Fixture();
      final app = await AppComposition.create(fixture.environment);
      final factoryGate = Completer<AppOwnerScope>();
      fixture.nextScope = factoryGate.future;
      fixture.authority.switchOwner();
      await Future<void>.delayed(Duration.zero);
      final closing = app.close();
      final late = _Scope(fixture.authority.active!);
      factoryGate.complete(late);
      await closing;
      expect(late.closeCalls, 1);
      expect(fixture.playback.disposals, 1);
      expect(app.owner, isNull);
      await app.close();
      expect(fixture.playback.disposals, 1);
    },
  );
}

class _Fixture {
  final authority = CollectionAuthority();
  final playback = _Playback();
  late final auth = _Auth(authority);
  int playbackCreates = 0;
  final scopes = <_Scope>[];
  Future<AppOwnerScope>? nextScope;
  AppEnvironment get environment => AppEnvironment(
    authority: authority,
    auth: auth,
    origin: collectionOrigin,
    createPlayback: (prepare) async {
      playbackCreates++;
      return playback;
    },
    createOwner: (fence, playback) async {
      final held = nextScope;
      nextScope = null;
      if (held != null) return held;
      final scope = _Scope(fence);
      scopes.add(scope);
      return scope;
    },
  );
}

class _Scope implements AppOwnerScope {
  _Scope(this.fence);
  @override
  final SessionFence fence;
  int closeCalls = 0;
  Completer<void>? closeGate;
  Object? closeError;
  void Function()? onClose;
  @override
  Future<PreparedAudio> prepare(QueueEntry entry, SessionFence fence) =>
      throw UnimplementedError();
  @override
  Future<void> close() async {
    closeCalls++;
    onClose?.call();
    if (closeGate != null) await closeGate!.future;
    if (closeError != null) throw closeError!;
  }
}

class _Playback extends CollectionPlayback {
  _Playback() : super(QueueSnapshot());
  int disposals = 0;
  @override
  Future<void> dispose() async {
    disposals++;
  }
}

class _Auth implements AuthRepository {
  _Auth(this.authority);
  final CollectionAuthority authority;
  int restores = 0;
  void Function()? onRestore;
  @override
  Future<SessionState> restore(Uri origin) async {
    restores++;
    onRestore?.call();
    return authority.state;
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
