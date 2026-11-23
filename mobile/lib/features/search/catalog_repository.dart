import '../../core/model/owner_key.dart';

import 'dart:async';

import '../../core/network/api_transport.dart';
import '../../core/network/network_policy.dart';
import '../../core/session/session_authority.dart';
import '../library/library_models.dart';

/// One permanent owner scope with admission before and after every HTTP call.
abstract class CatalogRepository {
  CatalogRepository({
    required this.transport,
    required this.authority,
    required this.fence,
    required this.networkPolicy,
  }) {
    _session = authority.changes.listen((_) {
      if (!authority.isCurrent(fence)) _revoked = true;
    });
  }
  final ApiTransport transport;
  final SessionAuthority authority;
  final SessionFence fence;
  final NetworkPolicy networkPolicy;
  late final StreamSubscription<SessionState> _session;
  bool _revoked = false;
  bool get isCurrent {
    if (!authority.isCurrent(fence)) _revoked = true;
    return !_revoked;
  }

  Future<void> guard() async {
    if (!isCurrent) throw collectionStaleSession;
    await authority.assertCurrent(fence);
    if (!isCurrent) throw collectionStaleSession;
  }

  Future<Object?> get(
    String path, [
    Map<String, String> query = const {},
  ]) async {
    networkPolicy.requireNetwork();
    await guard();
    networkPolicy.requireNetwork();
    final response = await transport.send(
      ApiRequest(
        origin: fence.owner.serverOrigin,
        method: ApiMethod.get,
        path: path,
        query: query,
      ),
      fence: fence,
    );
    await guard();
    response.requireSuccess();
    return response.data;
  }

  void dispose() {
    _revoked = true;
    unawaited(_session.cancel());
  }
}
