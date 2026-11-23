import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import '../../core/model/app_failure.dart';

/// Common copy action and the small Android text/plain chooser/browser bridge.
class NativeShareActions {
  const NativeShareActions();
  static const _channel = MethodChannel('soundspan/share');
  bool get supportsNative =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.android;
  void _validate(Uri url) {
    if (url.scheme != 'https' ||
        url.host.isEmpty ||
        url.userInfo.isNotEmpty ||
        url.hasQuery ||
        url.hasFragment ||
        !RegExp(r'^/share/[a-f0-9]{64}$').hasMatch(url.path) ||
        url.toString().contains('%')) {
      throw _failure;
    }
  }

  Future<void> copy(Uri url) async {
    _validate(url);
    await Clipboard.setData(ClipboardData(text: url.toString()));
  }

  Future<void> share(Uri url) => _open('share', url);
  Future<void> open(Uri url) => _open('open', url);
  Future<void> _open(String method, Uri url) async {
    _validate(url);
    if (!supportsNative) throw _failure;
    try {
      final result = await _channel.invokeMethod<String>(method, {
        'origin': url.origin,
        'url': url.toString(),
      });
      if (result != 'opened') throw _failure;
    } catch (_) {
      throw _failure;
    }
  }
}

const _failure = AppFailure(
  code: 'share_unavailable',
  message: 'Не удалось открыть действие со ссылкой. Можно скопировать ссылку.',
);
