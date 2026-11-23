import '../../core/network/api_transport.dart';
import '../shares/owner_endpoint.dart';
import 'inbox_models.dart';

final class InboxPage {
  const InboxPage(this.entries, this.skipped);
  final List<InboxEntry> entries;
  final int skipped;
}

final class InboxRepository extends OwnerEndpoint {
  InboxRepository({
    required super.transport,
    required super.authority,
    required super.fence,
    required super.networkPolicy,
  });
  Future<InboxPage> page({bool Function()? current}) async {
    final raw = await request('/api/notifications', current: current);
    if (raw is! List) throw invalidCapability;
    final rows = <InboxEntry>[], ids = <String>{};
    var skipped = 0;
    for (final row in raw.take(100)) {
      try {
        final entry = InboxEntry.decode(row);
        if (!ids.add(entry.id)) {
          skipped++;
          continue;
        }
        if (!entry.cleared) rows.add(entry);
      } catch (_) {
        skipped++;
      }
    }
    return InboxPage(List.unmodifiable(rows), skipped);
  }

  Future<int> unread({bool Function()? current}) async {
    final raw = capabilityObject(
      await request('/api/notifications/unread-count', current: current),
    )['count'];
    if (raw is! int || raw < 0) throw invalidCapability;
    return raw;
  }

  Future<void> mutate(
    InboxAction action, {
    String? id,
    required bool Function() current,
  }) async {
    final path = switch (action) {
      InboxAction.read => '${capabilityId(id)}/read',
      InboxAction.readAll => 'read-all',
      InboxAction.clear => '${capabilityId(id)}/clear',
      InboxAction.clearAll => 'clear-all',
    };
    final dto = capabilityObject(
      await request(
        '/api/notifications/$path',
        method: ApiMethod.post,
        current: current,
      ),
    );
    if (dto['success'] != true) throw invalidCapability;
  }
}
