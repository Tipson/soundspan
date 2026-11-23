import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/session/credential_vault.dart';
import 'package:soundspan/downloads/protected_media_fetcher.dart';
import 'package:soundspan/playback/media_gateway.dart';
import 'package:soundspan/playback/resolved_media.dart';

import '../support/fake_tls_server.dart';
import '../support/media_fixtures.dart';

void main() {
  test(
    'nonzero suffix206 keeps arbitrary audio bytes without zero-offset sniff',
    () async {
      final server = await FakeTlsServer.start((request) async {
        expect(request.headers.value('range'), 'bytes=-130');
        request.response.statusCode = 206;
        request.response.headers.set('content-type', 'audio/mpeg');
        request.response.headers.set('content-range', 'bytes 126-255/256');
        request.response.contentLength = 130;
        request.response.add(audioBytes.sublist(126));
        await request.response.close();
      });
      addTearDown(server.close);
      final authority = await mediaAuthority(server.origin);
      final response =
          await ProtectedMediaFetcher(
            authority: authority,
            securityContext: server.clientContext,
          ).open(
            nativeMedia(authority, path: leasePath),
            authority.requireFence(),
            range: ByteRange.suffix(130),
          );
      expect(
        await response.body.expand((chunk) => chunk).toList(),
        audioBytes.sublist(126),
      );
    },
  );
  for (final revokeSession in [false, true]) {
    test(
      'paused consumer releases admission on ${revokeSession ? 'logout' : 'cancel'} before resume and closes idempotently',
      () async {
        final server = await FakeTlsServer.start(
          (request) => sendAudio(request),
        );
        addTearDown(server.close);
        final authority = await mediaAuthority(server.origin);
        final fetcher = ProtectedMediaFetcher(
          authority: authority,
          securityContext: server.clientContext,
          maxConcurrent: 1,
        );
        final fence = authority.requireFence();
        final cancellation = MediaCancellation();
        final first = await fetcher.open(
          nativeMedia(authority, path: leasePath),
          fence,
          cancellation: cancellation,
        );
        final received = Completer<void>();
        var receivedBytes = 0;
        late StreamSubscription<List<int>> paused;
        paused = first.body.listen(
          (chunk) {
            receivedBytes += chunk.length;
            paused.pause();
            received.complete();
          },
          onError: (Object error) {
            expect(error, isA<AppFailure>());
          },
        );
        addTearDown(() async {
          await first.close();
          await paused.cancel();
        });
        await received.future;
        expect(paused.isPaused, true);
        if (revokeSession) {
          await authority.invalidate();
          await authority.establish(
            fence.owner,
            const TokenPair(
              accessToken: 'replacement',
              refreshToken: 'replacement-refresh',
            ),
          );
        } else {
          cancellation.cancel();
        }
        // No resume, subscription.cancel, explicit close or arbitrary delay is
        // allowed before the next operation obtains the only admission slot.
        final second = await fetcher.open(
          nativeMedia(authority, path: leasePath),
          authority.requireFence(),
        );
        addTearDown(second.close);
        expect(paused.isPaused, true);
        await first.close();
        await first.close();
        cancellation.cancel();
        await expectLater(
          fetcher.open(
            nativeMedia(authority, path: leasePath),
            authority.requireFence(),
          ),
          throwsA(
            isA<AppFailure>().having(
              (error) => error.code,
              'code',
              'media_busy',
            ),
          ),
        );
        expect(await second.body.expand((chunk) => chunk).toList(), audioBytes);
        expect(receivedBytes, audioBytes.length);
        final third = await fetcher.open(
          nativeMedia(authority, path: leasePath),
          authority.requireFence(),
        );
        await third.close();
      },
    );
  }

  for (final validAudio in [false, true]) {
    test(
      'full suffix206 ${validAudio ? 'accepts progressive audio' : 'rejects padded manifest at actual byte zero'}',
      () async {
        final bytes = validAudio
            ? audioBytes
            : utf8.encode(
                '${' ' * 64}#EXTM3U\nhttps://foreign.invalid/segment.ts\n',
              );
        final server = await FakeTlsServer.start((request) async {
          expect(request.headers.value('range'), 'bytes=-8192');
          request.response.statusCode = 206;
          request.response.headers.set('content-type', 'audio/mpeg');
          request.response.headers.set(
            'content-range',
            'bytes 0-${bytes.length - 1}/${bytes.length}',
          );
          request.response.contentLength = bytes.length;
          request.response.add(bytes);
          await request.response.close();
        });
        addTearDown(server.close);
        final authority = await mediaAuthority(server.origin);
        final fetcher = ProtectedMediaFetcher(
          authority: authority,
          securityContext: server.clientContext,
        );
        final pending = fetcher.open(
          nativeMedia(authority, path: leasePath),
          authority.requireFence(),
          range: ByteRange.suffix(8192),
        );
        if (validAudio) {
          final response = await pending;
          expect(response.statusCode, 206);
          expect(
            await response.body.expand((chunk) => chunk).toList(),
            audioBytes,
          );
        } else {
          await expectLater(
            pending,
            throwsA(
              isA<AppFailure>().having(
                (error) => error.code,
                'code',
                'invalid_media',
              ),
            ),
          );
        }
      },
    );
  }
  test('scoped gateway revoke ignores different epoch and revokes matching handles', () async {
    final server = await FakeTlsServer.start((request) => sendAudio(request));
    addTearDown(server.close);
    final authority = await mediaAuthority(server.origin);
    final gateway = MediaGateway(
      authority: authority,
      fetcher: ProtectedMediaFetcher(
        authority: authority,
        securityContext: server.clientContext,
      ),
    );
    addTearDown(gateway.close);
    final fence = authority.requireFence();
    final first = await gateway.open(
      nativeMedia(authority, path: leasePath),
      fence,
    );
    final second = await gateway.open(
      nativeMedia(authority, path: leasePath),
      fence,
    );
    await gateway.revoke(
      SessionFence(owner: fence.owner, epoch: fence.epoch - 1),
    );
    final client = HttpClient();
    addTearDown(() => client.close(force: true));
    final active = await (await client.getUrl(first.uri)).close();
    expect(active.statusCode, 200);
    await active.drain<void>();
    await gateway.revoke(fence);
    for (final handle in [first, second]) {
      final response = await (await client.getUrl(handle.uri)).close();
      expect(response.statusCode, 404);
      await response.drain<void>();
    }
  });
  test(
    'valid nonzero audio ranges may start with JSON or XML punctuation',
    () async {
      final server = await FakeTlsServer.start((request) => sendAudio(request));
      addTearDown(server.close);
      final authority = await mediaAuthority(server.origin);
      final fetcher = ProtectedMediaFetcher(
        authority: authority,
        securityContext: server.clientContext,
      );
      for (final start in [63, 94, 126]) {
        final response = await fetcher.open(
          nativeMedia(authority, path: leasePath),
          authority.requireFence(),
          range: ByteRange(start: start, end: start + 15),
        );
        expect(
          await response.body.expand((e) => e).toList(),
          audioBytes.sublist(start, start + 16),
        );
      }
    },
  );
  test(
    'real TLS307 preserves range and cached second range uses fresh auth',
    () async {
      final paths = <String>[];
      final auth = <String?>[];
      final server = await FakeTlsServer.start((request) async {
        paths.add(request.uri.path);
        auth.add(request.headers.value('authorization'));
        expect(request.headers.value('range'), 'bytes=0-15');
        expect(request.headers.value('if-range'), '"v1"');
        if (request.uri.path == recordingPath) {
          request.response.statusCode = 307;
          request.response.headers.set('location', leasePath);
          await request.response.close();
        } else {
          await sendAudio(request);
        }
      });
      addTearDown(server.close);
      final authority = await mediaAuthority(server.origin);
      final fetcher = ProtectedMediaFetcher(
        authority: authority,
        securityContext: server.clientContext,
      );
      final media = nativeMedia(authority);
      final first = await fetcher.open(
        media,
        authority.requireFence(),
        range: ByteRange(start: 0, end: 15),
        ifRange: '"v1"',
      );
      expect(
        await first.body.expand((chunk) => chunk).toList(),
        audioBytes.take(16),
      );
      await authority.after401(
        (await authority.grantAccess(
          authority.requireFence(),
          server.origin,
        )).authStamp,
      );
      final second = await fetcher.open(
        media,
        authority.requireFence(),
        range: ByteRange(start: 0, end: 15),
        ifRange: '"v1"',
      );
      await second.body.drain<void>();
      expect(paths, [recordingPath, leasePath, leasePath]);
      expect(auth, ['Bearer initial', 'Bearer initial', 'Bearer fresh']);
    },
  );

  test(
    'foreign port redirect sends no request and no credentials to target',
    () async {
      var foreignCount = 0;
      final foreign = await FakeTlsServer.start((request) async {
        foreignCount++;
        await sendAudio(request);
      });
      addTearDown(foreign.close);
      final source = await FakeTlsServer.start((request) async {
        request.response.statusCode = 307;
        request.response.headers.set('location', '${foreign.origin}$leasePath');
        await request.response.close();
      });
      addTearDown(source.close);
      final authority = await mediaAuthority(source.origin);
      final fetcher = ProtectedMediaFetcher(
        authority: authority,
        securityContext: source.clientContext,
      );
      await expectLater(
        fetcher.open(nativeMedia(authority), authority.requireFence()),
        throwsA(isA<AppFailure>()),
      );
      expect(foreignCount, 0);
    },
  );

  for (final target in [
    'https://evil.example$leasePath',
    'https://sub.localhost$leasePath',
    'http://localhost$leasePath',
    '//evil.example$leasePath',
    'https://localhost.evil.example$leasePath',
    'https://localhost./$leasePath',
    '$leasePath?token=oops',
  ]) {
    test('unsafe redirect rejected before connection: $target', () async {
      var requests = 0;
      final server = await FakeTlsServer.start((request) async {
        requests++;
        request.response.statusCode = 307;
        request.response.headers.set('location', target);
        await request.response.close();
      });
      addTearDown(server.close);
      final authority = await mediaAuthority(server.origin);
      await expectLater(
        ProtectedMediaFetcher(
          authority: authority,
          securityContext: server.clientContext,
        ).open(nativeMedia(authority), authority.requireFence()),
        throwsA(isA<AppFailure>()),
      );
      expect(requests, 1);
    });
  }

  test(
    'parallel401 joins authority single flight and retries only once',
    () async {
      var refreshes = 0;
      final server = await FakeTlsServer.start((request) async {
        if (request.headers.value('authorization') == 'Bearer initial') {
          request.response.statusCode = 401;
          await request.response.close();
        } else {
          await sendAudio(request);
        }
      });
      addTearDown(server.close);
      final authority = await mediaAuthority(
        server.origin,
        refresh: (_, _) async {
          refreshes++;
          await Future<void>.delayed(const Duration(milliseconds: 30));
          return const TokenPair(
            accessToken: 'fresh',
            refreshToken: 'new-refresh',
          );
        },
      );
      final fetcher = ProtectedMediaFetcher(
        authority: authority,
        securityContext: server.clientContext,
      );
      final media = nativeMedia(authority, path: leasePath);
      await Future.wait(
        List.generate(4, (_) async {
          final response = await fetcher.open(media, authority.requireFence());
          await response.body.drain<void>();
        }),
      );
      expect(refreshes, 1);
    },
  );

  test('410 renews the exact native recording once', () async {
    final paths = <String>[];
    final server = await FakeTlsServer.start((request) async {
      paths.add(request.uri.path);
      if (request.uri.path == leasePath) {
        request.response.statusCode = 410;
        await request.response.close();
      } else if (request.uri.path == recordingPath) {
        request.response.statusCode = 307;
        request.response.headers.set('location', renewedLeasePath);
        await request.response.close();
      } else {
        await sendAudio(request);
      }
    });
    addTearDown(server.close);
    final authority = await mediaAuthority(server.origin);
    final response = await ProtectedMediaFetcher(
      authority: authority,
      securityContext: server.clientContext,
    ).open(nativeMedia(authority, path: leasePath), authority.requireFence());
    await response.body.drain<void>();
    expect(paths, [leasePath, recordingPath, renewedLeasePath]);
  });

  test(
    'loopback serves GET/HEAD with no secret headers and revokes immediately',
    () async {
      var upstreamRequests = 0;
      final server = await FakeTlsServer.start((request) async {
        upstreamRequests++;
        expect(request.headers.value('cookie'), isNull);
        await sendAudio(request);
      });
      addTearDown(server.close);
      final authority = await mediaAuthority(server.origin);
      final gateway = MediaGateway(
        authority: authority,
        fetcher: ProtectedMediaFetcher(
          authority: authority,
          securityContext: server.clientContext,
        ),
      );
      addTearDown(gateway.close);
      final handle = await gateway.open(
        nativeMedia(authority, path: leasePath),
        authority.requireFence(),
      );
      expect(handle.uri.host, '127.0.0.1');
      expect(handle.uri.pathSegments.first.length, greaterThanOrEqualTo(32));
      final client = HttpClient();
      addTearDown(() => client.close(force: true));
      final request = await client.getUrl(handle.uri);
      request.headers.set('authorization', 'Bearer native-must-not-forward');
      final response = await request.close();
      expect(response.statusCode, 200);
      expect(response.headers.value('location'), isNull);
      expect(await response.expand((e) => e).toList(), audioBytes);
      final head = await (await client.headUrl(handle.uri)).close();
      expect(head.contentLength, 256);
      expect(await head.toList(), isEmpty);
      await authority.invalidate();
      final revoked = await (await client.getUrl(handle.uri)).close();
      expect(revoked.statusCode, 404);
      await revoked.drain<void>();
      expect(upstreamRequests, 2);
    },
  );

  test('logout during delayed headers cancels pending HTTP', () async {
    final started = Completer<void>();
    final release = Completer<void>();
    final server = await FakeTlsServer.start((request) async {
      started.complete();
      await release.future;
      try {
        await sendAudio(request);
      } catch (_) {
        /* cancelled client */
      }
    });
    addTearDown(server.close);
    final authority = await mediaAuthority(server.origin);
    final pending = ProtectedMediaFetcher(
      authority: authority,
      securityContext: server.clientContext,
    ).open(nativeMedia(authority, path: leasePath), authority.requireFence());
    final failed = expectLater(pending, throwsA(isA<AppFailure>()));
    await started.future;
    await authority.invalidate();
    release.complete();
    await failed;
  });

  test(
    'slow chunked stream has idle rather than whole-song deadline',
    () async {
      final server = await FakeTlsServer.start((request) async {
        request.response.headers.set('content-type', 'audio/mpeg');
        request.response.bufferOutput = false;
        for (var i = 0; i < 10; i++) {
          request.response.add(audioBytes);
          await request.response.flush();
          await Future<void>.delayed(const Duration(milliseconds: 100));
        }
        await request.response.close();
      });
      addTearDown(server.close);
      final authority = await mediaAuthority(server.origin);
      final response = await ProtectedMediaFetcher(
        authority: authority,
        securityContext: server.clientContext,
        idleTimeout: const Duration(milliseconds: 600),
      ).open(nativeMedia(authority, path: leasePath), authority.requireFence());
      expect(response.headers['content-length'], isNull);
      expect((await response.body.expand((e) => e).toList()).length, 2560);
    },
  );

  for (final text in [
    '<html>login</html>',
    '{"login":true}',
    '#EXTM3U\nhttps://evil.example/stream',
    '<?xml version="1.0"?><MPD/>',
  ]) {
    test('spoofed audio MIME rejects document prefix $text', () async {
      final server = await FakeTlsServer.start((request) async {
        request.response.headers.set('content-type', 'audio/mpeg');
        request.response.write(text);
        await request.response.close();
      });
      addTearDown(server.close);
      final authority = await mediaAuthority(server.origin);
      await expectLater(
        ProtectedMediaFetcher(
          authority: authority,
          securityContext: server.clientContext,
        ).open(
          nativeMedia(authority, path: leasePath),
          authority.requireFence(),
        ),
        throwsA(isA<AppFailure>()),
      );
    });
  }

  test(
    'audio MIME cannot hide manifest after a long whitespace prefix',
    () async {
      final server = await FakeTlsServer.start((request) async {
        request.response.headers.set('content-type', 'audio/mpeg');
        request.response.write(
          '${' ' * 1024}#EXTM3U\nhttps://evil.example/audio',
        );
        await request.response.close();
      });
      addTearDown(server.close);
      final authority = await mediaAuthority(server.origin);
      await expectLater(
        ProtectedMediaFetcher(
          authority: authority,
          securityContext: server.clientContext,
        ).open(
          nativeMedia(authority, path: leasePath),
          authority.requireFence(),
        ),
        throwsA(isA<AppFailure>()),
      );
    },
  );

  test(
    'logout during active body interrupts the consumer without more bytes',
    () async {
      final release = Completer<void>();
      final server = await FakeTlsServer.start((request) async {
        request.response.headers.set('content-type', 'audio/mpeg');
        request.response.bufferOutput = false;
        request.response.add(audioBytes);
        await request.response.flush();
        await release.future;
        try {
          request.response.add(audioBytes);
          await request.response.close();
        } catch (_) {
          /* aborted */
        }
      });
      addTearDown(server.close);
      final authority = await mediaAuthority(server.origin);
      final result = await ProtectedMediaFetcher(
        authority: authority,
        securityContext: server.clientContext,
      ).open(nativeMedia(authority, path: leasePath), authority.requireFence());
      final started = Completer<void>();
      var bytes = 0;
      final done = Completer<void>();
      result.body.listen(
        (chunk) {
          bytes += chunk.length;
          if (!started.isCompleted) started.complete();
        },
        onError: (Object error) {
          expect(error, isA<AppFailure>());
          done.complete();
        },
        onDone: () {
          if (!done.isCompleted) {
            done.completeError(StateError('Revoked body succeeded'));
          }
        },
      );
      await started.future;
      await authority.invalidate();
      release.complete();
      await done.future.timeout(const Duration(seconds: 2));
      expect(bytes, 256);
    },
  );

  test('401 budget is shared across redirect and renewal chain', () async {
    var count = 0;
    var refreshes = 0;
    final server = await FakeTlsServer.start((request) async {
      count++;
      if (count == 2) {
        request.response.statusCode = 307;
        request.response.headers.set('location', leasePath);
      } else {
        request.response.statusCode = 401;
      }
      await request.response.close();
    });
    addTearDown(server.close);
    final authority = await mediaAuthority(
      server.origin,
      refresh: (_, _) async {
        refreshes++;
        return const TokenPair(accessToken: 'fresh', refreshToken: 'new');
      },
    );
    await expectLater(
      ProtectedMediaFetcher(
        authority: authority,
        securityContext: server.clientContext,
      ).open(nativeMedia(authority), authority.requireFence()),
      throwsA(
        isA<AppFailure>().having((error) => error.statusCode, 'status', 401),
      ),
    );
    expect(count, 3);
    expect(refreshes, 1);
  });

  test('redirect limit and cycles cannot loop indefinitely', () async {
    var count = 0;
    final server = await FakeTlsServer.start((request) async {
      count++;
      request.response.statusCode = 308;
      request.response.headers.set(
        'location',
        '/api/music-sources/leases/${count.toRadixString(16).padLeft(48, '0')}/stream',
      );
      await request.response.close();
    });
    addTearDown(server.close);
    final authority = await mediaAuthority(server.origin);
    await expectLater(
      ProtectedMediaFetcher(
        authority: authority,
        securityContext: server.clientContext,
      ).open(nativeMedia(authority), authority.requireFence()),
      throwsA(isA<AppFailure>()),
    );
    expect(count, 4);
  });

  test('GET unknown length HEAD206 and416 retain truthful framing', () async {
    final server = await FakeTlsServer.start((request) async {
      if (request.headers.value('range') == 'bytes=256-') {
        request.response.statusCode = 416;
        request.response.headers.set('content-range', 'bytes */256');
        request.response.write('upstream error must not escape');
        await request.response.close();
      } else {
        await sendAudio(request, chunked: request.method != 'HEAD');
      }
    });
    addTearDown(server.close);
    final authority = await mediaAuthority(server.origin);
    final fetcher = ProtectedMediaFetcher(
      authority: authority,
      securityContext: server.clientContext,
    );
    final media = nativeMedia(authority, path: leasePath);
    final full = await fetcher.open(media, authority.requireFence());
    expect(full.headers['content-length'], isNull);
    expect(await full.body.expand((e) => e).toList(), audioBytes);
    final head = await fetcher.open(
      media,
      authority.requireFence(),
      method: 'HEAD',
      range: ByteRange(start: 2, end: 7),
    );
    expect(head.statusCode, 206);
    expect(head.headers['content-range'], 'bytes 2-7/256');
    expect(await head.body.toList(), isEmpty);
    final unsatisfied = await fetcher.open(
      media,
      authority.requireFence(),
      range: ByteRange(start: 256),
    );
    expect(unsatisfied.statusCode, 416);
    expect(unsatisfied.headers['content-range'], 'bytes */256');
    expect(await unsatisfied.body.toList(), isEmpty);
  });

  test('malformed or changed 206 fails before any consumer bytes', () async {
    var mode = 0;
    final server = await FakeTlsServer.start((request) async {
      request.response.statusCode = 206;
      request.response.headers.set('content-type', 'audio/mpeg');
      request.response.headers.set(
        'content-range',
        mode == 0 ? 'bytes 3-7/256' : 'bytes 2-7/256',
      );
      request.response.headers.set('etag', '"changed"');
      request.response.add(audioBytes.sublist(2, 8));
      await request.response.close();
    });
    addTearDown(server.close);
    final authority = await mediaAuthority(server.origin);
    final fetcher = ProtectedMediaFetcher(
      authority: authority,
      securityContext: server.clientContext,
    );
    for (mode = 0; mode < 2; mode++) {
      await expectLater(
        fetcher.open(
          nativeMedia(authority, path: leasePath),
          authority.requireFence(),
          range: ByteRange(start: 2, end: 7),
          ifRange: '"v1"',
        ),
        throwsA(isA<AppFailure>()),
      );
    }
  });

  test(
    'TLS verification stays enabled without explicitly injected test CA',
    () async {
      var count = 0;
      final server = await FakeTlsServer.start((request) async {
        count++;
        await sendAudio(request);
      });
      addTearDown(server.close);
      final authority = await mediaAuthority(server.origin);
      await expectLater(
        ProtectedMediaFetcher(authority: authority).open(
          nativeMedia(authority, path: leasePath),
          authority.requireFence(),
        ),
        throwsA(
          isA<AppFailure>().having((error) => error.code, 'code', 'tls_failed'),
        ),
      );
      expect(count, 0);
    },
  );

  test(
    'loopback bounds Host path method range and active capabilities',
    () async {
      var upstreamCount = 0;
      final server = await FakeTlsServer.start((request) async {
        upstreamCount++;
        await sendAudio(request);
      });
      addTearDown(server.close);
      final authority = await mediaAuthority(server.origin);
      final gateway = MediaGateway(
        authority: authority,
        fetcher: ProtectedMediaFetcher(
          authority: authority,
          securityContext: server.clientContext,
        ),
        maxHandles: 1,
      );
      addTearDown(gateway.close);
      final media = nativeMedia(authority, path: leasePath);
      final handle = await gateway.open(media, authority.requireFence());
      await expectLater(
        gateway.open(media, authority.requireFence()),
        throwsA(isA<AppFailure>()),
      );
      final client = HttpClient();
      addTearDown(() => client.close(force: true));
      for (final mode in ['host', 'query', 'method', 'range', 'origin']) {
        final request = await client.openUrl(
          mode == 'method' ? 'POST' : 'GET',
          mode == 'query'
              ? handle.uri.replace(query: 'url=https://evil.example')
              : handle.uri,
        );
        if (mode == 'host') request.headers.set('host', 'evil.example');
        if (mode == 'range') request.headers.set('range', 'bytes=0-2,4-7');
        if (mode == 'origin') {
          request.headers.set('origin', 'https://evil.example');
        }
        final response = await request.close();
        expect(
          response.statusCode,
          mode == 'method'
              ? 405
              : mode == 'range'
              ? 400
              : 404,
        );
        await response.drain<void>();
      }
      expect(upstreamCount, 0);
      await handle.revoke();
      final response = await (await client.getUrl(handle.uri)).close();
      expect(response.statusCode, 404);
      await response.drain<void>();
    },
  );

  test(
    'explicit response close revokes already-prefetched body bytes',
    () async {
      final server = await FakeTlsServer.start((request) => sendAudio(request));
      addTearDown(server.close);
      final authority = await mediaAuthority(server.origin);
      final fetcher = ProtectedMediaFetcher(
        authority: authority,
        securityContext: server.clientContext,
        maxConcurrent: 1,
      );
      final media = nativeMedia(authority, path: leasePath);
      final response = await fetcher.open(media, authority.requireFence());
      await response.close();
      await expectLater(response.body.toList(), throwsA(isA<AppFailure>()));
      final next = await fetcher.open(media, authority.requireFence());
      expect((await next.body.expand((e) => e).toList()).length, 256);
    },
  );

  test(
    'consumer disconnect releases gateway slot and cancels upstream body',
    () async {
      final release = Completer<void>();
      var count = 0;
      final server = await FakeTlsServer.start((request) async {
        count++;
        if (count > 1) {
          await sendAudio(request);
          return;
        }
        request.response.headers.set('content-type', 'audio/mpeg');
        request.response.bufferOutput = false;
        request.response.add(audioBytes);
        await request.response.flush();
        await release.future;
        try {
          await request.response.close();
        } catch (_) {
          /* consumer cancelled */
        }
      });
      addTearDown(() {
        if (!release.isCompleted) release.complete();
      });
      addTearDown(server.close);
      final authority = await mediaAuthority(server.origin);
      final gateway = MediaGateway(
        authority: authority,
        fetcher: ProtectedMediaFetcher(
          authority: authority,
          securityContext: server.clientContext,
        ),
        maxStreams: 1,
      );
      addTearDown(gateway.close);
      final handle = await gateway.open(
        nativeMedia(authority, path: leasePath),
        authority.requireFence(),
      );
      final firstClient = HttpClient();
      final pending = (await firstClient.getUrl(handle.uri)).close();
      final first = await pending;
      final consumed = Completer<void>();
      final sub = first.listen((_) {
        if (!consumed.isCompleted) consumed.complete();
      }, onError: (Object _) {});
      await consumed.future;
      firstClient.close(force: true);
      await sub.cancel();
      await Future<void>.delayed(const Duration(milliseconds: 100));
      final secondClient = HttpClient();
      addTearDown(() => secondClient.close(force: true));
      final second = await (await secondClient.getUrl(handle.uri)).close();
      expect(second.statusCode, 200);
      await second.drain<void>();
      release.complete();
    },
  );

  test(
    'raw loopback framing supports chunked GET HEAD206 and empty416',
    () async {
      final server = await FakeTlsServer.start((request) async {
        if (request.headers.value('range') == 'bytes=256-') {
          request.response.statusCode = 416;
          request.response.headers.set('content-range', 'bytes */256');
          await request.response.close();
        } else {
          await sendAudio(request, chunked: request.method != 'HEAD');
        }
      });
      addTearDown(server.close);
      final authority = await mediaAuthority(server.origin);
      final gateway = MediaGateway(
        authority: authority,
        fetcher: ProtectedMediaFetcher(
          authority: authority,
          securityContext: server.clientContext,
        ),
      );
      addTearDown(gateway.close);
      final handle = await gateway.open(
        nativeMedia(authority, path: leasePath),
        authority.requireFence(),
      );
      final client = HttpClient();
      addTearDown(() => client.close(force: true));
      final full = await (await client.getUrl(handle.uri)).close();
      expect(full.headers.chunkedTransferEncoding, true);
      expect(full.persistentConnection, false);
      expect(await full.expand((e) => e).toList(), audioBytes);
      final headRequest = await client.headUrl(handle.uri);
      headRequest.headers.set('range', 'bytes=2-7');
      final head = await headRequest.close();
      expect(head.statusCode, 206);
      expect(head.contentLength, 6);
      expect(head.headers.chunkedTransferEncoding, false);
      expect(await head.toList(), isEmpty);
      final rangeRequest = await client.getUrl(handle.uri);
      rangeRequest.headers.set('range', 'bytes=256-');
      final range = await rangeRequest.close();
      expect(range.statusCode, 416);
      expect(range.contentLength, 0);
      expect(await range.toList(), isEmpty);
    },
  );

  test(
    'truncated upstream cannot become a successful loopback200 body',
    () async {
      final server = await FakeTlsServer.start((request) async {
        request.response.headers.set('content-type', 'audio/mpeg');
        request.response.contentLength = 512;
        final socket = await request.response.detachSocket();
        socket.add(audioBytes);
        await socket.flush();
        socket.destroy();
      });
      addTearDown(server.close);
      final authority = await mediaAuthority(server.origin);
      final gateway = MediaGateway(
        authority: authority,
        fetcher: ProtectedMediaFetcher(
          authority: authority,
          securityContext: server.clientContext,
        ),
      );
      addTearDown(gateway.close);
      final handle = await gateway.open(
        nativeMedia(authority, path: leasePath),
        authority.requireFence(),
      );
      final client = HttpClient();
      addTearDown(() => client.close(force: true));
      final response = await (await client.getUrl(handle.uri)).close();
      expect(response.statusCode, 200);
      await expectLater(response.toList(), throwsA(isA<HttpException>()));
    },
  );

  test(
    'cancel stalled seek range releases only that range operation',
    () async {
      final started = Completer<void>();
      final release = Completer<void>();
      final server = await FakeTlsServer.start((request) async {
        if (request.headers.value('range') == 'bytes=100-') {
          started.complete();
          await release.future;
          try {
            await sendAudio(request);
          } catch (_) {
            /* seek cancelled */
          }
        } else {
          await sendAudio(request);
        }
      });
      addTearDown(() {
        if (!release.isCompleted) release.complete();
      });
      addTearDown(server.close);
      final authority = await mediaAuthority(server.origin);
      final fetcher = ProtectedMediaFetcher(
        authority: authority,
        securityContext: server.clientContext,
      );
      final media = nativeMedia(authority, path: leasePath);
      final cancellation = MediaCancellation();
      final pending = fetcher.open(
        media,
        authority.requireFence(),
        range: ByteRange(start: 100),
        cancellation: cancellation,
      );
      final rejected = expectLater(pending, throwsA(isA<AppFailure>()));
      await started.future;
      final active = await fetcher.open(
        media,
        authority.requireFence(),
        range: ByteRange(start: 0, end: 15),
      );
      cancellation.cancel();
      await rejected;
      expect(await active.body.expand((e) => e).toList(), audioBytes.take(16));
      release.complete();
    },
  );
}
