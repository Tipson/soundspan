import 'dart:async';

/// Per-operation cancellation. Listeners run synchronously, including when a
/// listener is attached after cancellation. check() throws the domain failure.
abstract interface class RequestCancellation {
  void check();
  void Function() listen(void Function() listener);
}

extension CancellableRequestWait on RequestCancellation {
  /// Rejects the caller promptly; the operation must also check before any
  /// side effect after an await. Socket owners attach their own close listener.
  Future<T> run<T>(Future<T> Function() operation) async {
    check();
    final rejected = Completer<T>();
    final remove = listen(() {
      try {
        check();
      } catch (error, stack) {
        if (!rejected.isCompleted) rejected.completeError(error, stack);
      }
    });
    try {
      final result = await Future.any<T>([
        Future<T>.sync(operation),
        rejected.future,
      ]);
      check();
      return result;
    } finally {
      remove();
    }
  }
}
