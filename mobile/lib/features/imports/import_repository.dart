import 'dart:convert';

import 'package:crypto/crypto.dart';

import '../../core/model/app_failure.dart';
import '../../core/model/owner_key.dart';
import '../../core/network/api_transport.dart';
import '../../core/network/network_policy.dart';
import '../../core/session/session_authority.dart';
import '../../core/storage/owner_store.dart';
import 'import_models.dart';

/// Exact JSON API adapter. Mutation admission and checkpoint share one fence.
final class ImportRepository {
  ImportRepository({
    required this.transport,
    required this.authority,
    required this.fence,
    required this.networkPolicy,
    this.store,
  });
  final ApiTransport transport;
  final SessionAuthority authority;
  final SessionFence fence;
  final NetworkPolicy networkPolicy;
  final OwnerStore? store;
  bool _closed = false;
  bool get isCurrent => !_closed && authority.isCurrent(fence);
  bool get networkAllowed => isCurrent && networkPolicy.networkAllowed;
  void revoke() {
    _closed = true;
  }

  Future<void> _guard() async {
    if (!isCurrent) throw _stale;
    await authority.assertCurrent(fence);
    if (!isCurrent) throw _stale;
  }

  Future<Object?> _request(
    String suffix, {
    ApiMethod method = ApiMethod.get,
    Map<String, Object?>? body,
  }) async {
    await _guard();
    networkPolicy.requireNetwork();
    final response = await transport.send(
      ApiRequest(
        origin: fence.owner.serverOrigin,
        method: method,
        path: '/api/import$suffix',
        body: body,
      ),
      fence: fence,
    );
    await _guard();
    response.requireSuccess();
    return response.data;
  }

  ImportJob _job(Object? raw, {String? id, ImportSource? source}) {
    final result = ImportJob.fromJson(raw);
    if (result.userId != fence.owner.userId ||
        (id != null && result.id != id) ||
        (source != null && result.normalizedSource != source.identity)) {
      throw invalidImport;
    }
    return result;
  }

  Future<List<ImportJob>> listJobs() async {
    final dto = importObject(await _request('/jobs'));
    final rows = dto['jobs'];
    if (rows is! List) throw invalidImport;
    final jobs = rows.map((r) => _job(r)).toList();
    if (jobs.map((j) => j.id).toSet().length != jobs.length) {
      throw invalidImport;
    }
    return List.unmodifiable(jobs);
  }

  Future<ImportJob> getJob(String id) async => _job(
    importObject(await _request('/jobs/${Uri.encodeComponent(id)}'))['job'],
    id: id,
  );
  Future<ImportJob> submit(Uri url, {String? name}) async {
    final source = ImportSource.parse(url.toString());
    final dto = importObject(
      await _request(
        '/jobs',
        method: ApiMethod.post,
        body: {'url': source.url.toString(), ..._name(name)},
      ),
    );
    if (dto['deduped'] is! bool) throw invalidImport;
    return _job(dto['job'], source: source);
  }

  /// Backend only calls findActiveJobForSource; despite POST this is read-only.
  Future<ImportJob> reconnect(Uri url) async {
    final source = ImportSource.parse(url.toString());
    return _job(
      importObject(
        await _request(
          '/jobs/reconnect',
          method: ApiMethod.post,
          body: {'url': source.url.toString()},
        ),
      )['job'],
      source: source,
    );
  }

  Future<ImportJob> cancel(String id) async => _job(
    importObject(
      await _request(
        '/jobs/${Uri.encodeComponent(id)}/cancel',
        method: ApiMethod.post,
      ),
    )['job'],
    id: id,
  );
  Future<ImportJob> retry(String id) async => _job(
    importObject(
      await _request(
        '/jobs/${Uri.encodeComponent(id)}/retry',
        method: ApiMethod.post,
      ),
    )['job'],
    id: id,
  );
  Future<ImportPreview> preview(Uri url) async => ImportPreview.fromJson(
    await _request(
      '/preview',
      method: ApiMethod.post,
      body: {'url': ImportSource.parse(url.toString()).url.toString()},
    ),
  );
  Future<ImportPreview> previewM3u(String content, {String? name}) async {
    validateM3u(content);
    return ImportPreview.fromJson(
      await _request(
        '/m3u/preview',
        method: ApiMethod.post,
        body: {'content': content, ..._name(name)},
      ),
    );
  }

  Future<ImportOutcome> execute(ImportPreview preview, {String? name}) async =>
      ImportOutcome.fromJson(
        await _request(
          '/execute',
          method: ApiMethod.post,
          body: {'previewData': preview.json, ..._name(name)},
        ),
      );
  static void validateM3u(String content) {
    if (content.trim().isEmpty ||
        content.contains('\u0000') ||
        utf8.encode(content).length > 512 * 1024) {
      throw const AppFailure(
        code: 'invalid_m3u',
        message: 'Выберите непустой M3U или M3U8 в UTF-8 размером до 512 КБ.',
      );
    }
  }

  static Map<String, Object?> _name(String? name) {
    final value = name?.trim();
    if (value == null || value.isEmpty) return {};
    if (value.length > 200) {
      throw const AppFailure(
        code: 'import_name',
        message: 'Название должно быть не длиннее 200 символов.',
      );
    }
    return {'name': value};
  }

  static String fingerprint(ImportPreview preview) =>
      sha256.convert(utf8.encode(jsonEncode(preview.json))).toString();
  static const _namespace = 'playlistImport.v1', _key = 'pending';
  Future<Map<String, Object?>?> readPending() async {
    await _guard();
    final value = await store?.transaction(
      fence,
      (tx) => tx.read(_namespace, _key),
    );
    await _guard();
    return value;
  }

  Future<void> savePending(Map<String, Object?> intent) async {
    await _guard();
    networkPolicy.requireNetwork();
    await store?.transaction(
      fence,
      (tx) => tx.write(_namespace, _key, {'version': 1, ...intent}),
    );
    await _guard();
  }

  Future<void> clearPending() async {
    await _guard();
    await store?.transaction(fence, (tx) => tx.remove(_namespace, _key));
    await _guard();
  }

  static const _stale = AppFailure(
    code: 'stale_session',
    message: 'Сеанс завершён.',
  );
}
