import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/app/entry_controller.dart';
import 'package:soundspan/app/entry_screen.dart';
import 'package:soundspan/design_system/theme.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/session/auth_models.dart';
import 'package:soundspan/core/session/auth_repository.dart';
import 'package:soundspan/core/session/session_authority.dart';

import '../support/collection_fixtures.dart';

void main() {
  test('return to held-off origin rejects late other-server config', () async {
    final held = Completer<AuthConfig>();
    final auth = _Auth()
      ..configuration = (origin) async {
        if (origin == collectionOrigin) {
          throw const AppFailure(
            code: 'holdoff',
            message: 'safe',
            statusCode: 429,
            retryAfter: Duration(seconds: 120),
          );
        }
        return held.future;
      };
    final entry = EntryController(auth: auth, origin: collectionOrigin);
    addTearDown(entry.dispose);
    await entry.loadConfig();
    final old = entry.changeServer('https://other.example');
    await entry.changeServer(collectionOrigin.toString());
    held.complete(
      const AuthConfig(
        localLoginEnabled: false,
        oidcEnabled: true,
        oidcProviderName: 'Other',
      ),
    );
    await old;
    expect(entry.state.origin, collectionOrigin);
    expect(entry.state.config, isNull);
    expect(entry.state.failure?.code, 'auth_holdoff');
  });

  test(
    'auth holdoff expiry enables explicit retry without automatic request',
    () async {
      var now = DateTime.utc(2026, 10, 15);
      final auth = _Auth();
      auth.configuration = (_) async => throw const AppFailure(
        code: 'http_error',
        message: 'safe',
        statusCode: 503,
        retryable: true,
        retryAfter: Duration(seconds: 120),
      );
      final entry = EntryController(
        auth: auth,
        origin: collectionOrigin,
        clock: () => now,
      );
      addTearDown(entry.dispose);
      await entry.loadConfig();
      expect(entry.canRequest, isFalse);
      now = now.add(const Duration(seconds: 121));
      expect(entry.canRequest, isTrue);
      expect(auth.configCalls, 1);
      auth.configuration = (_) async => _config;
      await entry.loadConfig();
      expect(auth.configCalls, 2);
      expect(entry.state.failure, isNull);
    },
  );

  test(
    'auth Retry-After prevents repeated config and same-server bypass',
    () async {
      final auth = _Auth();
      auth.configuration = (uri) async {
        if (uri == collectionOrigin) {
          throw const AppFailure(
            code: 'http_error',
            message: 'safe',
            statusCode: 429,
            retryable: true,
            retryAfter: Duration(seconds: 120),
          );
        }
        return _config;
      };
      final entry = EntryController(auth: auth, origin: collectionOrigin);
      addTearDown(entry.dispose);
      await entry.loadConfig();
      await entry.loadConfig();
      expect(auth.configCalls, 1);
      await entry.changeServer('https://other.example');
      expect(auth.configCalls, 2);
      await entry.changeServer(collectionOrigin.toString());
      expect(auth.configCalls, 2);
    },
  );

  for (final width in [320.0, 390.0, 430.0]) {
    for (final scale in [1.0, 2.0]) {
      testWidgets('entry login and second factor at $width scale$scale', (
        tester,
      ) async {
        tester.view.physicalSize = Size(width, 760);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final auth = _Auth()
          ..respond = (_) async => const LoginResult.requires2FA();
        final entry = EntryController(auth: auth, origin: collectionOrigin);
        addTearDown(entry.dispose);
        await tester.pumpWidget(
          MaterialApp(
            theme: SoundspanTheme.dark(),
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context)
                  .copyWith(textScaler: TextScaler.linear(scale)),
              child: child!,
            ),
            home: EntryScreen(controller: entry),
          ),
        );
        await tester.pumpAndSettle();
        await tester.enterText(
          find.byKey(const ValueKey('entry-username')),
          'alice',
        );
        await tester.enterText(
          find.byKey(const ValueKey('entry-password')),
          'password',
        );
        await tester.ensureVisible(find.byKey(const ValueKey('entry-submit')));
        await tester.tap(find.byKey(const ValueKey('entry-submit')));
        await tester.pumpAndSettle();
        expect(entry.state.requiresTwoFactor, isTrue);
        expect(find.byKey(const ValueKey('entry-code')), findsOneWidget);
        await tester.enterText(
          find.byKey(const ValueKey('entry-code')),
          '123456',
        );
        auth.respond = (_) async => LoginResult.success(collectionOwner);
        await tester.ensureVisible(find.byKey(const ValueKey('entry-submit')));
        await tester.tap(find.byKey(const ValueKey('entry-submit')));
        await tester.pumpAndSettle();
        expect(auth.inputs.last.token, '123456');
        expect(entry.state.authenticated, isTrue);
        expect(tester.takeException(), isNull);
      });
    }
  }

  test(
    'password and second factor use injected auth without creating credentials',
    () async {
      final auth = _Auth();
      final entry = EntryController(auth: auth, origin: collectionOrigin);
      addTearDown(entry.dispose);
      await entry.loadConfig();
      expect(entry.state.config?.localLoginEnabled, isTrue);
      auth.respond = (_) async => const LoginResult.requires2FA();
      await entry.login('alice', 'private password');
      expect(entry.state.requiresTwoFactor, isTrue);
      auth.respond = (_) async => LoginResult.success(collectionOwner);
      await entry.verify('123456');
      expect(auth.inputs, hasLength(2));
      expect(auth.inputs.last.username, 'alice');
      expect(auth.inputs.last.password, 'private password');
      expect(auth.inputs.last.token, '123456');
      expect(entry.state.authenticated, isTrue);
      expect(entry.state.toString(), isNot(contains('private password')));
    },
  );

  test(
    'busy login is single flight and wrong code remains recoverable',
    () async {
      final auth = _Auth();
      final entry = EntryController(auth: auth, origin: collectionOrigin);
      addTearDown(entry.dispose);
      await entry.loadConfig();
      final held = Completer<LoginResult>();
      auth.respond = (_) => held.future;
      final pending = entry.login('alice', 'password');
      await entry.login('alice', 'password');
      expect(auth.inputs, hasLength(1));
      held.complete(const LoginResult.requires2FA());
      await pending;
      auth.respond = (_) async => throw const AppFailure(
        code: 'unauthorized',
        message: 'safe',
        statusCode: 401,
      );
      await entry.verify('123456');
      expect(entry.state.requiresTwoFactor, isTrue);
      expect(entry.state.failure, isNotNull);
      auth.respond = (_) async => LoginResult.success(collectionOwner);
      await entry.verify('a0b1c2d3');
      expect(entry.state.authenticated, isTrue);
    },
  );

  test('server config latest intent wins and rejects unsafe origins', () async {
    final auth = _Auth();
    final old = Completer<AuthConfig>();
    auth.configuration = (uri) => uri == collectionOrigin
        ? old.future
        : Future.value(
            const AuthConfig(
              localLoginEnabled: false,
              oidcEnabled: true,
              oidcProviderName: 'SSO',
            ),
          );
    final entry = EntryController(auth: auth, origin: collectionOrigin);
    addTearDown(entry.dispose);
    final first = entry.loadConfig();
    await entry.changeServer('https://other.example');
    old.complete(_config);
    await first;
    expect(entry.state.origin, Uri.parse('https://other.example'));
    expect(entry.state.config?.localLoginEnabled, isFalse);
    final count = auth.configCalls;
    await entry.changeServer('https://secret:password@other.example');
    expect(auth.configCalls, count);
    expect(entry.state.origin, Uri.parse('https://other.example'));
    expect(entry.state.failure, isNotNull);
  });

  test('cancel second factor clears transient credentials and late reply cannot publish', () async {
    final auth = _Auth();
    final entry = EntryController(auth: auth, origin: collectionOrigin);
    addTearDown(entry.dispose);
    await entry.loadConfig();
    auth.respond = (_) async => const LoginResult.requires2FA();
    await entry.login('alice', 'password');
    await entry.cancel();
    await entry.verify('123456');
    expect(auth.inputs, hasLength(1));
    expect(auth.logouts, 1);
    final held = Completer<LoginResult>();
    auth.respond = (_) => held.future;
    final pending = entry.login('alice', 'password');
    final cancel = entry.cancel();
    held.complete(LoginResult.success(collectionOwner));
    await Future.wait([pending, cancel]);
    expect(entry.state.authenticated, isFalse);
  });

  test('disabled local login has no hidden password request', () async {
    final auth = _Auth()
      ..configuration = (_) async => const AuthConfig(
        localLoginEnabled: false,
        oidcEnabled: true,
        oidcProviderName: 'SSO',
      );
    final entry = EntryController(auth: auth, origin: collectionOrigin);
    addTearDown(entry.dispose);
    await entry.loadConfig();
    await entry.login('alice', 'password');
    expect(auth.inputs, isEmpty);
    expect(entry.state.failure, isNotNull);
  });
}

const _config = AuthConfig(
  localLoginEnabled: true,
  oidcEnabled: false,
  oidcProviderName: 'SSO',
);

class _Auth implements AuthRepository {
  final inputs = <LoginInput>[];
  int configCalls = 0, logouts = 0;
  Future<AuthConfig> Function(Uri) configuration = (_) async => _config;
  Future<LoginResult> Function(LoginInput) respond = (_) async =>
      LoginResult.success(collectionOwner);
  @override
  Future<AuthConfig> config(Uri origin) {
    configCalls++;
    return configuration(origin);
  }

  @override
  Future<LoginResult> login(LoginInput input) {
    inputs.add(input);
    return respond(input);
  }

  @override
  Future<void> logout() async {
    logouts++;
  }

  @override
  Future<AuthUser> me() => throw UnimplementedError();
  @override
  Future<SessionState> restore(Uri origin) => throw UnimplementedError();
}
