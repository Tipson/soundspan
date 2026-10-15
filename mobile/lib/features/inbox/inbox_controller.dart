import '../shares/owner_endpoint.dart';
import 'inbox_models.dart';
import 'inbox_repository.dart';

final class InboxController extends MemoryFeatureController {
  InboxController(InboxRepository super.endpoint);
  InboxRepository get repository => endpoint as InboxRepository;
  List<InboxEntry> _entries = const [];
  List<InboxEntry> get entries => isCurrent ? _entries : const [];
  int unread = 0, skipped = 0;
  bool needsRefresh = false;
  @override
  void clearData() {
    _entries = const [];
    unread = 0;
    skipped = 0;
  }

  Future<void> _read({bool Function()? current}) async {
    final page = await repository.page(current: current);
    final count = await repository.unread(current: current);
    if (isCurrent && current?.call() != false) {
      _entries = page.entries;
      unread = count;
      skipped = page.skipped;
      needsRefresh = false;
    }
  }

  Future<void> load({bool Function()? current}) => work(() async {
    await _read(current: current);
    if (isCurrent) message = null;
  });
  Future<void> mutate(
    InboxAction action, {
    String? id,
    required bool Function() current,
  }) => work(() async {
    if (needsRefresh || (id != null && !_entries.any((e) => e.id == id))) {
      throw staleCapability;
    }
    var acknowledged = false;
    try {
      await repository.mutate(action, id: id, current: current);
      acknowledged = true;
      if (!isCurrent) return;
      switch (action) {
        case InboxAction.read:
          _entries = _entries
              .map((e) => e.id == id ? e.markRead() : e)
              .toList();
        case InboxAction.readAll:
          _entries = _entries.map((e) => e.markRead()).toList();
          unread = 0;
        case InboxAction.clear:
          _entries = _entries.where((e) => e.id != id).toList();
        case InboxAction.clearAll:
          _entries = const [];
          unread = 0;
      }
      message = 'Действие выполнено на сервере.';
      if (current()) await _read(current: current);
    } catch (_) {
      if (isCurrent) {
        needsRefresh = true;
        if (!acknowledged) {
          message =
              'Результат неизвестен. Обновите входящие перед новым действием.';
        }
      }
      rethrow;
    }
  });
  Future<void> open(
    InboxEntry entry,
    Future<void> Function(InboxDestination) navigate, {
    required bool Function() current,
  }) async {
    if (busy || !entries.contains(entry) || entry.destination == null) return;
    await repository.guard(current);
    if (!entries.contains(entry)) throw staleCapability;
    await navigate(entry.destination!);
  }
}
