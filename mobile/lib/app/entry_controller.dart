import 'dart:async';

import 'package:flutter/foundation.dart';

import '../core/model/app_failure.dart';
import '../core/network/api_transport.dart';
import '../core/session/auth_models.dart';
import '../core/session/auth_repository.dart';

/// Presentation state contains no password, TOTP, token or credential object.
final class EntryState {
  const EntryState({
    required this.origin,
    this.config,
    this.busy = false,
    this.requiresTwoFactor = false,
    this.authenticated = false,
    this.failure,
  });
  final Uri origin;
  final AuthConfig? config;
  final bool busy, requiresTwoFactor, authenticated;
  final AppFailure? failure;
}

/// Uses the existing broker-backed auth boundary, never a second token owner.
final class EntryController extends ChangeNotifier {
  EntryController({
    required this.auth,
    required Uri origin,
    DateTime Function()? clock,
  }) : _state = EntryState(origin: normalizeServerOrigin(origin)),
       _clock = clock ?? DateTime.now;
  final AuthRepository auth;
  final DateTime Function() _clock;
  final _holdoffs = <Uri, DateTime>{};
  Timer? _holdoffTimer;
  EntryState _state;
  EntryState get state => _state;
  LoginInput? _pending;
  int _revision = 0;
  bool _disposed = false, _authenticating = false;

  Duration get retryRemaining {
    final until = _holdoffs[_state.origin];
    if (until == null) return Duration.zero;
    final delay = until.difference(_clock());
    return delay.isNegative ? Duration.zero : delay;
  }

  bool get canRequest =>
      !_disposed &&
      !_state.busy &&
      !_authenticating &&
      retryRemaining == Duration.zero;

  void _rememberHoldoff(Object error, Uri origin) {
    if (error is! AppFailure ||
        (error.statusCode != 429 && error.statusCode != 503) ||
        error.retryAfter == null ||
        error.retryAfter! <= Duration.zero) {
      return;
    }
    final until = _clock().add(error.retryAfter!);
    final prior = _holdoffs[origin];
    if (prior == null || until.isAfter(prior)) _holdoffs[origin] = until;
    _watchHoldoff();
  }

  void _watchHoldoff() {
    _holdoffTimer?.cancel();
    if (_disposed || retryRemaining <= Duration.zero) return;
    // UI countdown only; expiry never sends a request or retries a mutation.
    _holdoffTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (_disposed || retryRemaining <= Duration.zero) timer.cancel();
      if (!_disposed) notifyListeners();
    });
  }

  void _show({
    Uri? origin,
    AuthConfig? config,
    bool clearConfig = false,
    bool busy = false,
    bool? requiresTwoFactor,
    bool authenticated = false,
    AppFailure? failure,
  }) {
    if (_disposed) return;
    _state = EntryState(
      origin: origin ?? _state.origin,
      config: clearConfig ? null : config ?? _state.config,
      busy: busy,
      requiresTwoFactor: requiresTwoFactor ?? _state.requiresTwoFactor,
      authenticated: authenticated,
      failure: failure,
    );
    notifyListeners();
  }

  Future<void> loadConfig() async {
    if (_disposed || _authenticating) return;
    if (retryRemaining > Duration.zero) {
      _watchHoldoff();
      _show(
        failure: const AppFailure(
          code: 'auth_holdoff',
          message: 'Сервер просит подождать перед следующей попыткой.',
        ),
      );
      return;
    }
    final revision = ++_revision;
    final origin = _state.origin;
    _show(busy: true, clearConfig: true);
    if (_disposed || revision != _revision) return;
    try {
      final config = await auth.config(origin);
      if (!_disposed && revision == _revision && origin == _state.origin) {
        _show(config: config);
      }
    } catch (error) {
      if (!_disposed && revision == _revision) {
        _rememberHoldoff(error, origin);
        _show(failure: _failure(error));
      }
    }
  }

  Future<void> changeServer(String value) async {
    if (_disposed || _authenticating) return;
    try {
      final origin = normalizeServerOrigin(Uri.parse(value.trim()));
      // Accepting a new origin invalidates older replies even when its config
      // request is blocked by a remembered Retry-After deadline.
      final revision = ++_revision;
      _pending = null;
      _show(origin: origin, clearConfig: true, requiresTwoFactor: false);
      if (_disposed || revision != _revision) return;
      _watchHoldoff();
      await loadConfig();
    } catch (_) {
      _show(
        failure: const AppFailure(
          code: 'invalid_server',
          message: 'Введите адрес сервера с https без логина, пароля и пути.',
        ),
      );
    }
  }

  Future<void> login(String username, String password) async {
    if (!canRequest) return;
    if (_state.config?.localLoginEnabled != true) {
      _show(
        failure: const AppFailure(
          code: 'local_login_disabled',
          message: 'Вход по паролю недоступен на этом сервере.',
        ),
      );
      return;
    }
    if (username.trim().isEmpty || password.isEmpty) {
      _show(
        failure: const AppFailure(
          code: 'invalid_login_input',
          message: 'Введите логин и пароль.',
        ),
      );
      return;
    }
    _pending = LoginInput(
      origin: _state.origin,
      username: username,
      password: password,
    );
    await _authenticate(_pending!);
  }

  Future<void> verify(String token) async {
    if (_disposed ||
        _state.busy ||
        retryRemaining > Duration.zero ||
        !_state.requiresTwoFactor ||
        _pending == null) {
      return;
    }
    final code = token.trim();
    if (!RegExp(r'^(?:\d{6}|[a-fA-F0-9]{8})$').hasMatch(code)) {
      _show(
        failure: const AppFailure(
          code: 'invalid_second_factor',
          message: 'Введите код из 6 цифр или резервный код.',
        ),
      );
      return;
    }
    final pending = _pending!;
    await _authenticate(
      LoginInput(
        origin: pending.origin,
        username: pending.username,
        password: pending.password,
        token: code,
      ),
    );
  }

  Future<void> _authenticate(LoginInput input) async {
    final revision = ++_revision;
    _authenticating = true;
    _show(busy: true);
    if (_disposed || revision != _revision) return;
    try {
      final result = await auth.login(input);
      if (_disposed || revision != _revision) return;
      _authenticating = false;
      if (!result.requires2FA) _pending = null;
      _show(
        requiresTwoFactor: result.requires2FA,
        authenticated: !result.requires2FA,
      );
    } catch (error) {
      if (!_disposed && revision == _revision) {
        _authenticating = false;
        _rememberHoldoff(error, input.origin);
        if (!_state.requiresTwoFactor) _pending = null;
        _show(failure: _failure(error));
      }
    }
  }

  Future<void> cancel() async {
    if (_disposed) return;
    final revision = ++_revision;
    _pending = null;
    _authenticating = true;
    _show(busy: true, requiresTwoFactor: false);
    try {
      await auth.logout();
      if (!_disposed && revision == _revision) {
        _authenticating = false;
        _show(requiresTwoFactor: false);
      }
    } catch (error) {
      if (!_disposed && revision == _revision) {
        _authenticating = false;
        _show(requiresTwoFactor: false, failure: _failure(error));
      }
    }
  }

  AppFailure _failure(Object error) => error is AppFailure
      ? error
      : const AppFailure(
          code: 'auth_unavailable',
          message: 'Не удалось подключиться. Повторите попытку.',
          retryable: true,
        );

  @override
  void dispose() {
    _disposed = true;
    _revision++;
    _pending = null;
    _holdoffTimer?.cancel();
    // Do not log out here: successful login replaces the entry widget.
    super.dispose();
  }
}
