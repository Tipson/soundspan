import 'dart:math';

import '../../core/model/app_failure.dart';
import '../../core/network/api_transport.dart';
import '../../core/storage/owner_store.dart';
import 'owner_endpoint.dart';
import 'share_models.dart';

const sharePending = AppFailure(
  code: 'share_pending',
  message: 'Результат создания ссылки неизвестен. Проверьте мои ссылки перед новой попыткой: повтор может создать дубликат.',
);

final class ShareRepository extends OwnerEndpoint {
  ShareRepository({
    required super.transport,
    required super.authority,
    required super.fence,
    required super.networkPolicy,
    required this.store,
  });
  final OwnerStore store;
  Future<String?> pendingAttempt() async {
    await guard();
    final row = await store.transaction(
      fence,
      (tx) => tx.read('shares', 'creation'),
    );
    await guard();
    if (row == null) return null;
    if (row.length != 5 ||
        row['version'] != 1 ||
        row['uncertain'] != true ||
        !ShareResourceKind.values.any((k) => k.name == row['resourceType'])) {
      throw sharePending;
    }
    capabilityId(row['resourceId']);
    return capabilityId(row['attemptId']);
  }

  Future<List<ShareLink>> list({bool Function()? current}) async {
    final rows = await request('/api/share-links', current: current);
    if (rows is! List) throw invalidCapability;
    final result = rows.map((r) => ShareLink.decode(r, fence.owner)).toList();
    if (result.map((l) => l.id).toSet().length != result.length) {
      throw invalidCapability;
    }
    return List.unmodifiable(result);
  }

  Future<void> _clearAttempt(String attempt, {bool Function()? current}) async {
    await authority.assertCurrent(fence);
    if (current?.call() == false) throw staleCapability;
    await store.transaction(fence, (tx) async {
      final row = await tx.read('shares', 'creation');
      if (row?['attemptId'] == attempt) await tx.remove('shares', 'creation');
    });
  }

  /// Explicit user acknowledgement after viewing the server list. Absence or
  /// multiple matching resources in GET never proves a lost create failed.
  Future<void> acknowledgeUncertainty(
    String attempt, {
    required bool Function() current,
  }) async {
    await guard(current);
    await _clearAttempt(attempt, current: current);
  }

  Future<ShareLink> create(ShareDraft draft, {bool Function()? current}) async {
    final payload = draft.payload(DateTime.now());
    await guard(current);
    networkPolicy.requireNetwork();
    final random = Random.secure();
    final attempt = List.generate(
      16,
      (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'),
    ).join();
    var admitted = false;
    await store.transaction(fence, (tx) async {
      if (await tx.read('shares', 'creation') != null) throw sharePending;
      await tx.write('shares', 'creation', {
        'version': 1,
        'attemptId': attempt,
        'resourceType': draft.resource.kind.name,
        'resourceId': draft.resource.id,
        'uncertain': true,
      });
    });
    try {
      final raw = await request(
        '/api/share-links',
        method: ApiMethod.post,
        body: payload,
        current: current,
        admitted: () => admitted = true,
      );
      final link = ShareLink.decode(raw, fence.owner);
      if (link.kind != draft.resource.kind ||
          link.resourceId != draft.resource.id) {
        throw invalidCapability;
      }
      await _clearAttempt(attempt);
      return link;
    } catch (error) {
      final refused =
          error is AppFailure &&
          error.statusCode != null &&
          error.statusCode! >= 400 &&
          error.statusCode! < 500;
      if (!admitted || refused) await _clearAttempt(attempt);
      rethrow;
    }
  }

  Future<void> revoke(String id, {required bool Function() current}) async {
    final dto = capabilityObject(
      await request(
        '/api/share-links/${capabilityId(id)}',
        method: ApiMethod.delete,
        current: current,
      ),
    );
    if (dto['success'] != true) throw invalidCapability;
  }
}
