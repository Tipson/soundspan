import 'dart:async';

import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/session/credential_vault.dart';
import 'package:soundspan/core/session/persisted_session_store.dart';

final origin = Uri.parse('https://music.example');
final owner = OwnerKey(serverOrigin: origin, userId: 'alice');

final class MemoryVault implements CredentialVault {
  StoredCredentials? value;
  int writes = 0;
  Completer<void>? writeGate;
  Completer<void>? writeStarted;
  bool failAfterWrite = false;
  Completer<void>? readGate;
  Completer<void>? readStarted;

  @override
  Future<StoredCredentials?> read(Uri origin) async {
    final snapshot = value?.fence.owner.serverOrigin == origin ? value : null;
    final gate = readGate;
    readGate = null;
    readStarted?.complete();
    readStarted = null;
    await gate?.future;
    return snapshot;
  }

  @override
  Future<void> write(StoredCredentials credentials) async {
    writes++;
    writeStarted?.complete();
    await writeGate?.future;
    value = credentials;
    if (failAfterWrite) throw StateError('injected storage write failure');
  }

  @override
  Future<void> delete(OwnerKey owner) async {
    if (value?.fence.owner == owner) value = null;
  }
}

final class MemoryFenceStore implements PersistedSessionStore {
  PersistedSession value = const PersistedSession(epoch: 0, tombstone: true);
  Completer<void>? readGate;
  Completer<void>? readStarted;
  @override
  Future<PersistedSession> read() async {
    final snapshot = value;
    final gate = readGate;
    readGate = null;
    readStarted?.complete();
    readStarted = null;
    await gate?.future;
    return snapshot;
  }

  @override
  Future<PersistedSession> advance(OwnerKey? owner) async =>
      value = PersistedSession(
        epoch: value.epoch + 1,
        owner: owner,
        tombstone: owner == null,
      );
}

final class ScriptedJsonClient implements JsonHttpClient {
  ScriptedJsonClient(this.handler);
  final Future<ApiResponse> Function(ApiRequest, String?) handler;
  int calls = 0;
  @override
  Future<ApiResponse> send(ApiRequest request, {String? accessToken}) {
    calls++;
    return handler(request, accessToken);
  }
}
