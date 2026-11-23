import 'dart:async';

import 'package:flutter/widgets.dart';

import '../../core/model/app_failure.dart';
import '../../core/model/owner_key.dart';
import 'account_repository.dart';

/// Owner-bound security state. No credential is written to a store or diagnostic.
class AccountController extends ChangeNotifier with WidgetsBindingObserver {
  AccountController({required this.repository, required this.onPasswordChanged})
    : fence = repository.authority.requireFence() {
    final binding = WidgetsBinding.instance;
    _foreground =
        binding.lifecycleState == null ||
        binding.lifecycleState == AppLifecycleState.resumed;
    binding.addObserver(this);
    _subscription = repository.authority.changes.listen((_) {
      if (!repository.authority.isCurrent(fence)) {
        _revoked = true;
        _secret = null;
        data = {};
        message = 'Сеанс завершён. Войдите снова.';
        _emit();
      }
    });
  }
  final AccountRepository repository;
  final Future<void> Function() onPasswordChanged;
  final SessionFence fence;
  late final StreamSubscription<Object?> _subscription;
  bool _disposed = false;
  bool _revoked = false;
  int _secretGeneration = 0;
  bool get active =>
      !_disposed && !_revoked && repository.authority.isCurrent(fence);
  bool busy = false;
  bool loading = false;
  bool uncertain = false;
  String? message;
  Map<String, Object?>? _secret;
  bool _foreground = true;
  bool get foreground => _foreground;
  Map<String, Object?>? get secret => active && foreground && _secret != null
      ? Map.unmodifiable(_secret!)
      : null;
  bool get canRevealSecret => secret != null;
  Map<String, Map<String, Object?>> data = {};
  final Set<AccountAction> _uncertainActions = {};
  DateTime? _retryAt;
  bool get canMutate =>
      active &&
      foreground &&
      !busy &&
      !loading &&
      repository.interactive &&
      repository.networkPolicy.networkAllowed &&
      (_retryAt == null || !DateTime.now().isBefore(_retryAt!));

  Future<void> load() async {
    if (!active || loading || busy) return;
    loading = true;
    _emit();
    try {
      final next = <String, Map<String, Object?>>{};
      for (final resource in [
        'profile',
        'twoFactor',
        'appPasswords',
        'apiKeys',
        'identities',
      ]) {
        if (!active) return;
        next[resource] = await repository.read(fence, resource);
      }
      if (!active) return;
      // Lists are metadata only even if a server accidentally adds a secret.
      data = next.map((key, value) => MapEntry(key, _metadata(value)));
      if (!uncertain) message = null;
    } catch (error) {
      if (active) message = accountError(error);
    } finally {
      loading = false;
      _emit();
    }
  }

  Future<bool> perform(
    AccountAction action, [
    Map<String, Object?> input = const {},
  ]) async {
    if (!active ||
        !foreground ||
        busy ||
        loading ||
        _uncertainActions.contains(action)) {
      return false;
    }
    if (_retryAt != null && DateTime.now().isBefore(_retryAt!)) return false;
    busy = true;
    message = null;
    final secretGeneration = _secretGeneration;
    _emit();
    bool confirmed = false;
    try {
      if (!foreground || _secretGeneration != secretGeneration) return false;
      final result = await repository.mutate(fence, action, input);
      if (!active) return false;
      confirmed = true;
      if (foreground && _secretGeneration == secretGeneration) {
        switch (action) {
          case AccountAction.setup2fa:
            _secret = {'kind': 'setup', 'value': _string(result['secret'])};
          case AccountAction.enable2fa:
            final codes = result['recoveryCodes'];
            if (codes is! List ||
                codes.isEmpty ||
                codes.any(
                  (c) => c is! String || !RegExp(r'^[A-Z0-9]{8}$').hasMatch(c),
                )) {
              throw const AppFailure(
                code: 'invalid_account_data',
                message: 'Некорректный ответ сервера.',
              );
            }
            _secret = {'kind': 'recovery', 'value': codes.join('\n')};
          case AccountAction.createAppPassword:
            _secret = {
              'kind': 'credential',
              'value': _string(accountObject(result['appPassword'])['secret']),
            };
          case AccountAction.createApiKey:
            _secret = {
              'kind': 'credential',
              'value': _string(result['apiKey']),
            };
          default:
            break;
        }
      }
      if (action == AccountAction.enable2fa ||
          action == AccountAction.disable2fa) {
        data = {
          ...data,
          'twoFactor': {'enabled': action == AccountAction.enable2fa},
        };
      }
      message = 'Сохранено';
      if (action == AccountAction.changePassword) {
        _secret = null;
        await onPasswordChanged();
      }
      return true;
    } catch (error) {
      if (!active) return false;
      final failure = error is AppFailure ? error : null;
      final status = failure?.statusCode;
      final knownRefusal = status != null && status >= 400 && status < 500;
      final admission = const {
        'offline_mode',
        'interactive_required',
        'session_revoked',
        'stale_session',
        'invalid_id',
      }.contains(failure?.code);
      if ((!knownRefusal && !admission) || confirmed) {
        uncertain = true;
        _uncertainActions.add(action);
        _secret = null;
        message = 'Ответ не подтверждён. Изменение могло сохраниться. Обновите данные; повторная отправка этого действия заблокирована до нового входа. Если секрет потерян, отзовите созданный ключ.';
      } else {
        message = accountError(error, action: action);
      }
      if (failure?.retryAfter != null) {
        _retryAt = DateTime.now().add(failure!.retryAfter!);
      }
      return false;
    } finally {
      busy = false;
      _emit();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    if (!_foreground) {
      // Invalidate in-flight reveal before any modal exists. Resume never
      // restores permission for an operation that crossed this boundary.
      clearSecret();
    } else {
      _emit();
    }
  }

  void clearSecret({bool notify = true}) {
    _secretGeneration++;
    _secret = null;
    if (notify) _emit();
  }

  void _emit() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    WidgetsBinding.instance.removeObserver(this);
    _secret = null;
    data = {};
    _subscription.cancel();
    super.dispose();
  }
}

String _string(Object? value) {
  if (value is! String || value.isEmpty || value.length > 8192) {
    throw const AppFailure(
      code: 'invalid_account_data',
      message: 'Некорректный ответ сервера.',
    );
  }
  return value;
}

Map<String, Object?> _metadata(Map<String, Object?> input) {
  final result = <String, Object?>{};
  for (final entry in input.entries) {
    if (const [
      'secret',
      'apiKey',
      'password',
      'token',
      'recoveryCodes',
      'qrCode',
    ].contains(entry.key)) {
      continue;
    }
    final value = entry.value;
    result[entry.key] = value is Map<String, dynamic>
        ? _metadata(value)
        : value is List
        ? value
              .map((row) => row is Map<String, dynamic> ? _metadata(row) : row)
              .toList(growable: false)
        : value;
  }
  return result;
}

String accountError(Object error, {AccountAction? action}) {
  if (error is! AppFailure) return 'Не удалось выполнить запрос.';
  if (error.code == 'offline_mode' ||
      error.code == 'interactive_required' ||
      error.code == 'session_revoked' ||
      error.code == 'stale_session') {
    return error.message;
  }
  return switch (error.statusCode) {
    400 =>
      action == AccountAction.unlinkIdentity
          ? 'Не удалось отвязать аккаунт. Последний способ входа удалить нельзя.'
          : 'Проверьте введённые данные. Значение может быть занято или приглашение недействительно.',
    401 => 'Не удалось подтвердить доступ. Проверьте пароль и код; при необходимости войдите снова.',
    403 => 'Для этого действия нужен вход с паролем. Сервер отклонил запрос.',
    404 => 'Запись не найдена. Обновите данные.',
    409 => 'Состояние изменилось. Обновите данные.',
    429 =>
      'Слишком много запросов. Подождите${error.retryAfter == null ? '' : ' ${error.retryAfter!.inSeconds} с'} и повторите.',
    _ => 'Не удалось получить подтверждение сервера.',
  };
}
