import 'dart:async';
import 'dart:io';

import 'package:audio_service/audio_service.dart';
import 'package:path_provider/path_provider.dart';

import '../core/network/api_transport.dart';
import '../core/network/dart_api_transport.dart';
import '../core/model/owner_key.dart';
import '../core/session/broker_client.dart';
import '../core/session/native_auth_repository_proxy.dart';
import '../core/session/native_session_authority_proxy.dart';
import '../core/session/session_broker_protocol.dart';
import '../core/storage/sqlite_owner_store.dart';
import '../core/storage/sqlite_session_store.dart';
import '../playback/playback_engine.dart';
import '../playback/service_playback_controller.dart';
import '../playback/soundspan_audio_handler.dart';
import 'app_environment.dart';
import 'bootstrap_preferences.dart';
import 'owner_services.dart';

/// One UI/audio engine's process resources. Widgets never construct or close it.
final class NativeAppResources {
  NativeAppResources._(
    this.supportDirectory,
    this.sessions,
    this.authority,
    this.auth,
    this.preferences,
    this._origin,
  ) {
    store = SqliteOwnerStore(sessions);
    transport = PublicEntryTransport(
      DartApiTransport(client: _publicJson, authority: authority),
    );
    environment = AppEnvironment(
      authority: authority,
      auth: auth,
      origin: origin,
      createPlayback: _createPlayback,
      processReady: _activatePlayback,
      createOwner: (fence, playback) async {
        await preferences.saveOrigin(fence.owner.serverOrigin);
        return NativeOwnerServices.create(
          authority: authority,
          store: store,
          fence: fence,
          playback: playback,
          supportDirectory: supportDirectory,
        );
      },
      release: close,
    );
  }
  final Directory supportDirectory;
  final SqliteSessionStore sessions;
  final NativeSessionAuthorityProxy authority;
  final NativeAuthRepositoryProxy auth;
  final BootstrapPreferences preferences;
  late final SqliteOwnerStore store;
  late final ApiTransport transport;
  late final AppEnvironment environment;
  final _publicJson = DartJsonHttpClient();
  Uri _origin;
  Uri get origin => authority.state.fence?.owner.serverOrigin ?? _origin;
  bool _playbackCreated = false;
  SoundspanAudioHandler? _handler;
  Future<void>? _activation;
  Future<void>? _closing;

  static Future<NativeAppResources> open({required Uri defaultOrigin}) async {
    final fallback = normalizeServerOrigin(defaultOrigin);
    final directory = await getApplicationSupportDirectory();
    await directory.create(recursive: true);
    // Android path_provider may return /data/user/0 while IO resolves /data/data.
    final support = Directory(await directory.resolveSymbolicLinks());
    SqliteSessionStore? sessions;
    BrokerClient? client;
    try {
      sessions = await SqliteSessionStore.open();
      final databaseParent = await File(sessions.database.path).parent
          .resolveSymbolicLinks();
      if (databaseParent != support.path) {
        throw const FileSystemException(
          'Unexpected session database directory',
        );
      }
      client = BrokerClient(MethodChannelBrokerTransport());
      final authority = await NativeSessionAuthorityProxy.attach(
        client,
        ClientRole.ui,
      );
      final preferences = BootstrapPreferences(support);
      final persisted = await sessions.read();
      final hint = await preferences.readOrigin();
      final selected =
          authority.state.fence?.owner.serverOrigin ??
          (!persisted.tombstone ? persisted.owner?.serverOrigin : null) ??
          hint ??
          fallback;
      return NativeAppResources._(
        support,
        sessions,
        authority,
        NativeAuthRepositoryProxy(client),
        preferences,
        selected,
      );
    } catch (_) {
      try {
        await client?.close();
      } finally {
        await sessions?.close();
      }
      rethrow;
    }
  }

  Future<void> rememberOrigin(Uri value) async {
    final normalized = normalizeServerOrigin(value);
    await preferences.saveOrigin(normalized);
    _origin = normalized;
  }

  Future<ServicePlaybackController> _createPlayback(
    PrepareAudio prepare,
  ) async {
    if (_playbackCreated || _closing != null) {
      throw StateError('Process playback already initialized');
    }
    _playbackCreated = true;
    final concrete = await SoundspanAudioHandler.create(
      authority: authority,
      prepare: prepare,
    );
    if (_closing != null) {
      await concrete.dispose();
      throw StateError('Process resources already closed');
    }
    _handler = concrete;
    return ServicePlaybackController(concrete);
  }

  Future<void> _activatePlayback() => _activation ??= _startService();
  Future<void> _startService() async {
    final concrete = _handler;
    if (concrete == null || _closing != null) {
      throw StateError('Process playback is not available');
    }
    // AppComposition owns this handler, including cleanup if configure fails.
    // Do not expose native callbacks before its restored owner is admitted.
    await AudioService.init<SoundspanAudioHandler>(
      builder: () => concrete,
      config: const AudioServiceConfig(
        androidNotificationChannelId: 'ru.agentik007.soundspan.playback',
        androidNotificationChannelName: 'Воспроизведение музыки',
        androidStopForegroundOnPause: false,
      ),
    );
  }

  Future<void> close() => _closing ??= _finishClose();
  Future<void> _finishClose() async {
    try {
      await _publicJson.close();
      await preferences.close();
    } finally {
      try {
        await authority.close();
      } finally {
        await sessions.close();
      }
    }
  }
}

/// Process bootstrap has no owner policy and therefore admits only public auth.
final class PublicEntryTransport implements ApiTransport {
  PublicEntryTransport(this._inner);
  final ApiTransport _inner;
  @override
  Future<ApiResponse> send(ApiRequest request, {SessionFence? fence}) async {
    if (request.authenticated || fence != null) throw invalidTarget;
    return _inner.send(request);
  }
}
