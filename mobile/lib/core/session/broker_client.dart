import 'dart:async';

import 'package:flutter/services.dart';

import '../model/app_failure.dart';
import '../model/owner_key.dart';
import 'session_authority.dart';
import 'session_broker_protocol.dart';

abstract interface class BrokerTransport {
  Stream<Object?> get events;
  Future<Object?> invoke(Map<String, Object?> request);
  Future<void> close();
}

/// One instance per client engine; the native plugin assigns engine identity.
final class MethodChannelBrokerTransport implements BrokerTransport {
  MethodChannelBrokerTransport() {
    _channel.setMethodCallHandler((call) async {
      if (call.method == 'event') _events.add(call.arguments);
    });
  }
  final _channel = const MethodChannel('soundspan/session_client');
  final _events = StreamController<Object?>.broadcast(sync: true);
  @override
  Stream<Object?> get events => _events.stream;
  @override
  Future<Object?> invoke(Map<String, Object?> request) =>
      _channel.invokeMethod<Object?>('rpc', request);
  @override
  Future<void> close() async {
    try {
      await _channel.invokeMethod<void>('release');
    } finally {
      _channel.setMethodCallHandler(null);
      await _events.close();
    }
  }
}

final class BrokerClient {
  BrokerClient(this.transport) {
    _subscription = transport.events.listen(
      _receive,
      onError: (Object _) => failClosed(),
      onDone: failClosed,
    );
  }
  final BrokerTransport transport;
  late final StreamSubscription<Object?> _subscription;
  final _changes = StreamController<SessionState>.broadcast(sync: true);
  SessionState state = const SessionState.signedOut();
  int _sequence = -1;
  bool _closed = false;
  bool _attached = false;
  bool _awaitingRevocation = false;
  Stream<SessionState> get changes => _changes.stream;
  static const unavailable = AppFailure(
    code: 'broker_unavailable',
    message: 'Сессия недоступна',
    retryable: true,
  );

  void _receive(Object? value) {
    if (_closed) return;
    try {
      final event = BrokerCodec.event(value);
      if (event.sequence <= _sequence) return;
      _sequence = event.sequence;
      if (_awaitingRevocation &&
          event.state.status != SessionStatus.signedOut) {
        return;
      }
      if (event.state.status == SessionStatus.signedOut) {
        _awaitingRevocation = false;
      }
      state = event.state;
      _changes.add(state);
    } on AppFailure {
      failClosed();
    }
  }

  void clearLocal() {
    _awaitingRevocation = true;
    state = const SessionState.signedOut();
    if (!_changes.isClosed) _changes.add(state);
  }

  void failClosed() {
    _closed = true;
    clearLocal();
  }

  Future<void> attach(ClientRole role, {SessionFence? expectedFence}) async {
    if (_attached) throw BrokerCodec.invalid;
    final snapshot = await call('attach', {
      'role': role.name,
      'expectedFence': expectedFence == null
          ? null
          : BrokerCodec.encodeFence(expectedFence),
    });
    _receive(snapshot);
    if (_closed) throw unavailable;
    _attached = true;
  }

  Future<Object?> call(
    String method, [
    Map<String, Object?> args = const {},
  ]) async {
    if (_closed) throw unavailable;
    try {
      final raw = await transport
          .invoke({'v': 1, 'method': method, 'args': args})
          .timeout(const Duration(seconds: 45));
      if (_closed) throw unavailable;
      if (raw is! Map ||
          raw['v'] is! int ||
          raw['v'] != 1 ||
          raw['ok'] is! bool) {
        throw BrokerCodec.invalid;
      }
      if (raw['ok'] == true) {
        return BrokerCodec.object(raw, {'v', 'ok', 'value'})['value'];
      }
      final errorValue = BrokerCodec.object(raw, {'v', 'ok', 'error'})['error'];
      final hasDelay =
          errorValue is Map && errorValue.containsKey('retryAfterMillis');
      final error = BrokerCodec.object(errorValue, {
        'code',
        'retryable',
        'statusCode',
        if (hasDelay) 'retryAfterMillis',
      });
      final status = error['statusCode'] == null
          ? null
          : BrokerCodec.number(error['statusCode']);
      final delay = error['retryAfterMillis'];
      if (delay != null &&
          (delay is! int ||
              delay < 0 ||
              delay > 999999999999000 ||
              (status != 429 && status != 503))) {
        throw BrokerCodec.invalid;
      }
      throw AppFailure(
        code: BrokerCodec.text(error['code']),
        message: 'Операция сессии не выполнена',
        retryable: BrokerCodec.boolean(error['retryable']),
        statusCode: status,
        retryAfter: delay == null ? null : Duration(milliseconds: delay as int),
      );
    } on PlatformException {
      failClosed();
      throw unavailable;
    } on MissingPluginException {
      failClosed();
      throw unavailable;
    } on TimeoutException {
      failClosed();
      throw unavailable;
    }
  }

  Future<void> close() async {
    failClosed();
    await _subscription.cancel();
    await transport.close();
    await _changes.close();
  }
}
