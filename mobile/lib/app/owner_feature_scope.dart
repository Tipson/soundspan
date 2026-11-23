import 'dart:async';

import '../core/model/owner_key.dart';
import '../playback/playback_controller.dart';
import '../playback/playback_engine.dart';
import 'app_environment.dart';

/// Revokes every feature before awaiting any cleanup, then drains all of them.
final class OwnerFeatureLifetime {
  final _retire = <FutureOr<void> Function()>[];
  bool _open = true;
  Future<void>? _closing;
  bool get isOpen => _open;
  void Function() add(FutureOr<void> Function() close) {
    if (!_open) throw StateError('Owner features are closed');
    _retire.add(close);
    return () => _retire.remove(close);
  }

  Future<void> close() {
    if (_closing != null) return _closing!;
    _open = false;
    final completion = Completer<void>();
    _closing = completion.future;
    final closers = _retire.reversed.toList();
    _retire.clear();
    final pending = [for (final close in closers) Future<void>.sync(close)];
    completion.complete(Future.wait(pending).then<void>((_) {}));
    return completion.future;
  }
}

/// Native owner remains alive until UI feature admission and work are drained.
final class OwnerFeatureScope<T> implements AppOwnerScope {
  OwnerFeatureScope({
    required this.native,
    required this.session,
    required this.closeFeatures,
  });
  final AppOwnerScope native;
  final T session;
  final Future<void> Function() closeFeatures;
  Future<void>? _closing;
  @override
  SessionFence get fence => native.fence;
  @override
  Future<PreparedAudio> prepare(QueueEntry entry, SessionFence fence) =>
      native.prepare(entry, fence);
  @override
  Future<void> close() => _closing ??= _close();
  Future<void> _close() async {
    try {
      await closeFeatures();
    } finally {
      await native.close();
    }
  }
}
