import '../model/app_failure.dart';
import '../model/owner_key.dart';
import 'session_authority.dart';

enum ClientRole { ui, playback, download }

final class SessionEvent {
  const SessionEvent(this.sequence, this.state);
  final int sequence;
  final SessionState state;
}

/// Closed, versioned wire schema. Never include payloads in protocol errors.
abstract final class BrokerCodec {
  static const invalid = AppFailure(
    code: 'broker_protocol',
    message: 'Некорректный ответ сессии',
  );
  static Map<String, Object?> object(Object? value, Set<String> keys) {
    if (value is! Map ||
        value.keys.any((k) => k is! String) ||
        value.length != keys.length ||
        !keys.every(value.containsKey)) {
      throw invalid;
    }
    return Map<String, Object?>.from(value);
  }

  static String text(Object? value) {
    if (value is! String || value.isEmpty || value.length > 65536) {
      throw invalid;
    }
    return value;
  }

  static int number(Object? value, {int minimum = 0}) {
    if (value is! int || value < minimum) throw invalid;
    return value;
  }

  static bool boolean(Object? value) {
    if (value is! bool) throw invalid;
    return value;
  }

  static Map<String, Object?> encodeOwner(OwnerKey owner) => {
    'origin': owner.serverOrigin.toString(),
    'userId': owner.userId,
  };
  static OwnerKey owner(Object? value) {
    final data = object(value, {'origin', 'userId'});
    try {
      return OwnerKey(
        serverOrigin: Uri.parse(text(data['origin'])),
        userId: text(data['userId']),
      );
    } on ArgumentError {
      throw invalid;
    } on FormatException {
      throw invalid;
    }
  }

  static Map<String, Object?> encodeFence(SessionFence fence) => {
    'owner': encodeOwner(fence.owner),
    'epoch': fence.epoch,
  };
  static SessionFence fence(Object? value) {
    final data = object(value, {'owner', 'epoch'});
    return SessionFence(
      owner: owner(data['owner']),
      epoch: number(data['epoch'], minimum: 1),
    );
  }

  static Map<String, Object?> encodeStamp(AuthStamp stamp) => {
    'fence': encodeFence(stamp.fence),
    'tokenRevision': stamp.tokenRevision,
  };
  static AuthStamp stamp(Object? value) {
    final data = object(value, {'fence', 'tokenRevision'});
    return AuthStamp(
      fence: fence(data['fence']),
      tokenRevision: number(data['tokenRevision'], minimum: 1),
    );
  }

  static Map<String, Object?> encodeState(SessionState state) => {
    'status': state.status.name,
    'fence': state.fence == null ? null : encodeFence(state.fence!),
    'tokenRevision': state.tokenRevision,
  };
  static SessionState state(Object? value) {
    final data = object(value, {'status', 'fence', 'tokenRevision'});
    final status = SessionStatus.values
        .where((s) => s.name == data['status'])
        .firstOrNull;
    if (status == null) throw invalid;
    final parsedFence = data['fence'] == null ? null : fence(data['fence']);
    final revision = number(data['tokenRevision']);
    if (status == SessionStatus.signedOut
        ? parsedFence != null || revision != 0
        : parsedFence == null || revision < 1) {
      throw invalid;
    }
    return SessionState(
      status: status,
      fence: parsedFence,
      tokenRevision: revision,
    );
  }

  static SessionEvent event(Object? value) {
    final data = object(value, {'v', 'sequence', 'state'});
    if (data['v'] is! int || data['v'] != 1) throw invalid;
    return SessionEvent(number(data['sequence']), state(data['state']));
  }

  static Map<String, Object?> encodeEvent(int sequence, SessionState state) => {
    'v': 1,
    'sequence': sequence,
    'state': encodeState(state),
  };
}
