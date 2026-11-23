import 'owner_endpoint.dart';
import 'share_models.dart';
import 'share_repository.dart';

final class ShareController extends MemoryFeatureController {
  ShareController(ShareRepository super.endpoint);
  ShareRepository get repository => endpoint as ShareRepository;
  List<ShareLink> _links = const [];
  List<ShareLink> get links => isCurrent ? _links : const [];
  String? _attempt, _reviewedAttempt;
  bool get uncertain => _attempt != null;
  bool get canAcknowledge => _attempt != null && _attempt == _reviewedAttempt;
  @override
  void clearData() {
    _links = const [];
    _attempt = null;
    _reviewedAttempt = null;
  }

  Future<void> _read({bool Function()? current}) async {
    final attempt = await repository.pendingAttempt();
    final links = await repository.list(current: current);
    if (isCurrent && current?.call() != false) {
      _links = links;
      _attempt = attempt;
      _reviewedAttempt = attempt;
    }
  }

  Future<void> load({bool Function()? current}) => work(() async {
    await _read(current: current);
    if (isCurrent) message = uncertain ? sharePending.message : null;
  });
  Future<void> create(ShareDraft draft, {required bool Function() current}) =>
      work(() async {
        try {
          final link = await repository.create(draft, current: current);
          if (isCurrent && current()) {
            _links = [link, ..._links.where((l) => l.id != link.id)];
            _attempt = null;
            _reviewedAttempt = null;
            message = 'Ссылка создана. Выберите действие ниже.';
          }
        } catch (_) {
          if (isCurrent) {
            _attempt = await repository.pendingAttempt();
            _reviewedAttempt = null;
            if (uncertain) message = sharePending.message;
          }
          rethrow;
        }
      });
  Future<void> acknowledgeUncertainty({required bool Function() current}) =>
      work(() async {
        final attempt = _attempt;
        if (attempt == null || attempt != _reviewedAttempt) throw sharePending;
        await repository.acknowledgeUncertainty(attempt, current: current);
        if (isCurrent && current()) {
          _attempt = null;
          _reviewedAttempt = null;
          message = 'Новая попытка разрешена. Создание ссылки остаётся отдельным действием.';
        }
      });
  bool _same(ShareLink link) => _links.any((l) => identical(l, link));
  Future<void> revoke(ShareLink link, {required bool Function() current}) =>
      work(() async {
        bool admitted() => isCurrent && current() && _same(link);
        await repository.guard(admitted);
        await repository.revoke(link.id, current: admitted);
        if (!isCurrent) return;
        _links = _links.where((l) => l.id != link.id).toList();
        message = 'Ссылка отозвана.';
        // Failure here does not undo an acknowledged revocation.
        if (current()) await _read(current: current);
      });
  Future<void> useLink(
    ShareLink link,
    Future<void> Function(Uri) action, {
    required bool Function() current,
  }) => work(() async {
    if (!_same(link)) throw staleCapability;
    await repository.guard(current);
    final refreshed = await repository.list(current: current);
    if (!isCurrent || !current()) throw staleCapability;
    _links = refreshed;
    final latest = refreshed
        .where((l) => l.id == link.id && l.publicUrl == link.publicUrl)
        .firstOrNull;
    if (latest == null || !latest.available(DateTime.now())) {
      throw staleCapability;
    }
    await repository.guard(current);
    if (!latest.available(DateTime.now())) throw staleCapability;
    await action(latest.publicUrl);
    await repository.guard(current);
  });
}
