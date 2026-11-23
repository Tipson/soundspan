import '../core/model/owner_key.dart';
import '../core/network/api_transport.dart';
import '../core/session/auth_repository.dart';
import '../core/session/session_authority.dart';
import '../playback/playback_controller.dart';
import '../playback/playback_engine.dart';

/// One admitted owner graph. Every close must synchronously revoke admission
/// and drain its own work before a replacement scope is constructed.
abstract interface class AppOwnerScope {
  SessionFence get fence;
  Future<PreparedAudio> prepare(QueueEntry entry, SessionFence fence);
  Future<void> close();
}

/// Platform resources are injected once; screen rebuilds never construct them.
final class AppEnvironment {
  AppEnvironment({
    required this.authority,
    required this.auth,
    required Uri origin,
    required this.createPlayback,
    required this.createOwner,
    this.processReady,
    this.release,
  }) : origin = normalizeServerOrigin(origin);

  final SessionAuthority authority;
  final AuthRepository auth;
  final Uri origin;
  final Future<PlaybackController> Function(PrepareAudio) createPlayback;
  final Future<AppOwnerScope> Function(SessionFence, PlaybackController)
  createOwner;

  /// Activates process integrations after the initial owner is fully admitted.
  final Future<void> Function()? processReady;
  final Future<void> Function()? release;
}
