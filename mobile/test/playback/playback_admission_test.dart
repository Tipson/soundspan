import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/session/session_authority.dart';
import 'package:soundspan/core/session/credential_vault.dart';
import 'package:soundspan/playback/playback_command.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/queue_coordinator.dart';

import '../support/media_fixtures.dart';
import 'queue_coordinator_test.dart' show FakeEngine, entry;

/// Models a broker which revoked admission before its cache event arrived.
final class CachedAuthority implements SessionAuthority {
  CachedAuthority(this.delegate);
  final SessionAuthority delegate;
  bool revoked = false;
  bool gateAdmissions = false;
  final pendingAdmissions = <Completer<void>>[];
  @override
  SessionState get state => delegate.state;
  @override
  Stream<SessionState> get changes => const Stream.empty();
  @override
  SessionFence requireFence() => delegate.requireFence();
  @override
  bool isCurrent(SessionFence fence) => delegate.isCurrent(fence);
  @override
  Future<void> assertCurrent(SessionFence fence) async {
    if (gateAdmissions) {
      final gate = Completer<void>();
      pendingAdmissions.add(gate);
      await gate.future;
    }
    if (revoked) {
      throw const AppFailure(
        code: 'session_revoked',
        message: 'Сессия завершена',
      );
    }
    await delegate.assertCurrent(fence);
  }

  @override
  Future<AccessGrant> grantAccess(SessionFence fence, Uri origin) =>
      delegate.grantAccess(fence, origin);
  @override
  Future<AuthStamp> after401(AuthStamp stamp) => delegate.after401(stamp);
  @override
  Future<void> invalidate() => delegate.invalidate();
}

final class AdmissionEngine extends FakeEngine {
  AdmissionEngine(this.afterLoad);
  final void Function() afterLoad;
  @override
  Future<void> load(Uri uri, int generation) async {
    await super.load(uri, generation);
    afterLoad();
  }
}

void main() {
  test(
    'last issued replacement wins simultaneous real authority admission',
    () async {
      final authority = await mediaAuthority(
        Uri.parse('https://audio.example'),
      );
      final queue = QueueCoordinator(
        authority: authority,
        engine: FakeEngine(),
        prepare: (_, _) async => PreparedAudio(
          uri: Uri.parse('file:///synthetic.wav'),
          revoke: () async {},
        ),
      );
      addTearDown(queue.dispose);
      final fence = authority.requireFence();
      final old = queue.dispatch(ReplaceQueue([entry('old')], fence: fence));
      final latest = queue.dispatch(ReplaceQueue([entry('new')], fence: fence));
      await Future.wait([old, latest]);
      expect(queue.snapshot.currentEntryId, 'new');
    },
  );
  test('latest replacement survives reverse broker admission order', () async {
    final authority = CachedAuthority(
      await mediaAuthority(Uri.parse('https://audio.example')),
    )..gateAdmissions = true;
    final queue = QueueCoordinator(
      authority: authority,
      engine: FakeEngine(),
      prepare: (_, _) async => PreparedAudio(
        uri: Uri.parse('file:///synthetic.wav'),
        revoke: () async {},
      ),
    );
    addTearDown(queue.dispose);
    final fence = authority.requireFence();
    final old = queue.dispatch(ReplaceQueue([entry('old')], fence: fence));
    final latest = queue.dispatch(ReplaceQueue([entry('new')], fence: fence));
    await pumpEventQueue();
    authority.gateAdmissions = false;
    authority.pendingAdmissions[1].complete();
    await latest;
    authority.pendingAdmissions[0].complete();
    await old;
    expect(queue.snapshot.currentEntryId, 'new');
  });
  test(
    'explicit entry selection cancels pending replacement admission',
    () async {
      final authority = CachedAuthority(
        await mediaAuthority(Uri.parse('https://audio.example')),
      );
      final queue = QueueCoordinator(
        authority: authority,
        engine: FakeEngine(),
        prepare: (_, _) async => PreparedAudio(
          uri: Uri.parse('file:///synthetic.wav'),
          revoke: () async {},
        ),
      );
      addTearDown(queue.dispose);
      final fence = authority.requireFence();
      await queue.dispatch(
        ReplaceQueue([entry('a'), entry('b')], fence: fence),
      );
      authority.gateAdmissions = true;
      final replacement = queue.dispatch(
        ReplaceQueue([entry('late')], fence: fence),
      );
      await pumpEventQueue();
      authority.gateAdmissions = false;
      await queue.dispatch(const PlayEntry('b'));
      authority.pendingAdmissions.single.complete();
      await replacement;
      expect(queue.snapshot.currentEntryId, 'b');
    },
  );
  test(
    'independent enqueue survives current-track transition during admission',
    () async {
      final authority = CachedAuthority(
        await mediaAuthority(Uri.parse('https://audio.example')),
      );
      final queue = QueueCoordinator(
        authority: authority,
        engine: FakeEngine(),
        prepare: (_, _) async => PreparedAudio(
          uri: Uri.parse('file:///synthetic.wav'),
          revoke: () async {},
        ),
      );
      addTearDown(queue.dispose);
      final fence = authority.requireFence();
      await queue.dispatch(
        ReplaceQueue([entry('a'), entry('b')], fence: fence),
      );
      authority.gateAdmissions = true;
      final append = queue.dispatch(Enqueue([entry('c')], fence: fence));
      await pumpEventQueue();
      authority.gateAdmissions = false;
      await queue.dispatch(const Next());
      authority.pendingAdmissions.single.complete();
      await append;
      expect(queue.snapshot.currentEntryId, 'b');
      expect(queue.snapshot.entries.map((e) => e.entryId), ['a', 'b', 'c']);
    },
  );
  test('clear cancels replacement still awaiting broker admission', () async {
    final authority = CachedAuthority(
      await mediaAuthority(Uri.parse('https://audio.example')),
    )..gateAdmissions = true;
    final engine = FakeEngine();
    final queue = QueueCoordinator(
      authority: authority,
      engine: engine,
      prepare: (_, _) async => PreparedAudio(
        uri: Uri.parse('file:///synthetic.wav'),
        revoke: () async {},
      ),
    );
    addTearDown(queue.dispose);
    final replacement = queue.dispatch(
      ReplaceQueue([entry('late')], fence: authority.requireFence()),
    );
    await pumpEventQueue();
    await queue.dispatch(const Clear());
    authority.gateAdmissions = false;
    authority.pendingAdmissions.single.complete();
    await replacement;
    expect(queue.snapshot.entries, isEmpty);
    expect(engine.loaded, isEmpty);
  });
  test(
    'rejected old owner cannot poison valid pending replacement intent',
    () async {
      final local = await mediaAuthority(Uri.parse('https://audio.example'));
      final oldFence = local.requireFence();
      await local.establish(
        OwnerKey(
          serverOrigin: Uri.parse('https://audio.example'),
          userId: 'owner-b',
        ),
        const TokenPair(accessToken: 'b', refreshToken: 'b-refresh'),
      );
      final authority = CachedAuthority(local)..gateAdmissions = true;
      final queue = QueueCoordinator(
        authority: authority,
        engine: FakeEngine(),
        prepare: (_, _) async => PreparedAudio(
          uri: Uri.parse('file:///synthetic.wav'),
          revoke: () async {},
        ),
      );
      addTearDown(queue.dispose);
      final valid = queue.dispatch(
        ReplaceQueue([entry('b')], fence: authority.requireFence()),
      );
      await pumpEventQueue();
      authority.gateAdmissions = false;
      await expectLater(
        queue.dispatch(ReplaceQueue([entry('a')], fence: oldFence)),
        throwsA(isA<AppFailure>()),
      );
      authority.pendingAdmissions.single.complete();
      await valid;
      expect(queue.snapshot.currentEntryId, 'b');
    },
  );
  test(
    'concurrent initial enqueue retains every independent occurrence',
    () async {
      final authority = await mediaAuthority(
        Uri.parse('https://audio.example'),
      );
      final queue = QueueCoordinator(
        authority: authority,
        engine: FakeEngine(),
        prepare: (_, _) async => PreparedAudio(
          uri: Uri.parse('file:///synthetic.wav'),
          revoke: () async {},
        ),
      );
      addTearDown(queue.dispose);
      final fence = authority.requireFence();
      await Future.wait([
        queue.dispatch(Enqueue([entry('a')], fence: fence)),
        queue.dispatch(Enqueue([entry('b')], fence: fence)),
      ]);
      expect(queue.snapshot.entries.map((e) => e.entryId), ['a', 'b']);
    },
  );
  test('late guarded dislike cannot skip newly selected entry', () async {
    final authority = await mediaAuthority(Uri.parse('https://audio.example'));
    final fence = authority.requireFence();
    final engine = FakeEngine();
    final queue = QueueCoordinator(
      authority: authority,
      engine: engine,
      prepare: (_, _) async => PreparedAudio(
        uri: Uri.parse('file:///synthetic.wav'),
        revoke: () async {},
      ),
    );
    await queue.dispatch(
      ReplaceQueue([entry('a'), entry('b'), entry('c')], fence: fence),
    );
    await queue.dispatch(const Next());
    await queue.dispatch(Next(expectedEntryId: 'a', fence: fence));
    expect(queue.snapshot.currentEntryId, 'b');
    await queue.dispatch(Next(expectedEntryId: 'b', fence: fence));
    expect(queue.snapshot.currentEntryId, 'c');
    await queue.dispose();
  });
  test(
    'late metadata from owner A cannot replace or enqueue under owner B',
    () async {
      final authority = await mediaAuthority(
        Uri.parse('https://audio.example'),
      );
      final fenceA = authority.requireFence();
      await authority.establish(
        OwnerKey(
          serverOrigin: Uri.parse('https://audio.example'),
          userId: 'owner-b',
        ),
        const TokenPair(accessToken: 'b', refreshToken: 'b-refresh'),
      );
      final engine = FakeEngine();
      final queue = QueueCoordinator(
        authority: authority,
        engine: engine,
        prepare: (_, _) async => PreparedAudio(
          uri: Uri.parse('file:///synthetic.wav'),
          revoke: () async {},
        ),
      );
      await queue.dispatch(
        ReplaceQueue([entry('b')], fence: authority.requireFence()),
      );
      final loads = engine.loaded.length;
      await expectLater(
        queue.dispatch(ReplaceQueue([entry('a')], fence: fenceA)),
        throwsA(isA<AppFailure>()),
      );
      await expectLater(
        queue.dispatch(Enqueue([entry('a')], fence: fenceA)),
        throwsA(isA<AppFailure>()),
      );
      await expectLater(
        queue.dispatch(ReplaceQueue([], fence: fenceA)),
        throwsA(isA<AppFailure>()),
      );
      expect(queue.snapshot.entries.single.entryId, 'b');
      expect(engine.loaded.length, loads);
      await queue.dispose();
    },
  );
  test(
    'cached current session cannot load after broker denies admission',
    () async {
      final authority = CachedAuthority(
        await mediaAuthority(Uri.parse('https://audio.example')),
      );
      final engine = FakeEngine();
      var revoked = false;
      final queue = QueueCoordinator(
        authority: authority,
        engine: engine,
        prepare: (_, _) async {
          authority.revoked = true;
          return PreparedAudio(
            uri: Uri.parse('file:///synthetic.wav'),
            revoke: () async {
              revoked = true;
            },
          );
        },
      );
      await queue.dispatch(
        ReplaceQueue([entry('a')], fence: authority.requireFence()),
      );
      expect(engine.loaded, isEmpty);
      expect(engine.plays, 0);
      expect(revoked, true);
      expect(queue.snapshot.entries, isEmpty);
      await queue.dispose();
    },
  );
  test('broker revoked during native load cannot begin audio', () async {
    final authority = CachedAuthority(
      await mediaAuthority(Uri.parse('https://audio.example')),
    );
    final engine = AdmissionEngine(() {
      authority.revoked = true;
    });
    final queue = QueueCoordinator(
      authority: authority,
      engine: engine,
      prepare: (_, _) async => PreparedAudio(
        uri: Uri.parse('file:///synthetic.wav'),
        revoke: () async {},
      ),
    );
    await queue.dispatch(
      ReplaceQueue([entry('a')], fence: authority.requireFence()),
    );
    expect(engine.loaded.length, 1);
    expect(engine.plays, 0);
    expect(queue.snapshot.entries, isEmpty);
    await queue.dispose();
  });
}
