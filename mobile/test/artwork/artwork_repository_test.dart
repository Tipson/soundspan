import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/artwork/artwork_repository.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/session/session_authority.dart';
import 'package:soundspan/core/storage/owner_store.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/core/session/credential_vault.dart';
import 'package:soundspan/core/session/local_session_authority.dart';

import '../downloads/download_fixture.dart';
import '../support/fake_tls_server.dart';
import '../support/media_fixtures.dart';

class TestPolicy extends ChangeNotifier implements NetworkPolicy {
  bool allowed = true;
  @override
  bool get networkAllowed => allowed;
  @override
  void requireNetwork() {
    if (!allowed) throw StateError('offline');
  }

  void offline() {
    allowed = false;
    notifyListeners();
  }
}

Future<List<int>> png({int width = 16, int height = 16}) async {
  final recorder = ui.PictureRecorder();
  ui.Canvas(recorder).drawColor(const ui.Color(0xffad1234), ui.BlendMode.src);
  final picture = recorder.endRecording();
  final image = await picture.toImage(width, height);
  try {
    return (await image.toByteData(format: ui.ImageByteFormat.png))!.buffer
        .asUint8List();
  } finally {
    image.dispose();
    picture.dispose();
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  HttpOverrides.global = null;
  late FakeTlsServer server;
  late LocalSessionAuthority authority;
  late DownloadTestStore store;
  late Directory root;
  late ArtworkRepository repo;
  late TestPolicy policy;
  late List<int> bytes;
  final requests = <Uri>[];
  final auth = <String?>[];
  Future<void> Function(HttpRequest)? handler;
  var refreshes = 0;
  setUp(() async {
    requests.clear();
    auth.clear();
    handler = null;
    refreshes = 0;
    bytes = await png();
    server = await FakeTlsServer.start((r) async {
      requests.add(r.uri);
      auth.add(r.headers.value('authorization'));
      try {
        if (handler != null) {
          await handler!(r);
          return;
        }
        r.response.headers.contentType = ContentType('image', 'png');
        r.response.add(bytes);
        await r.response.close();
      } catch (_) {
        r.response.close().ignore();
      }
    });
    authority = await mediaAuthority(
      server.origin,
      refresh: (_, _) async {
        refreshes++;
        return const TokenPair(accessToken: 'fresh', refreshToken: 'next');
      },
    );
    store = DownloadTestStore(authority);
    root = await Directory.systemTemp.createTemp('artwork-');
    policy = TestPolicy();
    repo = ArtworkRepository(
      authority: authority,
      store: store,
      fence: authority.requireFence(),
      networkPolicy: policy,
      privateRoot: root,
      testSecurityContext: server.clientContext,
      timeout: const Duration(milliseconds: 800),
    );
  });
  tearDown(() async {
    await repo.close();
    await server.close();
    await authority.invalidate();
    await root.delete(recursive: true);
    policy.dispose();
  });

  Future<int> width(File? file) async {
    expect(file, isNotNull);
    final buffer = await ui.ImmutableBuffer.fromUint8List(
      await file!.readAsBytes(),
    );
    final descriptor = await ui.ImageDescriptor.encoded(buffer);
    try {
      return descriptor.width;
    } finally {
      descriptor.dispose();
      buffer.dispose();
    }
  }

  test('small first artwork upgrades for a larger view without persisting its hint', () async {
    bytes = await png(width: 1024, height: 1024);
    const ref = LibraryTrackRef('resolution');
    final hint = Uri.parse('https://art.example/cover?signed=memory-only');
    expect(await width(await repo.load(ref: ref, hint: hint, edge: 48)), 48);
    expect(await width(await repo.load(ref: ref, edge: 768)), 768);
    expect(requests.map((r) => r.queryParameters['size']), ['48', '768']);
    expect(store.rows.toString(), isNot(contains('memory-only')));
    expect(store.rows, hasLength(1));
    policy.offline();
    expect(await width(await repo.load(ref: ref, edge: 1024)), 768);
    expect(requests, hasLength(2));
  });

  test('concurrent mixed artwork edges upgrade and never replace large cache with small', () async {
    bytes = await png(width: 1024, height: 1024);
    final entered = Completer<void>(), release = Completer<void>();
    handler = (r) async {
      if (!entered.isCompleted) {
        entered.complete();
        await release.future;
      }
      r.response.headers.contentType = ContentType('image', 'png');
      r.response.add(bytes);
      await r.response.close();
    };
    const ref = LibraryTrackRef('mixed');
    final small = repo.load(ref: ref, hint: Uri.parse('mixed-art'), edge: 64);
    await entered.future;
    final large = repo.load(ref: ref, edge: 1024);
    final medium = repo.load(ref: ref, edge: 256);
    release.complete();
    expect(await width(await small), 64);
    expect(await width(await large), 1024);
    expect(await width(await medium), greaterThanOrEqualTo(256));
    expect(await width(await repo.load(ref: ref, edge: 32)), 1024);
    expect(requests.length, lessThanOrEqualTo(3));
  });

  test('reentrant close shares one future and disposes exactly once', () async {
    final subject = ArtworkRepository(
      authority: authority,
      store: store,
      fence: authority.requireFence(),
      networkPolicy: policy,
      privateRoot: root,
    );
    Future<void>? inner;
    var notifications = 0;
    final errors = <Object>[];
    subject.addListener(() {
      notifications++;
      if (notifications == 1) {
        inner = subject.close();
        inner!.catchError((Object error) {
          errors.add(error);
        });
      }
    });
    final outer = subject.close();
    expect(subject.isCurrent, isFalse);
    await outer.catchError((Object error) {
      errors.add(error);
    });
    await inner!.catchError((Object _) {});
    expect(errors, isEmpty);
    expect(inner, same(outer));
    expect(subject.close(), same(outer));
    expect(notifications, 1);
    expect(await subject.load(hint: Uri.parse('after-close')), isNull);
    expect(requests, isEmpty);
  });

  test('legacy index without edge remains offline-readable and upgrades only with a supplied hint', () async {
    bytes = await png(width: 1024, height: 1024);
    const ref = LibraryTrackRef('legacy');
    final hint = Uri.parse('legacy-cover');
    final small = await repo.load(ref: ref, hint: hint, edge: 48);
    store.rows.values.single.remove('edge');
    await repo.close();
    policy.offline();
    repo = ArtworkRepository(
      authority: authority,
      store: store,
      fence: authority.requireFence(),
      networkPolicy: policy,
      privateRoot: root,
      testSecurityContext: server.clientContext,
    );
    expect((await repo.load(ref: ref, edge: 1024))?.path, small!.path);
    policy.allowed = true;
    expect((await repo.load(ref: ref, edge: 1024))?.path, small.path);
    expect(requests, hasLength(1));
    expect(
      await width(await repo.load(ref: ref, hint: hint, edge: 1024)),
      1024,
    );
    expect(requests, hasLength(2));
  });

  test('failed size upgrade keeps the verified thumbnail without changing its index', () async {
    bytes = await png(width: 1024, height: 1024);
    const ref = LibraryTrackRef('upgrade-failure');
    final small = await repo.load(ref: ref, hint: Uri.parse('cover'), edge: 64);
    final index = store.rows.toString();
    handler = (request) async {
      request.response.statusCode = 503;
      await request.response.close();
    };
    expect((await repo.load(ref: ref, edge: 1024))?.path, small!.path);
    expect(store.rows.toString(), index);
    expect(requests, hasLength(2));
  });

  test('rejected upgrade hints retain verified art without network or index changes', () async {
    bytes = await png(width: 1024, height: 1024);
    const ref = LibraryTrackRef('rejected-upgrade-hint');
    final small = await repo.load(ref: ref, hint: Uri.parse('valid'), edge: 64);
    final index = store.rows.toString();
    for (final hint in [
      Uri.parse('file:///private/image'),
      Uri.parse('content://media/1'),
      Uri.parse('data:image/png,a'),
      Uri.parse('ftp://foreign/art'),
      Uri.parse('//foreign/art'),
      Uri.parse('a' * 16385),
    ]) {
      final result = await repo.load(ref: ref, hint: hint, edge: 1024);
      expect(result?.path, small!.path);
      expect(await width(result), 64);
      expect(store.rows.toString(), index);
      expect(requests, hasLength(1));
      expect(
        await repo.load(ref: const LibraryTrackRef('uncached'), hint: hint),
        isNull,
      );
      expect(requests, hasLength(1));
    }
    // Rejected metadata must not replace the original bounded in-memory hint.
    expect(await width(await repo.load(ref: ref, edge: 1024)), 1024);
    expect(requests, hasLength(2));
    await authority.invalidate();
    expect(
      await repo.load(ref: ref, hint: Uri.parse('file:///private/image')),
      isNull,
    );
    expect(requests, hasLength(2));
  });

  test('owner close revokes a queued larger upgrade before another network request', () async {
    final entered = Completer<void>(), release = Completer<void>();
    handler = (request) async {
      entered.complete();
      await release.future;
      request.response.headers.contentType = ContentType('image', 'png');
      request.response.add(bytes);
      await request.response.close();
    };
    const ref = LibraryTrackRef('revoke-upgrade');
    final small = repo.load(ref: ref, hint: Uri.parse('cover'), edge: 32);
    await entered.future;
    final large = repo.load(ref: ref, edge: 1024);
    final closing = repo.close();
    release.complete();
    expect(await small, isNull);
    expect(await large, isNull);
    await closing;
    expect(requests, hasLength(1));
    expect(store.rows, isEmpty);
  });

  test('real PNG is authenticated through own proxy then restored offline by identity', () async {
    const ref = LibraryTrackRef('one');
    final hint = Uri.parse('native:album.jpg');
    final file = await repo.load(ref: ref, hint: hint);
    expect(file, isNotNull);
    expect(await file!.readAsBytes(), isNotEmpty);
    expect(requests.single.path, '/api/library/cover-art');
    expect(requests.single.queryParameters['url'], 'native:album.jpg');
    expect(auth, ['Bearer initial']);
    policy.offline();
    expect((await repo.load(ref: ref))?.path, file.path);
    expect(requests, hasLength(1));
    expect(store.rows.toString(), isNot(contains('native:')));
    expect(store.rows.toString(), isNot(contains('initial')));
  });
  test(
    'opaque IDs and external hints only use authenticated own routes',
    () async {
      await repo.load(hint: Uri.parse('album-id'));
      await repo.load(
        hint: Uri.parse('https://i.ytimg.com/vi/abc/hqdefault.jpg'),
      );
      expect(requests[0].path, '/api/library/cover-art/album-id');
      expect(
        requests[1].queryParameters['url'],
        'https://i.ytimg.com/vi/abc/mqdefault.jpg',
      );
      expect(auth, everyElement('Bearer initial'));
    },
  );
  test(
    'one original 401 budget uses authority refresh and one replay',
    () async {
      handler = (r) async {
        r.response.statusCode = 401;
        await r.response.close();
      };
      expect(await repo.load(hint: Uri.parse('album')), isNull);
      expect(refreshes, 1);
      expect(auth, ['Bearer initial', 'Bearer fresh']);
    },
  );
  test('foreign redirect is never followed', () async {
    var foreignRequests = 0;
    final foreign = await FakeTlsServer.start((r) async {
      foreignRequests++;
      await r.response.close();
    });
    try {
      handler = (r) async {
        r.response.statusCode = 302;
        r.response.headers.set('location', foreign.origin.resolve('/cover'));
        await r.response.close();
      };
      expect(await repo.load(hint: Uri.parse('album')), isNull);
      expect(foreignRequests, 0);
      expect(refreshes, 0);
    } finally {
      await foreign.close();
    }
  });
  test('singleflight and cold offline never duplicate network work', () async {
    final hint = Uri.parse('cover');
    final files = await Future.wait(
      List.generate(12, (_) => repo.load(hint: hint)),
    );
    expect(files.every((f) => f != null), isTrue);
    expect(requests, hasLength(1));
    policy.offline();
    expect(await repo.load(hint: Uri.parse('cold')), isNull);
    expect(requests, hasLength(1));
  });
  test(
    'corrupt cache refuses offline file and refetches only online',
    () async {
      const ref = LibraryTrackRef('corrupt');
      final f = await repo.load(ref: ref, hint: Uri.parse('cover'));
      await f!.writeAsString('<html>bad</html>');
      policy.offline();
      expect(await repo.load(ref: ref), isNull);
      expect(requests, hasLength(1));
    },
  );
  test('late owner ABA response never publishes and close drains', () async {
    final seen = Completer<void>();
    final gate = Completer<void>();
    handler = (r) async {
      seen.complete();
      await gate.future;
      r.response.headers.contentType = ContentType('image', 'png');
      r.response.add(bytes);
      await r.response.close();
    };
    final owner = authority.requireFence().owner;
    final pending = repo.load(hint: Uri.parse('slow'));
    await seen.future;
    await authority.invalidate();
    await authority.establish(
      owner,
      const TokenPair(accessToken: 'new', refreshToken: 'new-r'),
    );
    gate.complete();
    expect(await pending, isNull);
    await repo.close();
    expect(store.rows, isEmpty);
  });
  test('deadline aborts a hanging response', () async {
    handler = (r) async {};
    final watch = Stopwatch()..start();
    expect(await repo.load(hint: Uri.parse('hang')), isNull);
    expect(watch.elapsed, lessThan(const Duration(seconds: 3)));
  });
  test('explicit offline aborts active response without publishing', () async {
    final seen = Completer<void>();
    handler = (r) async {
      seen.complete();
    };
    final pending = repo.load(hint: Uri.parse('hang'));
    await seen.future;
    policy.offline();
    expect(await pending, isNull);
    expect(store.rows, isEmpty);
  });
  for (final kind in ['html', 'spoof', 'truncated', 'oversize', 'dimensions']) {
    test('rejects $kind image before cache publication', () async {
      handler = (r) async {
        r.response.headers.contentType = ContentType(
          kind == 'html' ? 'text' : 'image',
          kind == 'html' ? 'html' : 'png',
        );
        if (kind == 'oversize') {
          r.response.contentLength = 5 * 1024 * 1024;
        } else if (kind == 'html' || kind == 'spoof') {
          r.response.write('<html>oops</html>');
        } else if (kind == 'dimensions') {
          final data = Uint8List.fromList(bytes);
          ByteData.sublistView(data).setUint32(16, 100000);
          r.response.add(data);
        } else {
          r.response.add(bytes.take(24).toList());
        }
        await r.response.close();
      };
      expect(await repo.load(hint: Uri.parse(kind)), isNull);
      expect(store.rows, isEmpty);
    });
  }
  test('valid decoded dimensions over limit are rejected', () async {
    bytes = await png(width: 8193, height: 1);
    expect(await repo.load(hint: Uri.parse('wide')), isNull);
    expect(store.rows, isEmpty);
  });
  test(
    'close waits for in-flight rename and revoked publication stays absent',
    () async {
      await repo.close();
      final io = BlockingArtworkIo();
      repo = ArtworkRepository(
        authority: authority,
        store: store,
        fence: authority.requireFence(),
        networkPolicy: policy,
        privateRoot: root,
        testSecurityContext: server.clientContext,
        fileIo: io,
      );
      final pending = repo.load(hint: Uri.parse('blocked-rename'));
      await io.started.future;
      var closed = false;
      final closing = repo.close().then((_) {
        closed = true;
      });
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(closed, isFalse);
      io.release.complete();
      expect(await pending, isNull);
      await closing;
      expect(closed, isTrue);
      expect(store.rows, isEmpty);
    },
  );
  test('rename failure never publishes a cache record', () async {
    await repo.close();
    repo = ArtworkRepository(
      authority: authority,
      store: store,
      fence: authority.requireFence(),
      networkPolicy: policy,
      privateRoot: root,
      testSecurityContext: server.clientContext,
      fileIo: FailingArtworkIo(),
    );
    expect(await repo.load(hint: Uri.parse('failed-rename')), isNull);
    expect(store.rows, isEmpty);
    final parts = await root
        .list(recursive: true)
        .where((f) => f.path.endsWith('.part'))
        .toList();
    expect(parts, isEmpty);
  });
  test(
    'distinct identities sharing identical content publish every index',
    () async {
      final files = await Future.wait(
        List.generate(
          9,
          (i) => repo.load(
            ref: LibraryTrackRef('shared-$i'),
            hint: Uri.parse('cover-$i'),
          ),
        ),
      );
      expect(files.whereType<File>(), hasLength(9));
      expect(store.rows, hasLength(9));
      expect(requests, hasLength(9));
    },
  );
  test(
    'new offline repository reads verified private PNG by track identity',
    () async {
      const ref = LibraryTrackRef('restored');
      final first = await repo.load(
        ref: ref,
        hint: Uri.parse('https://cover.test/one?secret=signed'),
      );
      await repo.close();
      policy.offline();
      repo = ArtworkRepository(
        authority: authority,
        store: store,
        fence: authority.requireFence(),
        networkPolicy: policy,
        privateRoot: root,
      );
      expect((await repo.load(ref: ref))?.path, first!.path);
      expect(requests, hasLength(1));
      expect(store.rows.toString(), isNot(contains('signed')));
    },
  );
  test(
    'decoded PNG fits physical edge cap and preserves aspect ratio',
    () async {
      bytes = await png(width: 2048, height: 1024);
      final file = await repo.load(hint: Uri.parse('large'), edge: 5000);
      final buffer = await ui.ImmutableBuffer.fromUint8List(
        await file!.readAsBytes(),
      );
      final descriptor = await ui.ImageDescriptor.encoded(buffer);
      expect(descriptor.width, 1024);
      expect(descriptor.height, 512);
      descriptor.dispose();
      buffer.dispose();
    },
  );
  test('index transaction never invokes external broker while holding storage lock', () async {
    await repo.close();
    final checkedStore = CallbackCheckedStore(authority);
    final checkedAuthority = CallbackCheckedAuthority(authority, checkedStore);
    repo = ArtworkRepository(
      authority: checkedAuthority,
      store: checkedStore,
      fence: authority.requireFence(),
      networkPolicy: policy,
      privateRoot: root,
      testSecurityContext: server.clientContext,
    );
    expect(await repo.load(hint: Uri.parse('transaction')), isNotNull);
    expect(checkedAuthority.blockedCalls, 0);
  });
  test('untrusted TLS certificate is rejected', () async {
    await repo.close();
    repo = ArtworkRepository(
      authority: authority,
      store: store,
      fence: authority.requireFence(),
      networkPolicy: policy,
      privateRoot: root,
    );
    expect(await repo.load(hint: Uri.parse('cover')), isNull);
    expect(requests, isEmpty);
  });
}

class BlockingArtworkIo implements ArtworkFileIo {
  final started = Completer<void>(), release = Completer<void>();
  @override
  Future<void> rename(File source, File target) async {
    started.complete();
    await release.future;
    await source.rename(target.path);
  }
}

class FailingArtworkIo implements ArtworkFileIo {
  @override
  Future<void> rename(File source, File target) async {
    throw const FileSystemException('Injected rename failure');
  }
}

class CallbackCheckedStore extends DownloadTestStore {
  CallbackCheckedStore(super.authority);
  bool inside = false;
  @override
  Future<T> transaction<T>(
    SessionFence fence,
    Future<T> Function(OwnerTransaction) operation,
  ) => super.transaction(fence, (tx) async {
    inside = true;
    try {
      return await operation(tx);
    } finally {
      inside = false;
    }
  });
}

class CallbackCheckedAuthority implements SessionAuthority {
  CallbackCheckedAuthority(this.delegate, this.store);
  final SessionAuthority delegate;
  final CallbackCheckedStore store;
  int blockedCalls = 0;
  @override
  SessionState get state => delegate.state;
  @override
  Stream<SessionState> get changes => delegate.changes;
  @override
  SessionFence requireFence() => delegate.requireFence();
  @override
  bool isCurrent(SessionFence fence) => delegate.isCurrent(fence);
  @override
  Future<void> assertCurrent(SessionFence fence) async {
    if (store.inside) {
      blockedCalls++;
      throw StateError('Would deadlock the session DB');
    }
    await delegate.assertCurrent(fence);
  }

  @override
  Future<AccessGrant> grantAccess(SessionFence fence, Uri exactOrigin) =>
      delegate.grantAccess(fence, exactOrigin);
  @override
  Future<AuthStamp> after401(AuthStamp rejected) => delegate.after401(rejected);
  @override
  Future<void> invalidate() => delegate.invalidate();
}
