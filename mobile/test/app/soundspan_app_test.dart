import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/app/app_composition.dart';
import 'package:soundspan/app/app_environment.dart';
import 'package:soundspan/app/soundspan_app.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/session/auth_models.dart';
import 'package:soundspan/core/session/auth_repository.dart';
import 'package:soundspan/core/session/session_authority.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/playback_engine.dart';

import '../support/collection_fixtures.dart';

void main() {
  testWidgets(
    'owner replacement destroys old root overlays without replacing playback',
    (tester) async {
      final fixture = _Fixture();
      // Process IO and its completed futures must share the real async zone.
      // Frames, gestures and assertions remain in the widget fake zone.
      final app = (await tester.runAsync(fixture.open))!;
      await tester.pumpWidget(
        SoundspanApp(
          composition: app,
          ownerBuilder: (context, scope, visibility) => Scaffold(
            body: TextButton(
              onPressed: () => showDialog<void>(
                context: context,
                builder: (_) =>
                    const AlertDialog(content: Text('Old private modal')),
              ),
              child: Text('Owner ${scope.fence.owner.userId}'),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Owner a'));
      await tester.pumpAndSettle();
      expect(find.text('Old private modal'), findsOneWidget);
      fixture.authority.switchOwner();
      await tester.runAsync(() => app.settled);
      await tester.pumpAndSettle();
      expect(find.text('Old private modal'), findsNothing);
      expect(find.text('Owner b'), findsOneWidget);
      expect(identical(app.playback, fixture.playback), isTrue);
      expect(fixture.playback.disposals, 0);
      await tester.pumpWidget(const SizedBox());
      expect(fixture.playback.disposals, 0);
      await tester.runAsync(app.close);
      expect(app.phase, AppPhase.closed);
      expect(fixture.playback.disposals, 1);
    },
  );

  testWidgets(
    'root exposure tracks dialog Back and app lifecycle without audio commands',
    (tester) async {
      final fixture = _Fixture();
      // Process IO and its completed futures must share the real async zone.
      // Frames, gestures and assertions remain in the widget fake zone.
      final app = (await tester.runAsync(fixture.open))!;
      ValueListenable<bool>? exposure;
      await tester.pumpWidget(
        SoundspanApp(
          composition: app,
          ownerBuilder: (context, scope, visibility) {
            exposure = visibility;
            return Scaffold(
              body: TextButton(
                onPressed: () => showDialog<void>(
                  context: context,
                  builder: (_) => const AlertDialog(content: Text('Dialog')),
                ),
                child: const Text('Open'),
              ),
            );
          },
        ),
      );
      await tester.pumpAndSettle();
      expect(exposure!.value, isTrue);
      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();
      expect(exposure!.value, isFalse);
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(exposure!.value, isTrue);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await tester.pump();
      expect(exposure!.value, isFalse);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(exposure!.value, isTrue);
      expect(fixture.playback.commands, isEmpty);
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(app.close);
      expect(app.phase, AppPhase.closed);
      expect(fixture.playback.disposals, 1);
    },
  );

  testWidgets(
    'late registration callback cannot pop a later root dialog or log in',
    (tester) async {
      final fixture = _Fixture()..authority.active = null;
      // Process IO and its completed futures must share the real async zone.
      // Frames, gestures and assertions remain in the widget fake zone.
      final app = (await tester.runAsync(fixture.open))!;
      VoidCallback? success;
      await tester.pumpWidget(
        SoundspanApp(
          composition: app,
          ownerBuilder: (_, _, _) => const SizedBox(),
          registrationBuilder: (context, origin, onRegistered) {
            success = onRegistered;
            return const Scaffold(body: Text('Registration fixture'));
          },
        ),
      );
      await tester.pumpAndSettle();
      await tester.ensureVisible(
        find.text('Есть приглашение? Создать аккаунт'),
      );
      await tester.tap(find.text('Есть приглашение? Создать аккаунт'));
      await tester.pumpAndSettle();
      expect(find.text('Registration fixture'), findsOneWidget);
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      final context = tester.element(find.text('Музыка в вашем ритме'));
      showDialog<void>(
        context: context,
        builder: (_) => const AlertDialog(content: Text('Later dialog')),
      );
      await tester.pumpAndSettle();
      success!();
      await tester.pumpAndSettle();
      expect(find.text('Later dialog'), findsOneWidget);
      expect(fixture.auth.logins, 0);
      expect(fixture.authority.active, isNull);
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(app.close);
      expect(app.phase, AppPhase.closed);
      expect(fixture.playback.disposals, 1);
    },
  );
}

class _Fixture {
  final authority = CollectionAuthority();
  final playback = _Playback();
  late final auth = _Auth(authority);
  Future<AppComposition> open() => AppComposition.create(
    AppEnvironment(
      authority: authority,
      auth: auth,
      origin: collectionOrigin,
      createPlayback: (_) async => playback,
      createOwner: (fence, _) async => _Scope(fence),
    ),
  );
}

class _Playback extends CollectionPlayback {
  _Playback() : super(QueueSnapshot());
  int disposals = 0;
  @override
  Future<void> dispose() async {
    disposals++;
  }
}

class _Scope implements AppOwnerScope {
  _Scope(this.fence);
  @override
  final SessionFence fence;
  @override
  Future<PreparedAudio> prepare(QueueEntry entry, SessionFence fence) =>
      throw UnimplementedError();
  @override
  Future<void> close() async {}
}

class _Auth implements AuthRepository {
  _Auth(this.authority);
  final CollectionAuthority authority;
  int logins = 0;
  @override
  Future<AuthConfig> config(Uri origin) async => const AuthConfig(
    localLoginEnabled: true,
    oidcEnabled: false,
    oidcProviderName: 'SSO',
  );
  @override
  Future<SessionState> restore(Uri origin) async => authority.state;
  @override
  Future<void> logout() => authority.invalidate();
  @override
  Future<LoginResult> login(LoginInput input) async {
    logins++;
    return LoginResult.success(collectionOwner);
  }

  @override
  Future<AuthUser> me() => throw UnimplementedError();
}
