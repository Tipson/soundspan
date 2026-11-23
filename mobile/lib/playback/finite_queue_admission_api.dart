import '../core/model/app_failure.dart';
import '../core/model/owner_key.dart';
import '../core/model/track_ref.dart';
import '../core/network/api_transport.dart';
import '../core/network/request_cancellation.dart';

enum FiniteQueueAdmissionState { allowed, denied, unavailable }

enum FiniteQueueAdmissionMode { authoritative, legacyExact, unavailable }

/// Server recording identity only. Display metadata never creates an identity.
final class FiniteQueueAdmissionReference {
  const FiniteQueueAdmissionReference({
    required this.source,
    required this.id,
    this.generationId,
  });
  final String source;
  final String id;
  final String? generationId;

  static FiniteQueueAdmissionReference? fromTrack(
    TrackRef ref, {
    String? generationId,
  }) => switch (ref) {
    LibraryTrackRef(:final libraryId) => FiniteQueueAdmissionReference(
      source: 'library',
      id: libraryId,
      generationId: generationId,
    ),
    YoutubeTrackRef(:final videoId) => FiniteQueueAdmissionReference(
      source: 'youtube',
      id: videoId,
      generationId: generationId,
    ),
    NativeTrackRef(:final recording) => FiniteQueueAdmissionReference(
      source: recording.provider.name,
      id: recording.id,
      generationId: generationId,
    ),
    UnavailableTrackRef() => null,
  };

  bool get valid {
    if (generationId != null &&
        (generationId!.isEmpty || generationId!.length > 128)) {
      return false;
    }
    if (id.isEmpty || id.length > 128) return false;
    return switch (source) {
      'library' => RegExp(r'^[A-Za-z0-9_-]{1,128}$').hasMatch(id),
      'youtube' => RegExp(r'^[A-Za-z0-9_-]{11}$').hasMatch(id),
      'vk' => RegExp(r'^-?\d{1,20}_\d{1,20}$').hasMatch(id),
      'yandex' =>
        RegExp(r'^\d{1,20}$').hasMatch(id) && RegExp(r'[1-9]').hasMatch(id),
      'tidal' =>
        RegExp(r'^[1-9]\d{0,19}$').hasMatch(id) &&
            (int.tryParse(id) ?? 9007199254740992) <= 9007199254740991,
      _ => false,
    };
  }

  Map<String, Object?> toJson() => {
    'source': source,
    'id': id,
    if (generationId != null) 'generationId': generationId,
  };
  @override
  bool operator ==(Object other) =>
      other is FiniteQueueAdmissionReference &&
      source == other.source &&
      id == other.id &&
      generationId == other.generationId;
  @override
  int get hashCode => Object.hash(source, id, generationId);
}

/// Request-local policy; never persisted as an identity or a preference.
final class FiniteQueueAdmissionResult {
  FiniteQueueAdmissionResult(
    this.mode,
    Iterable<FiniteQueueAdmissionState> states,
  ) : states = List.unmodifiable(states);
  factory FiniteQueueAdmissionResult.unavailable(int count) =>
      FiniteQueueAdmissionResult(
        FiniteQueueAdmissionMode.unavailable,
        List.filled(count, FiniteQueueAdmissionState.unavailable),
      );
  final FiniteQueueAdmissionMode mode;
  final List<FiniteQueueAdmissionState> states;
}

/// Finite read-only POST through the authenticated cancellable API boundary.
final class FiniteQueueAdmissionApi {
  const FiniteQueueAdmissionApi({required this.transport});
  final ApiTransport transport;

  Future<FiniteQueueAdmissionResult> admit(
    List<FiniteQueueAdmissionReference> references, {
    required SessionFence fence,
    required RequestCancellation cancellation,
  }) async {
    final refs = List<FiniteQueueAdmissionReference>.unmodifiable(references);
    final unavailable = FiniteQueueAdmissionResult.unavailable(refs.length);
    if (refs.isEmpty || refs.length > 100 || refs.any((ref) => !ref.valid)) {
      return unavailable;
    }
    try {
      final response = await cancellation.run(
        () => transport.send(
          ApiRequest(
            origin: fence.owner.serverOrigin,
            method: ApiMethod.post,
            path: '/api/personalized/queue-admission',
            body: {'references': refs.map((ref) => ref.toJson()).toList()},
            cancellation: cancellation,
          ),
          fence: fence,
        ),
      );
      cancellation.check();
      if (response.statusCode == 404) {
        return FiniteQueueAdmissionResult(
          FiniteQueueAdmissionMode.legacyExact,
          unavailable.states,
        );
      }
      response.requireSuccess();
      final body = response.data;
      if (body is! Map ||
          body['version'] != 1 ||
          body['appliesTo'] != 'recommended_future') {
        return unavailable;
      }
      final decisions = body['decisions'];
      if (decisions is! List || decisions.length != refs.length) {
        return unavailable;
      }
      final states = <FiniteQueueAdmissionState>[];
      for (var i = 0; i < refs.length; i++) {
        final decision = decisions[i];
        if (decision is! Map ||
            decision['source'] != refs[i].source ||
            decision['id'] != refs[i].id) {
          return unavailable;
        }
        final state = switch (decision['state']) {
          'allowed' => FiniteQueueAdmissionState.allowed,
          'denied' => FiniteQueueAdmissionState.denied,
          'unavailable' => FiniteQueueAdmissionState.unavailable,
          _ => null,
        };
        if (state == null) return unavailable;
        states.add(state);
      }
      return FiniteQueueAdmissionResult(
        FiniteQueueAdmissionMode.authoritative,
        states,
      );
    } on AppFailure catch (error) {
      if (error.statusCode == 404) {
        cancellation.check();
        return FiniteQueueAdmissionResult(
          FiniteQueueAdmissionMode.legacyExact,
          unavailable.states,
        );
      }
      return unavailable;
    } catch (_) {
      return unavailable;
    }
  }
}
