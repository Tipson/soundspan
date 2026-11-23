import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/features/account/account_controller.dart';
import 'package:soundspan/features/account/account_screen.dart';
import 'package:soundspan/design_system/theme.dart';
import 'package:soundspan/features/account/registration_controller.dart';
import 'package:soundspan/features/account/credentials_screen.dart';
import 'package:soundspan/features/account/registration_screen.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/features/account/account_repository.dart';
import 'package:soundspan/features/account/two_factor_screen.dart';

import '../support/collection_fixtures.dart';

void changeLifecycle(WidgetTester tester, AppLifecycleState target) {
  const states = [
    AppLifecycleState.resumed,
    AppLifecycleState.inactive,
    AppLifecycleState.hidden,
    AppLifecycleState.paused,
  ];
  var current = states.indexOf(
    tester.binding.lifecycleState ?? AppLifecycleState.resumed,
  );
  if (current < 0) {
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    current = 0;
  }
  final end = states.indexOf(target);
  while (current != end) {
    current += current < end ? 1 : -1;
    tester.binding.handleAppLifecycleStateChanged(states[current]);
  }
  if (tester.binding.lifecycleState == null) {
    tester.binding.handleAppLifecycleStateChanged(target);
  }
}

void main() {
  ApiResponse fixture(ApiRequest r) => ApiResponse(200, switch (r.path) {
    '/api/auth/me' => {
      'id': 'a',
      'username': 'Alice',
      'email': 'alice@example.test',
    },
    '/api/auth/2fa/status' => {'enabled': false},
    '/api/auth/app-passwords' => {'appPasswords': []},
    '/api/api-keys' => {'apiKeys': []},
    '/api/auth/identities' => {'identities': []},
    _ => {'message': 'ok'},
  });
  late CollectionAuthority authority;
  late CollectionTransport transport;
  late AccountController controller;
  late int logouts;
  AccountController make({
    bool interactive = true,
    NetworkPolicy policy = const NetworkPolicy.online(),
  }) => AccountController(
    repository: AccountRepository(
      transport: transport,
      authority: authority,
      networkPolicy: policy,
      interactive: interactive,
    ),
    onPasswordChanged: () async {
      logouts++;
    },
  );
  setUp(() {
    authority = CollectionAuthority();
    transport = CollectionTransport((r, f) => fixture(r));
    logouts = 0;
    controller = make();
  });
  tearDown(() {
    controller.dispose();
  });
  for (final dismissal in ['navigator', 'system', 'close']) {
    testWidgets(
      'late enable during route reverse never reveals after $dismissal dismissal',
      (tester) async {
        changeLifecycle(tester, AppLifecycleState.resumed);
        final reply = Completer<ApiResponse>();
        transport = CollectionTransport(
          (r, f) => r.path.endsWith('/setup')
              ? const ApiResponse(200, {'secret': 'SETUPKEY'})
              : reply.future,
        );
        controller.dispose();
        controller = make();
        await tester.pumpWidget(
          MaterialApp(home: TwoFactorScreen(controller: controller)),
        );
        await tester.tap(find.text('Настроить 2FA'));
        await tester.pumpAndSettle();
        await tester.enterText(find.byType(TextFormField), '123456');
        await tester.tap(find.text('Подтвердить и включить'));
        await tester.pump();
        switch (dismissal) {
          case 'navigator':
            tester.state<NavigatorState>(find.byType(Navigator)).pop();
          case 'system':
            await tester.binding.handlePopRoute();
          case 'close':
            await tester.tap(find.text('Закрыть'));
        }
        await tester.pump();
        reply.complete(
          const ApiResponse(200, {
            'recoveryCodes': ['ABCD1234'],
          }),
        );
        await tester.pump(const Duration(milliseconds: 1));
        final lateSecret = controller.secret;
        final renderedSecret = find.text('ABCD1234').evaluate().length;
        final error = tester.takeException();
        await tester.pumpAndSettle();
        expect(error, isNull);
        expect(controller.secret, isNull);
        expect(
          transport.requests.where((r) => r.path.endsWith('/enable')),
          hasLength(1),
        );
        expect(
          [lateSecret == null, renderedSecret],
          [true, 0],
          reason:
              'Dismissal must revoke reveal before reverse-animation disposal',
        );
      },
    );
  }
  testWidgets(
    'barrier dismissal revokes pending credential reveal before reverse completes',
    (tester) async {
      final reply = Completer<ApiResponse>();
      transport = CollectionTransport((r, f) => reply.future);
      controller.dispose();
      controller = make();
      await tester.pumpWidget(
        MaterialApp(home: CredentialsScreen(controller: controller)),
      );
      await tester.tap(find.text('Создать пароль приложения'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextFormField), 'Phone');
      await tester.tap(find.text('Подтвердить'));
      await tester.pump();
      await tester.tapAt(const Offset(5, 5));
      await tester.pump();
      reply.complete(
        const ApiResponse(201, {
          'appPassword': {'secret': 'LATE'},
        }),
      );
      await tester.pump(const Duration(milliseconds: 1));
      final lateSecret = controller.secret;
      final renderedSecret = find.text('LATE').evaluate().length;
      final error = tester.takeException();
      await tester.pumpAndSettle();
      expect(error, isNull);
      expect(controller.secret, isNull);
      expect(find.byType(AlertDialog), findsNothing);
      expect(transport.requests, hasLength(1));
      expect([lateSecret == null, renderedSecret], [true, 0]);
    },
  );
  for (final resumeBeforeReply in [false, true]) {
    testWidgets(
      'pending setup loses reveal permission across background; resume before reply $resumeBeforeReply',
      (tester) async {
        changeLifecycle(tester, AppLifecycleState.resumed);
        addTearDown(() => changeLifecycle(tester, AppLifecycleState.resumed));
        final pending = Completer<ApiResponse>();
        var calls = 0;
        transport = CollectionTransport(
          (r, f) => ++calls == 1
              ? pending.future
              : const ApiResponse(200, {'secret': 'FRESHKEY'}),
        );
        controller.dispose();
        controller = make();
        await tester.pumpWidget(
          MaterialApp(home: TwoFactorScreen(controller: controller)),
        );
        await tester.tap(find.text('Настроить 2FA'));
        await tester.pump();
        changeLifecycle(tester, AppLifecycleState.paused);
        if (resumeBeforeReply) {
          changeLifecycle(tester, AppLifecycleState.resumed);
        }
        pending.complete(const ApiResponse(200, {'secret': 'LATEKEY'}));
        await tester.pumpAndSettle();
        expect(controller.secret, isNull);
        expect(find.byType(AlertDialog), findsNothing);
        expect(calls, 1);
        changeLifecycle(tester, AppLifecycleState.resumed);
        await tester.pumpAndSettle();
        expect(find.byType(AlertDialog), findsNothing);
        expect(calls, 1);
        await tester.tap(find.text('Настроить 2FA'));
        await tester.pumpAndSettle();
        expect(find.text('FRESHKEY'), findsOneWidget);
        expect(calls, 2);
        expect(tester.takeException(), isNull);
      },
    );
  }
  testWidgets(
    'pending enable Back never touches disposed token or reveals late recovery codes',
    (tester) async {
      final pending = Completer<ApiResponse>();
      transport = CollectionTransport(
        (r, f) => r.path.endsWith('/setup')
            ? const ApiResponse(200, {'secret': 'SETUPKEY'})
            : pending.future,
      );
      controller.dispose();
      controller = make();
      await tester.pumpWidget(
        MaterialApp(home: TwoFactorScreen(controller: controller)),
      );
      await tester.tap(find.text('Настроить 2FA'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextFormField), '123456');
      await tester.tap(find.text('Подтвердить и включить'));
      await tester.pump();
      tester.state<NavigatorState>(find.byType(Navigator)).pop();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
      expect(find.byType(AlertDialog), findsNothing);
      pending.complete(
        const ApiResponse(200, {
          'recoveryCodes': ['ABCD1234'],
        }),
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(controller.secret, isNull);
      expect(find.text('ABCD1234'), findsNothing);
      expect(
        transport.requests.where((r) => r.path.endsWith('/enable')),
        hasLength(1),
      );
    },
  );
  for (final resumeBeforeReply in [false, true]) {
    testWidgets(
      'pending enable drops recovery reveal after background; resume before reply $resumeBeforeReply',
      (tester) async {
        changeLifecycle(tester, AppLifecycleState.resumed);
        addTearDown(() => changeLifecycle(tester, AppLifecycleState.resumed));
        final pending = Completer<ApiResponse>();
        transport = CollectionTransport(
          (r, f) => r.path.endsWith('/setup')
              ? const ApiResponse(200, {'secret': 'SETUPKEY'})
              : pending.future,
        );
        controller.dispose();
        controller = make();
        await tester.pumpWidget(
          MaterialApp(home: TwoFactorScreen(controller: controller)),
        );
        await tester.tap(find.text('Настроить 2FA'));
        await tester.pumpAndSettle();
        await tester.enterText(find.byType(TextFormField), '123456');
        await tester.tap(find.text('Подтвердить и включить'));
        await tester.pump();
        changeLifecycle(tester, AppLifecycleState.paused);
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 500));
        if (resumeBeforeReply) {
          changeLifecycle(tester, AppLifecycleState.resumed);
        }
        pending.complete(
          const ApiResponse(200, {
            'recoveryCodes': ['ABCD1234'],
          }),
        );
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        expect(controller.secret, isNull);
        changeLifecycle(tester, AppLifecycleState.resumed);
        await tester.pumpAndSettle();
        expect(controller.secret, isNull);
        expect(find.byType(AlertDialog), findsNothing);
        expect(find.text('ABCD1234'), findsNothing);
        expect(controller.data['twoFactor']?['enabled'], true);
        expect(
          transport.requests.where((r) => r.path.endsWith('/enable')),
          hasLength(1),
        );
      },
    );
  }
  test(
    'mutation snapshots its body before asynchronous session admission',
    () async {
      final input = <String, Object?>{'email': 'first@example.test'};
      final work = controller.repository.mutate(
        collectionFence,
        AccountAction.changeEmail,
        input,
      );
      input['email'] = 'changed@example.test';
      await work;
      expect(transport.requests.single.body, {'email': 'first@example.test'});
    },
  );
  test('malformed status is rejected before UI receives it', () async {
    transport = CollectionTransport(
      (r, f) => r.path.endsWith('/status')
          ? const ApiResponse(200, {'enabled': 'yes'})
          : fixture(r),
    );
    controller.dispose();
    controller = make();
    await controller.load();
    expect(controller.data, isEmpty);
    expect(controller.message, isNotNull);
  });
  testWidgets('owner change clears secret and removes only owned modal', (
    tester,
  ) async {
    transport = CollectionTransport(
      (r, f) => r.method == ApiMethod.post
          ? const ApiResponse(201, {
              'appPassword': {'secret': 'ONETIME'},
            })
          : fixture(r),
    );
    controller.dispose();
    controller = make();
    await controller.load();
    await tester.pumpWidget(
      MaterialApp(
        theme: SoundspanTheme.dark(),
        home: CredentialsScreen(controller: controller),
      ),
    );
    await tester.tap(find.text('Создать пароль приложения'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextFormField), 'Phone');
    await tester.tap(find.text('Подтвердить'));
    await tester.pumpAndSettle();
    final navigator = tester.state<NavigatorState>(find.byType(Navigator));
    navigator.push(
      MaterialPageRoute<void>(
        builder: (_) => const Scaffold(body: Text('New owner route')),
      ),
    );
    await tester.pumpAndSettle();
    authority.switchOwner();
    await tester.pumpAndSettle();
    expect(find.text('New owner route'), findsOneWidget);
    expect(controller.secret, isNull);
    expect(tester.takeException(), isNull);
  });
  testWidgets(
    'registration narrow large text validates fields with IME and submits once',
    (tester) async {
      await authority.invalidate();
      int registered = 0;
      transport = CollectionTransport(
        (r, f) => const ApiResponse(200, {
          'user': {'id': 'new'},
          'token': 'discard',
        }),
      );
      tester.view.physicalSize = const Size(320, 844);
      tester.view.devicePixelRatio = 1;
      tester.view.viewInsets = const FakeViewPadding(bottom: 280);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetViewInsets);
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: const TextScaler.linear(2)),
            child: child!,
          ),
          home: RegistrationScreen(
            transport: transport,
            authority: authority,
            networkPolicy: const NetworkPolicy.online(),
            origin: collectionOrigin,
            onRegistered: () {
              registered++;
            },
          ),
        ),
      );
      final values = {
        'Код приглашения': 'INVITE',
        'Имя пользователя': 'alice',
        'Отображаемое имя': 'Alice',
        'Электронная почта': 'alice@example.test',
        'Пароль': 'password',
        'Повторите пароль': 'password',
      };
      for (final entry in values.entries) {
        final field = find.byWidgetPredicate(
          (w) => w is TextField && w.decoration?.labelText == entry.key,
        );
        await tester.scrollUntilVisible(
          field,
          180,
          scrollable: find.byType(Scrollable).first,
        );
        await tester.pumpAndSettle();
        await tester.enterText(field, entry.value);
      }
      await tester.scrollUntilVisible(
        find.text('Создать аккаунт'),
        180,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Создать аккаунт'));
      await tester.pumpAndSettle();
      expect(registered, 1);
      expect(transport.requests, hasLength(1));
      expect(tester.takeException(), isNull);
    },
  );
  for (final status in [400, 403, 429]) {
    test(
      'invitation refusal $status remains safe without adopting session',
      () async {
        await authority.invalidate();
        transport = CollectionTransport(
          (r, f) => ApiResponse(status, {'error': 'PRIVATE'}),
        );
        final registration = RegistrationController(
          transport: transport,
          authority: authority,
          networkPolicy: const NetworkPolicy.online(),
          origin: collectionOrigin,
        );
        addTearDown(registration.dispose);
        expect(await registration.register({'inviteCode': 'bad'}), false);
        expect(registration.uncertain, false);
        expect(registration.message, isNot(contains('PRIVATE')));
        expect(authority.state.fence, isNull);
      },
    );
  }
  test('registration disabled or session switched sends no request', () async {
    await authority.invalidate();
    final disabled = RegistrationController(
      transport: transport,
      authority: authority,
      networkPolicy: const NetworkPolicy.online(),
      origin: collectionOrigin,
      enabled: false,
    );
    addTearDown(disabled.dispose);
    await disabled.register({});
    expect(transport.requests, isEmpty);
    final registration = RegistrationController(
      transport: transport,
      authority: authority,
      networkPolicy: const NetworkPolicy.online(),
      origin: collectionOrigin,
    );
    addTearDown(registration.dispose);
    authority.switchOwner();
    await authority.invalidate();
    await registration.register({});
    expect(transport.requests, isEmpty);
  });
  for (final (action, path, method, body)
      in <(AccountAction, String, ApiMethod, Map<String, Object?>)>[
        (
          AccountAction.changeEmail,
          '/api/auth/change-email',
          ApiMethod.post,
          {'email': 'new@example.test'},
        ),
        (
          AccountAction.changePassword,
          '/api/auth/change-password',
          ApiMethod.post,
          {'currentPassword': 'old', 'newPassword': 'newpass'},
        ),
        (
          AccountAction.disable2fa,
          '/api/auth/2fa/disable',
          ApiMethod.post,
          {'password': 'secret', 'token': '123456'},
        ),
        (
          AccountAction.revokeAppPassword,
          '/api/auth/app-passwords/one',
          ApiMethod.delete,
          {'id': 'one'},
        ),
        (
          AccountAction.revokeApiKey,
          '/api/api-keys/one',
          ApiMethod.delete,
          {'id': 'one'},
        ),
        (
          AccountAction.unlinkIdentity,
          '/api/auth/identities/one',
          ApiMethod.delete,
          {'id': 'one'},
        ),
      ]) {
    test('actual wire contract ${action.name}', () async {
      await controller.repository.mutate(collectionFence, action, body);
      expect(transport.requests.single.path, path);
      expect(transport.requests.single.method, method);
      expect(
        transport.requests.single.body,
        method == ApiMethod.delete ? null : body,
      );
    });
  }
  testWidgets(
    'Back while create pending drops late secret without touching disposed input',
    (tester) async {
      final pending = Completer<ApiResponse>();
      transport = CollectionTransport(
        (r, f) => r.method == ApiMethod.post ? pending.future : fixture(r),
      );
      controller.dispose();
      controller = make();
      await controller.load();
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: CredentialsScreen(controller: controller),
        ),
      );
      await tester.tap(find.text('Создать пароль приложения'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextFormField), 'Phone');
      await tester.tap(find.text('Подтвердить'));
      await tester.pump();
      await tester.binding.handlePopRoute();
      await tester.pump(const Duration(seconds: 1));
      pending.complete(
        const ApiResponse(201, {
          'appPassword': {'secret': 'LATE'},
        }),
      );
      await tester.pumpAndSettle();
      expect(controller.secret, isNull);
      expect(find.text('LATE'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets('created secret stays in owned modal then clears on Back', (
    tester,
  ) async {
    transport = CollectionTransport(
      (r, f) => r.method == ApiMethod.post
          ? const ApiResponse(201, {
              'appPassword': {'secret': 'ONETIME'},
            })
          : fixture(r),
    );
    controller.dispose();
    controller = make();
    await controller.load();
    await tester.pumpWidget(
      MaterialApp(
        theme: SoundspanTheme.dark(),
        home: CredentialsScreen(controller: controller),
      ),
    );
    await tester.tap(find.text('Создать пароль приложения'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextFormField), 'Phone');
    await tester.tap(find.text('Подтвердить'));
    await tester.pumpAndSettle();
    expect(find.text('ONETIME'), findsOneWidget);
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(controller.secret, isNull);
    expect(find.text('ONETIME'), findsNothing);
    expect(tester.takeException(), isNull);
  });
  test(
    'invitation uses public POST with actual fields and discards issued tokens',
    () async {
      await authority.invalidate();
      transport = CollectionTransport(
        (r, f) => const ApiResponse(200, {
          'token': 'SECRET',
          'refreshToken': 'REFRESH',
          'user': {'id': 'new'},
        }),
      );
      final registration = RegistrationController(
        transport: transport,
        authority: authority,
        networkPolicy: const NetworkPolicy.online(),
        origin: collectionOrigin,
      );
      addTearDown(registration.dispose);
      expect(
        await registration.register({
          'inviteCode': 'INVITE',
          'username': 'alice',
          'displayName': 'Alice',
          'email': 'alice@example.test',
          'password': 'password',
          'confirmPassword': 'password',
        }),
        true,
      );
      expect(transport.requests.single.authenticated, false);
      expect(transport.requests.single.path, '/api/auth/register');
      expect(registration.completed, true);
      expect(authority.state.fence, isNull);
    },
  );
  test(
    'lost invitation response is not replayed and invalid invite stays safe',
    () async {
      await authority.invalidate();
      transport = CollectionTransport(
        (r, f) =>
            throw const AppFailure(code: 'network_timeout', message: 'timeout'),
      );
      final registration = RegistrationController(
        transport: transport,
        authority: authority,
        networkPolicy: const NetworkPolicy.online(),
        origin: collectionOrigin,
      );
      addTearDown(registration.dispose);
      await registration.register({'inviteCode': 'INVITE'});
      await registration.register({'inviteCode': 'INVITE'});
      expect(registration.uncertain, true);
      expect(transport.requests, hasLength(1));
    },
  );
  test('closed secret generation drops late credential response', () async {
    final pending = Completer<ApiResponse>();
    transport = CollectionTransport((r, f) => pending.future);
    controller.dispose();
    controller = make();
    final work = controller.perform(AccountAction.createApiKey, {
      'deviceName': 'Phone',
    });
    await Future<void>.delayed(Duration.zero);
    controller.clearSecret();
    pending.complete(const ApiResponse(201, {'apiKey': 'late'}));
    await work;
    expect(controller.secret, isNull);
  });
  for (final size in [
    const Size(320, 844),
    const Size(390, 844),
    const Size(430, 844),
    const Size(844, 390),
  ]) {
    final width = size.width;
    for (final scale in [1.0, 2.0]) {
      testWidgets('account navigation width $width scale $scale', (
        tester,
      ) async {
        tester.view.physicalSize = size;
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        await tester.pumpWidget(
          MaterialApp(
            theme: SoundspanTheme.dark(),
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context)
                  .copyWith(textScaler: TextScaler.linear(scale)),
              child: child!,
            ),
            home: AccountScreen(controller: controller),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('Аккаунт'), findsOneWidget);
        await tester.scrollUntilVisible(
          find.text('Двухэтапная проверка'),
          200,
          scrollable: find.byType(Scrollable).first,
        );
        await tester.pumpAndSettle();
        await tester.tap(find.text('Двухэтапная проверка'));
        await tester.pumpAndSettle();
        await tester.scrollUntilVisible(
          find.text('Настроить 2FA'),
          200,
          scrollable: find.byType(Scrollable).last,
        );
        await tester.pumpAndSettle();
        expect(find.text('Настроить 2FA'), findsOneWidget);
        expect(tester.takeException(), isNull);
      });
    }
  }
  test(
    'reads actual profile, security, own credentials and identities',
    () async {
      await controller.load();
      expect(controller.data['profile']?['username'], 'Alice');
      expect(
        transport.requests.map((r) => r.path),
        containsAll([
          '/api/auth/me',
          '/api/auth/2fa/status',
          '/api/auth/app-passwords',
          '/api/api-keys',
          '/api/auth/identities',
        ]),
      );
      expect(transport.fences, everyElement(collectionFence));
    },
  );
  test('one-time secret clears on close', () async {
    transport = CollectionTransport(
      (r, f) => r.method == ApiMethod.post
          ? const ApiResponse(201, {
              'appPassword': {
                'id': 'one',
                'displayName': 'Player',
                'secret': 'one-time',
              },
            })
          : fixture(r),
    );
    controller.dispose();
    controller = make();
    expect(
      await controller.perform(AccountAction.createAppPassword, {
        'displayName': 'Player',
      }),
      true,
    );
    expect(controller.secret?['value'], 'one-time');
    controller.clearSecret();
    expect(controller.secret, isNull);
  });
  test(
    'lost create is uncertain and readback never repeats mutation',
    () async {
      transport = CollectionTransport((r, f) {
        if (r.method == ApiMethod.post) {
          throw const AppFailure(code: 'network_timeout', message: 'timeout');
        }
        return fixture(r);
      });
      controller.dispose();
      controller = make();
      await controller.perform(AccountAction.createApiKey, {
        'deviceName': 'Phone',
      });
      expect(controller.uncertain, true);
      await controller.load();
      await controller.perform(AccountAction.createApiKey, {
        'deviceName': 'Phone',
      });
      expect(
        transport.requests.where((r) => r.method == ApiMethod.post),
        hasLength(1),
      );
      expect(controller.secret, isNull);
    },
  );
  test(
    'single flight and late secret cannot cross account switch ABA',
    () async {
      final pending = Completer<ApiResponse>();
      transport = CollectionTransport((r, f) => pending.future);
      controller.dispose();
      controller = make();
      final first = controller.perform(AccountAction.createApiKey, {
        'deviceName': 'Phone',
      });
      await Future<void>.delayed(Duration.zero);
      await controller.perform(AccountAction.createApiKey, {
        'deviceName': 'Phone',
      });
      expect(transport.requests, hasLength(1));
      authority.switchOwner();
      authority.active = collectionFence;
      authority.updates.add(authority.state);
      pending.complete(const ApiResponse(201, {'apiKey': 'late-secret'}));
      await first;
      expect(controller.active, false);
      expect(controller.secret, isNull);
    },
  );
  test('expired and noninteractive fail before sending; local restore online allowed', () async {
    controller.dispose();
    controller = make(interactive: false);
    await controller.perform(AccountAction.setup2fa);
    expect(transport.requests, isEmpty);
    controller.dispose();
    controller = make(policy: const NetworkPolicy.offline());
    await controller.load();
    expect(transport.requests, isEmpty);
    controller.dispose();
    authority.restoreLocally();
    controller = make();
    await controller.load();
    expect(transport.requests, hasLength(5));
    await authority.invalidate();
    await controller.perform(AccountAction.setup2fa);
    expect(transport.requests, hasLength(5));
  });
  test('password callback only after confirmed response', () async {
    await controller.perform(AccountAction.changePassword, {
      'currentPassword': 'old',
      'newPassword': 'newpass',
    });
    expect(logouts, 1);
  });
  test('password lost reply never claims success or logs out', () async {
    transport = CollectionTransport(
      (r, f) =>
          throw const AppFailure(code: 'network_timeout', message: 'timeout'),
    );
    controller.dispose();
    controller = make();
    expect(
      await controller.perform(AccountAction.changePassword, {
        'currentPassword': 'old',
        'newPassword': 'newpass',
      }),
      false,
    );
    expect(logouts, 0);
    expect(controller.uncertain, true);
  });
  for (final status in [400, 401, 403, 429]) {
    test(
      'safe server refusal $status never exposes body or repeats action',
      () async {
        transport = CollectionTransport(
          (r, f) => ApiResponse(status, {'error': 'PRIVATE RAW ERROR'}),
        );
        controller.dispose();
        controller = make();
        await controller.perform(AccountAction.unlinkIdentity, {'id': 'one'});
        expect(controller.message, isNotNull);
        expect(controller.message, isNot(contains('PRIVATE')));
        expect(controller.uncertain, false);
        expect(transport.requests, hasLength(1));
      },
    );
  }
  test('2fa setup and recovery codes are transient', () async {
    transport = CollectionTransport(
      (r, f) => switch (r.path) {
        '/api/auth/2fa/setup' => const ApiResponse(200, {
          'secret': 'SETUPKEY',
          'qrCode': 'invalid',
        }),
        '/api/auth/2fa/enable' => const ApiResponse(200, {
          'recoveryCodes': ['ABCD1234', 'DEAD1234'],
        }),
        _ => fixture(r),
      },
    );
    controller.dispose();
    controller = make();
    await controller.perform(AccountAction.setup2fa);
    expect(controller.secret?['value'], 'SETUPKEY');
    await controller.perform(AccountAction.enable2fa, {
      'secret': 'SETUPKEY',
      'token': '123456',
    });
    expect(controller.secret?['value'], 'ABCD1234\nDEAD1234');
    authority.switchOwner();
    expect(controller.secret, isNull);
  });
  test('create app password uses actual schema and captured fence', () async {
    final transport = CollectionTransport(
      (request, fence) => const ApiResponse(201, {
        'appPassword': {
          'id': 'one',
          'displayName': 'Player',
          'secret': 'one-time',
        },
      }),
    );
    final repository = AccountRepository(
      transport: transport,
      authority: CollectionAuthority(),
      networkPolicy: const NetworkPolicy.online(),
      interactive: true,
    );
    final result = await repository.mutate(
      collectionFence,
      AccountAction.createAppPassword,
      {'displayName': 'Player'},
    );
    expect(result['appPassword'], isA<Map>());
    expect(transport.requests.single.path, '/api/auth/app-passwords');
    expect(transport.requests.single.body, {'displayName': 'Player'});
    expect(transport.fences.single, collectionFence);
  });
}
