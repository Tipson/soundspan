import 'dart:typed_data';

import '../core/model/app_failure.dart';
import '../core/model/owner_key.dart';
import '../core/network/api_transport.dart';
import '../core/network/redirect_policy.dart';
import '../core/network/request_cancellation.dart';
import '../core/session/session_authority.dart';
import 'track_audio_versions.dart';

export 'track_audio_versions.dart' show TrackAudioTarget;

/// Immutable IDs for the draft and published alternate audio for a track.
final class TrackAudioAdminState {
  const TrackAudioAdminState({
    required this.draftId,
    required this.publishedId,
  });

  final String? draftId;
  final String? publishedId;

  factory TrackAudioAdminState._fromJson(Object? data) {
    if (data is! Map ||
        !data.containsKey('draftId') ||
        !data.containsKey('publishedId')) {
      throw _invalidState;
    }
    return TrackAudioAdminState(
      draftId: _readVersionId(data['draftId']),
      publishedId: _readVersionId(data['publishedId']),
    );
  }

  static String? _readVersionId(Object? value) {
    if (value == null) return null;
    if (value is String &&
        RedirectPolicy.audioVersionIdPattern.hasMatch(value)) {
      return value;
    }
    throw _invalidState;
  }

  static const _invalidState = AppFailure(
    code: 'invalid_track_audio_state',
    message: 'Некорректный ответ сервера о версиях аудио',
  );
}

/// Manages alternate audio for exact tracks using the server's administrator role.
final class TrackAudioAdmin {
  const TrackAudioAdmin({required this.transport, required this.authority});

  final ApiTransport transport;
  final SessionAuthority authority;

  static const maxUploadBytes = ApiRequest.maxTrackAudioDraftBytes;

  Future<TrackAudioAdminState> read(
    TrackAudioTarget target,
    SessionFence fence, {
    RequestCancellation? cancellation,
  }) => _send(
    ApiRequest(
      origin: fence.owner.serverOrigin,
      method: ApiMethod.get,
      path: '${target.apiPath}/manage',
      cancellation: cancellation,
    ),
    fence,
  );

  /// Stages a bounded MP3 draft. The server validates its audio contents.
  Future<TrackAudioAdminState> upload(
    TrackAudioTarget target,
    SessionFence fence,
    Uint8List bytes, {
    RequestCancellation? cancellation,
  }) async => _send(
    ApiRequest(
      origin: fence.owner.serverOrigin,
      method: ApiMethod.put,
      path: '${target.apiPath}/draft',
      trackAudioDraftBody: bytes,
      cancellation: cancellation,
    ),
    fence,
  );

  /// Publishes only the draft ID the administrator selected.
  Future<TrackAudioAdminState> publish(
    TrackAudioTarget target,
    SessionFence fence,
    String expectedVersionId, {
    RequestCancellation? cancellation,
  }) async => _send(
    ApiRequest(
      origin: fence.owner.serverOrigin,
      method: ApiMethod.post,
      path: '${target.apiPath}/publish',
      body: {'versionId': _versionId(expectedVersionId)},
      cancellation: cancellation,
    ),
    fence,
  );

  /// Withdraws only the publication ID the administrator selected.
  Future<TrackAudioAdminState> withdraw(
    TrackAudioTarget target,
    SessionFence fence,
    String expectedVersionId, {
    RequestCancellation? cancellation,
  }) async => _send(
    ApiRequest(
      origin: fence.owner.serverOrigin,
      method: ApiMethod.delete,
      path: '${target.apiPath}/published/${_versionId(expectedVersionId)}',
      cancellation: cancellation,
    ),
    fence,
  );

  Future<TrackAudioAdminState> _send(
    ApiRequest request,
    SessionFence fence,
  ) async {
    await authority.assertCurrent(fence);
    request.cancellation?.check();
    final response = await transport.send(request, fence: fence);
    await authority.assertCurrent(fence);
    request.cancellation?.check();
    response.requireSuccess();
    return TrackAudioAdminState._fromJson(response.data);
  }

  static String _versionId(String id) {
    if (!RedirectPolicy.audioVersionIdPattern.hasMatch(id)) {
      throw const AppFailure(
        code: 'invalid_track_audio_version',
        message: 'Некорректная версия аудио',
      );
    }
    return id;
  }
}
