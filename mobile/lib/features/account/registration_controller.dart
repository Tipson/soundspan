import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../core/model/app_failure.dart';
import '../../core/network/api_transport.dart';
import '../../core/network/network_policy.dart';
import '../../core/session/session_authority.dart';
import 'account_controller.dart';

/// Registration creates an account but never adopts the returned bearer tokens.
/// The existing broker login is the only entrance to an authenticated session.
class RegistrationController extends ChangeNotifier {
  RegistrationController({
    required this.transport,
    required this.authority,
    required this.networkPolicy,
    required this.origin,
    this.enabled = true,
  }) {
    _revoked = authority.state.fence != null;
    _subscription = authority.changes.listen((_) {
      _revoked = true;
      message = 'Сеанс изменился. Откройте регистрацию заново.';
      _emit();
    });
  }
  final ApiTransport transport;
  final SessionAuthority authority;
  final NetworkPolicy networkPolicy;
  final Uri origin;
  final bool enabled;
  late final StreamSubscription<Object?> _subscription;
  bool _disposed = false, _revoked = false;
  bool busy = false, uncertain = false, completed = false;
  bool get active =>
      !_disposed && !_revoked && enabled && authority.state.fence == null;
  String? message;
  DateTime? _retryAt;
  Future<bool> register(Map<String, Object?> input) async {
    if (!active ||
        busy ||
        uncertain ||
        completed ||
        (_retryAt != null && DateTime.now().isBefore(_retryAt!))) {
      return false;
    }
    busy = true;
    message = null;
    _emit();
    try {
      networkPolicy.requireNetwork();
      final response = await transport.send(
        ApiRequest(
          origin: origin,
          method: ApiMethod.post,
          path: '/api/auth/register',
          authenticated: false,
          body: input,
        ),
      );
      if (!active) return false;
      response.requireSuccess();
      final result = response.data;
      if (result is! Map ||
          result['user'] is! Map ||
          (result['user'] as Map)['id'] is! String) {
        throw const AppFailure(
          code: 'invalid_account_data',
          message: 'Некорректный ответ сервера.',
        );
      }
      completed = true;
      message = 'Аккаунт создан. Войдите с выбранным паролем.';
      return true;
    } catch (error) {
      if (!active) return false;
      final failure = error is AppFailure ? error : null;
      if (failure?.code == 'offline_mode') {
        message = failure!.message;
      } else if (failure?.statusCode != null &&
          failure!.statusCode! >= 400 &&
          failure.statusCode! < 500) {
        message = accountError(failure);
        if (failure.retryAfter != null) {
          _retryAt = DateTime.now().add(failure.retryAfter!);
        }
      } else {
        uncertain = true;
        message = 'Ответ регистрации потерян. Аккаунт мог быть создан: вернитесь ко входу и проверьте выбранные данные. Повторная регистрация не отправлена.';
      }
      return false;
    } finally {
      busy = false;
      _emit();
    }
  }

  void _emit() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _subscription.cancel();
    super.dispose();
  }
}
