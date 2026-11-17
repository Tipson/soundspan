import 'dart:async';
import 'dart:io';

import '../core/model/app_failure.dart';
import '../core/model/owner_key.dart';
import '../core/model/track_ref.dart';
import '../core/network/api_transport.dart';
import '../core/network/media_response_validator.dart';
import '../core/network/redirect_policy.dart';
import '../core/network/retry_after.dart';
import '../core/session/session_authority.dart';
import '../playback/resolved_media.dart';

/// The sole authenticated audio socket boundary, shared with downloads. The
/// native player never receives an account credential or upstream Location.
final class ProtectedMediaFetcher {
  ProtectedMediaFetcher({
    required this.authority,
    this.securityContext,
    this.idleTimeout = const Duration(seconds: 30),
    this.maxConcurrent = 16,
  });
  final SessionAuthority authority;
  final SecurityContext? securityContext;
  final Duration idleTimeout;
  final int maxConcurrent;
  final Expando<Uri> _leases = Expando<Uri>();
  int _active = 0;

  Future<ProtectedMediaResponse> open(
    ResolvedMedia media,
    SessionFence fence, {
    ByteRange? range,
    String? ifRange,
    String method = 'GET',
    MediaCancellation? cancellation,
    int? expectedTotal,
    // Gateway-only replay before exposing headers/prefix bytes. Downloads keep
    // one-shot behavior; auth/renewal/redirect budgets remain operation-wide.
    bool retryTransientBeforeResponse = false,
  }) async {
    if (media.fence != fence || !const {'GET', 'HEAD'}.contains(method)) {
      throw invalidMedia;
    }
    MediaResponseValidator.validateIfRange(range, ifRange);
    RedirectPolicy.validate(media.uri, media);
    if (media.renewableUri != null &&
        (media.ref is! NativeTrackRef ||
            media.renewableUri !=
                fence.owner.serverOrigin.resolve(
                  RedirectPolicy.recordingPath(media.ref as NativeTrackRef),
                ))) {
      throw invalidMedia;
    }
    if (_active >= maxConcurrent) {
      throw const AppFailure(
        code: 'media_busy',
        message: 'Слишком много аудиозапросов',
        retryable: true,
      );
    }
    _active++;
    HttpClient? client;
    StreamIterator<List<int>>? iterator;
    var closed = false;
    var cancelled = false;
    Future<void>? closing;
    StreamSubscription<SessionState>? events;
    void Function()? removeCancellation;
    Future<void> close() {
      if (closed) return closing ?? Future<void>.value();
      closed = true;
      client?.close(force: true);
      removeCancellation?.call();
      // Admission does not belong to the consumer's async* continuation. A
      // paused subscriber must not retain a slot after its sockets are aborted.
      _active--;
      return closing = Future.wait<void>([
        if (events != null) events.cancel(),
        if (iterator != null) iterator.cancel(),
      ]).then((_) {});
    }

    void abort() {
      cancelled = true;
      // Cancellation is synchronous; subscription disposal may finish later.
      // The explicit close path still returns this same disposal future.
      unawaited(close().catchError((Object _) {}));
    }

    events = authority.changes.listen((_) {
      if (!authority.isCurrent(fence)) abort();
    });
    removeCancellation = cancellation?.listen(abort);

    void check() {
      cancellation?.check();
      if (cancelled || !authority.isCurrent(fence)) throw mediaCancelled;
    }

    Future<bool> next() async {
      check();
      final result = await iterator!.moveNext().timeout(idleTimeout);
      check();
      return result;
    }

    try {
      var uri = _leases[media] ?? media.uri;
      var replayed = false;
      var renewed = false;
      var transientReplayed = false;
      var redirects = 0;
      final visited = <Uri>{uri};
      while (true) {
        try {
          check();
          RedirectPolicy.validate(uri, media);
          final grant = await authority.grantAccess(
            fence,
            fence.owner.serverOrigin,
          );
          check();
          client = HttpClient(context: securityContext)
            ..autoUncompress = false
            ..connectionTimeout = idleTimeout;
          final request = await client
              .openUrl(method, uri)
              .timeout(idleTimeout);
          check();
          // Re-admit after socket establishment; a logout during TLS must not send
          // a credential using a stale proxy-cache observation.
          await authority.assertCurrent(fence);
          check();
          request.followRedirects = false;
          request.maxRedirects = 0;
          if (grant.accessToken.isEmpty ||
              RegExp(r'[\s\x00-\x1f\x7f]').hasMatch(grant.accessToken)) {
            throw invalidMedia;
          }
          request.headers.set('authorization', 'Bearer ${grant.accessToken}');
          request.headers.set('accept-encoding', 'identity');
          if (range != null) request.headers.set('range', range.header);
          if (ifRange != null) request.headers.set('if-range', ifRange);
          final response = await request.close().timeout(idleTimeout);
          await authority.assertCurrent(fence);
          check();
          if (response.statusCode == 401 && !replayed) {
            replayed = true;
            client.close(force: true);
            await authority.after401(grant.authStamp);
            check();
            continue;
          }
          if (response.statusCode >= 300 && response.statusCode < 400) {
            if (!const {307, 308}.contains(response.statusCode) ||
                redirects >= 3) {
              throw invalidMedia;
            }
            final locations = response.headers['location'];
            if (locations == null || locations.length != 1) throw invalidMedia;
            final target = RedirectPolicy.redirect(
              uri,
              locations.single,
              media,
            );
            if (!visited.add(target)) throw invalidMedia;
            redirects++;
            client.close(force: true);
            uri = target;
            continue;
          }
          if (const {404, 410}.contains(response.statusCode) &&
              RedirectPolicy.leasePattern.hasMatch(uri.path) &&
              media.renewableUri != null &&
              !renewed) {
            renewed = true;
            client.close(force: true);
            uri = media.renewableUri!;
            _leases[media] = null;
            // Renewal may return the original lease ID; permit it once, retaining
            // the operation-wide hop count and authentication replay budget.
            visited.clear();
            visited.add(uri);
            continue;
          }
          if (!const {200, 206, 416}.contains(response.statusCode)) {
            final failure = failureForStatus(
              response.statusCode,
              retryAfter: RetryAfterPolicy.parse(
                statusCode: response.statusCode,
                values: response.headers[HttpHeaders.retryAfterHeader],
                now: DateTime.now(),
              ),
            );
            throw retryTransientBeforeResponse &&
                    const {502, 504}.contains(response.statusCode)
                ? AppFailure(
                    code: failure.code,
                    message: failure.message,
                    statusCode: failure.statusCode,
                    retryable: true,
                  )
                : failure;
          }
          final headers = <String, String>{};
          for (final name in const [
            'content-type',
            'content-length',
            'content-range',
            'content-encoding',
            'accept-ranges',
            'etag',
            'last-modified',
          ]) {
            final values = response.headers[name];
            if (values != null) {
              if (values.length != 1 || values.single.length > 512) {
                throw invalidMedia;
              }
              headers[name] = values.single;
            }
          }
          final validated = MediaResponseValidator.validate(
            statusCode: response.statusCode,
            headers: headers,
            range: range,
            ifRange: ifRange,
            expectedTotal: expectedTotal,
          );
          headers.remove('content-encoding');
          if (RedirectPolicy.leasePattern.hasMatch(uri.path)) {
            _leases[media] = uri;
          }
          if (method == 'HEAD' || response.statusCode == 416) {
            if (response.statusCode == 416) {
              headers.remove('content-type');
              headers['content-length'] = '0';
            }
            await close();
            check();
            return ProtectedMediaResponse(
              statusCode: response.statusCode,
              headers: headers,
              body: const Stream.empty(),
              close: close,
            );
          }
          iterator = StreamIterator(response);
          final prefixChunks = <List<int>>[];
          final prefix = <int>[];
          var eof = false;
          while (prefix.length < 64) {
            if (!await next()) {
              eof = true;
              break;
            }
            final chunk = iterator.current;
            prefixChunks.add(chunk);
            prefix.addAll(chunk.take(64 - prefix.length));
          }
          MediaResponseValidator.validatePrefix(
            prefix,
            startsAtZero: validated.actualStart == 0,
          );
          await authority.assertCurrent(fence);
          check();
          Stream<List<int>> body() async* {
            var bytes = 0;
            try {
              for (final chunk in prefixChunks) {
                check();
                bytes += chunk.length;
                if (validated.expectedLength != null &&
                    bytes > validated.expectedLength!) {
                  throw invalidMedia;
                }
                yield chunk;
              }
              while (!eof && await next()) {
                final chunk = iterator!.current;
                bytes += chunk.length;
                if (validated.expectedLength != null &&
                    bytes > validated.expectedLength!) {
                  throw invalidMedia;
                }
                yield chunk;
              }
              check();
              if (validated.expectedLength != null &&
                  bytes != validated.expectedLength) {
                throw invalidMedia;
              }
            } catch (error) {
              throw _failure(error, cancelled);
            } finally {
              await close();
            }
          }

          return ProtectedMediaResponse(
            statusCode: response.statusCode,
            headers: headers,
            body: body(),
            close: () async {
              abort();
              await close();
            },
          );
        } catch (error) {
          final failure = _failure(error, cancelled);
          if (!retryTransientBeforeResponse ||
              transientReplayed ||
              !failure.retryable ||
              failure.retryAfter != null ||
              !(const {502, 503, 504}.contains(failure.statusCode) ||
                  const {
                    'media_network_error',
                    'media_idle_timeout',
                  }.contains(failure.code))) {
            throw failure;
          }
          check();
          transientReplayed = true;
          client?.close(force: true);
          client = null;
          final failedIterator = iterator;
          iterator = null;
          await failedIterator?.cancel();
          check();
        }
      }
    } catch (error) {
      await close();
      throw _failure(error, cancelled);
    }
  }

  static AppFailure _failure(Object error, bool cancelled) {
    if (cancelled) return mediaCancelled;
    if (error is AppFailure) return error;
    if (error is TimeoutException) {
      return const AppFailure(
        code: 'media_idle_timeout',
        message: 'Передача аудио остановилась',
        retryable: true,
      );
    }
    if (error is HandshakeException) {
      return const AppFailure(
        code: 'tls_failed',
        message: 'Не удалось проверить защищённое соединение',
      );
    }
    return const AppFailure(
      code: 'media_network_error',
      message: 'Ошибка передачи аудио',
      retryable: true,
    );
  }
}
