import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/features/playlists/playlist_models.dart';
import 'package:soundspan/features/playlists/playlist_repository.dart';
import 'package:soundspan/features/playlists/playlist_controller.dart';
import 'package:soundspan/features/playlists/playlist_detail_screen.dart';
import 'package:soundspan/features/playlists/playlist_editor_sheet.dart';
import 'package:soundspan/features/playlists/playlist_list_screen.dart';
import 'package:soundspan/features/likes/preference_controller.dart';
import 'package:soundspan/design_system/theme.dart';

import '../support/collection_fixtures.dart';

Map<String, Object?> item(int n, {bool pending = false}) => pending
    ? {
        'id': 'pending-$n',
        'type': 'pending',
        'sort': n,
        'playback': {'isPlayable': false, 'reason': 'pending_import'},
        'pending': {
          'id': 'pending-$n',
          'title': 'Ожидающая песня $n',
          'artist': 'Исполнитель',
          'album': 'Альбом',
          'previewUrl': null,
        },
      }
    : {
        'id': 'item-$n',
        'type': 'track',
        'sort': n,
        'playback': {'isPlayable': true},
        'track': {
          'id': 'local-${n % 2}',
          'title': 'Песня $n',
          'duration': 180,
          'filePath': 'server/music.flac',
          'album': {
            'id': 'album',
            'title': 'Альбом',
            'coverArt': null,
            'artist': {'id': 'artist', 'name': 'Исполнитель'},
          },
        },
      };
Map<String, Object?> detail(
  List<Map<String, Object?>> rows, {
  int? total,
  String? cursor,
  bool owner = true,
}) => {
  'id': 'p',
  'name': 'Мой плейлист',
  'isPublic': false,
  'isOwner': owner,
  'isHidden': false,
  'trackCount': rows.where((e) => e['type'] == 'track').length,
  'pendingCount': rows.where((e) => e['type'] == 'pending').length,
  'totalItemCount': total ?? rows.length,
  'mergedItems': rows,
  'truncated': false,
  'pagination': {'limit': 100, 'hasMore': cursor != null, 'nextCursor': cursor},
};
PlaylistRepository repository(
  CollectionAuthority a,
  CollectionTransport t, {
  NetworkPolicy policy = const NetworkPolicy.online(),
}) => PlaylistRepository(
  transport: t,
  authority: a,
  fence: collectionFence,
  networkPolicy: policy,
);

void main() {
  testWidgets(
    'manual order has accessible move controls and saves exact item IDs',
    (tester) async {
      final a = CollectionAuthority();
      final t = CollectionTransport(
        (r, f) => ApiResponse(200, detail([item(0), item(1)])),
      );
      final c = PlaylistController(repository: repository(a, t));
      final p = PreferenceController(
        transport: t,
        authority: a,
        fence: collectionFence,
      );
      addTearDown(c.dispose);
      addTearDown(p.dispose);
      await c.open('p');
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: PlaylistDetailScreen(
            controller: c,
            preferences: p,
            onPlay: (_) async {},
            autoLoad: false,
          ),
        ),
      );
      await tester.tap(find.byTooltip('Действия с плейлистом'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Изменить порядок вручную'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('playlist-move-down-item-0')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Сохранить порядок'));
      await tester.pumpAndSettle();
      expect(t.requests.where((r) => r.method == ApiMethod.put).single.body, {
        'itemIds': ['item-1', 'item-0'],
      });
    },
  );
  test(
    'lost delete reconciles authoritative 404 as deleted without replay',
    () async {
      final a = CollectionAuthority();
      var deleted = false;
      final t = CollectionTransport((r, f) {
        if (r.method == ApiMethod.delete) {
          deleted = true;
          throw TimeoutException('lost');
        }
        if (r.path == '/api/playlists') return const ApiResponse(200, []);
        return deleted
            ? const ApiResponse(404, null)
            : ApiResponse(200, detail([item(0)]));
      });
      final c = PlaylistController(repository: repository(a, t));
      addTearDown(c.dispose);
      await c.open('p');
      await expectLater(c.delete(), throwsA(anything));
      await c.reconcile();
      expect(c.state.deleted, true);
      expect(c.state.reconciled, true);
      expect(c.state.detail, isNull);
      expect(t.requests.where((r) => r.method == ApiMethod.delete).length, 1);
    },
  );
  testWidgets(
    'stale edit sheet cannot rename another playlist on same controller',
    (tester) async {
      final a = CollectionAuthority();
      final t = CollectionTransport(
        (r, f) => ApiResponse(200, {
          ...detail([item(0)]),
          'id': r.path.endsWith('/other') ? 'other' : 'p',
        }),
      );
      final c = PlaylistController(repository: repository(a, t));
      addTearDown(c.dispose);
      await c.open('p');
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: Scaffold(
            body: PlaylistEditorSheet(
              controller: c,
              playlist: c.state.detail!.playlist,
            ),
          ),
        ),
      );
      await tester.enterText(
        find.byKey(const ValueKey('playlist-name')),
        'Нельзя менять другой',
      );
      await c.open('other');
      await tester.pumpAndSettle();
      await tester.tap(find.text('Сохранить изменения'));
      await tester.pumpAndSettle();
      expect(t.requests.where((r) => r.method == ApiMethod.put), isEmpty);
    },
  );
  test(
    'explicit offline policy prevents all HTTP and pending reorder never PUTs',
    () async {
      final a = CollectionAuthority();
      final t = CollectionTransport(
        (r, f) => ApiResponse(200, detail([item(0), item(1, pending: true)])),
      );
      final offline = repository(a, t, policy: const NetworkPolicy.offline());
      await expectLater(offline.page('p', null), throwsA(anything));
      await expectLater(
        offline.create(const PlaylistDraft(name: 'Офлайн')),
        throwsA(anything),
      );
      expect(t.requests, isEmpty);
      final c = PlaylistController(repository: repository(a, t));
      addTearDown(c.dispose);
      await c.open('p');
      await expectLater(c.reorder(['pending-1', 'item-0']), throwsA(anything));
      expect(t.requests.where((r) => r.method == ApiMethod.put), isEmpty);
    },
  );
  test('same-owner new epoch rejects late results and mutation refresh cannot resurrect old rows', () async {
    final a = CollectionAuthority();
    final pending = Completer<ApiResponse>();
    final t = CollectionTransport((r, f) => pending.future);
    final c = PlaylistController(repository: repository(a, t));
    addTearDown(c.dispose);
    final opening = c.open('p');
    await Future<void>.delayed(Duration.zero);
    a.switchOwner();
    a.active = SessionFence(owner: collectionOwner, epoch: 3);
    a.updates.add(a.state);
    pending.complete(ApiResponse(200, detail([item(0)])));
    await opening;
    expect(c.state.stale, true);
    expect(c.state.detail, isNull);
  });
  test('queue snapshot duplicates and mixed unsupported sources are rejected before creating', () async {
    final a = CollectionAuthority();
    final t = CollectionTransport(
      (r, f) => throw StateError('No HTTP expected'),
    );
    final c = PlaylistController(repository: repository(a, t));
    addTearDown(c.dispose);
    await expectLater(
      c.saveQueue(const PlaylistDraft(name: 'Повторы'), [
        collectionTrack(0),
        collectionTrack(0),
      ]),
      throwsA(anything),
    );
    await expectLater(
      c.saveQueue(const PlaylistDraft(name: 'Недоступно'), [
        collectionTrack(0),
        collectionTrack(1, playable: false),
      ]),
      throwsA(anything),
    );
    expect(t.requests, isEmpty);
  });
  testWidgets(
    'play preserves duplicate item positions and skips pending rows',
    (tester) async {
      final a = CollectionAuthority();
      final t = CollectionTransport(
        (r, f) => ApiResponse(
          200,
          detail([item(0), item(1, pending: true), item(2)]),
        ),
      );
      final c = PlaylistController(repository: repository(a, t));
      final p = PreferenceController(
        transport: t,
        authority: a,
        fence: collectionFence,
      );
      addTearDown(c.dispose);
      addTearDown(p.dispose);
      await c.open('p');
      final calls = <int>[];
      final orders = <List<String>>[];
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: PlaylistDetailScreen(
            controller: c,
            preferences: p,
            onPlay: (r) async {
              calls.add(r.startIndex);
              orders.add(r.tracks.map((e) => e.title).toList());
              expect(r.fence, collectionFence);
            },
            autoLoad: false,
          ),
        ),
      );
      await tester.tap(
        find.descendant(
          of: find.byKey(const ValueKey('playlist-row-item-2')),
          matching: find.text('Песня 2'),
        ),
      );
      await tester.pumpAndSettle();
      expect(calls, [1]);
      expect(orders.single, ['Песня 0', 'Песня 2']);
    },
  );
  testWidgets('old A item sheet cannot call replacement B callback', (
    tester,
  ) async {
    final a = CollectionAuthority();
    final t = CollectionTransport(
      (r, f) => ApiResponse(200, detail([item(0)])),
    );
    final ca = PlaylistController(repository: repository(a, t));
    final p = PreferenceController(
      transport: t,
      authority: a,
      fence: collectionFence,
    );
    addTearDown(ca.dispose);
    addTearDown(p.dispose);
    await ca.open('p');
    var sent = 0;
    Widget app(PlaylistController c) => MaterialApp(
      theme: SoundspanTheme.dark(),
      home: PlaylistDetailScreen(
        controller: c,
        preferences: p,
        onPlay: (_) async {},
        onEnqueue: (_) {
          sent++;
        },
        autoLoad: false,
      ),
    );
    await tester.pumpWidget(app(ca));
    await tester.tap(find.byKey(const ValueKey('playlist-item-menu-item-0')));
    await tester.pumpAndSettle();
    a.switchOwner();
    final cb = PlaylistController(
      repository: PlaylistRepository(
        transport: t,
        authority: a,
        fence: a.active!,
      ),
    );
    addTearDown(cb.dispose);
    await cb.open('p');
    await tester.pumpWidget(app(cb));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Добавить в очередь'));
    await tester.pumpAndSettle();
    expect(sent, 0);
  });
  testWidgets(
    'queue editor explains lossy subset and requires explicit review before create',
    (tester) async {
      final a = CollectionAuthority();
      final t = CollectionTransport(
        (r, f) => r.path == '/api/playlists'
            ? ApiResponse(200, {
                'id': 'created',
                'name': 'Очередь',
                'isPublic': false,
              })
            : ApiResponse(200, item(0)),
      );
      final c = PlaylistController(repository: repository(a, t));
      addTearDown(c.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: Scaffold(
            body: PlaylistEditorSheet(
              controller: c,
              queue: [collectionTrack(0), collectionTrack(0)],
            ),
          ),
        ),
      );
      await tester.enterText(
        find.byKey(const ValueKey('playlist-name')),
        'Очередь',
      );
      await tester.tap(find.text('Сохранить уникальные треки').last);
      await tester.pumpAndSettle();
      expect(t.requests, isEmpty);
      expect(
        find.textContaining('1 уникальных совместимых треков из 2'),
        findsOneWidget,
      );
      await tester.tap(find.byType(Checkbox));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Сохранить уникальные треки').last);
      await tester.pumpAndSettle();
      expect(
        t.requests
            .where(
              (r) => r.method == ApiMethod.post && r.path == '/api/playlists',
            )
            .length,
        1,
      );
      expect(t.requests.where((r) => r.path.endsWith('/items')).length, 1);
    },
  );
  for (final width in [320.0, 390.0, 430.0]) {
    for (final scale in [1.0, 2.0]) {
      testWidgets(
        'detail item sheet editor and hidden list width $width scale $scale',
        (tester) async {
          tester.view.physicalSize = Size(width, 1000);
          tester.view.devicePixelRatio = 1;
          addTearDown(tester.view.resetPhysicalSize);
          addTearDown(tester.view.resetDevicePixelRatio);
          final a = CollectionAuthority();
          final long =
              'Очень длинное русское название музыкального произведения для проверки доступности, крупного текста и переноса строк без потери действий';
          final row = item(0);
          (row['track']! as Map<String, Object?>)['title'] = long;
          final dto = {
            ...detail([row]),
            'name': long,
          };
          final t = CollectionTransport(
            (r, f) => ApiResponse(
              200,
              r.path == '/api/playlists'
                  ? [
                      {
                        'id': 'p',
                        'name': long,
                        'isPublic': true,
                        'isOwner': true,
                        'isHidden': false,
                        'trackCount': 1,
                      },
                    ]
                  : dto,
            ),
          );
          final c = PlaylistController(repository: repository(a, t));
          final p = PreferenceController(
            transport: t,
            authority: a,
            fence: collectionFence,
          );
          addTearDown(c.dispose);
          addTearDown(p.dispose);
          await c.open('p');
          Widget app(Widget child) => MaterialApp(
            theme: SoundspanTheme.dark(),
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context)
                  .copyWith(textScaler: TextScaler.linear(scale)),
              child: child!,
            ),
            home: child,
          );
          await tester.pumpWidget(
            app(
              PlaylistDetailScreen(
                controller: c,
                preferences: p,
                onPlay: (_) async {},
                autoLoad: false,
              ),
            ),
          );
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull);
          await tester.ensureVisible(
            find.byKey(const ValueKey('playlist-item-menu-item-0')),
          );
          await tester.tap(
            find.byKey(const ValueKey('playlist-item-menu-item-0')),
          );
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull);
          await tester.binding.handlePopRoute();
          await tester.pumpAndSettle();
          await tester.pumpWidget(
            app(
              Scaffold(
                body: PlaylistEditorSheet(
                  controller: c,
                  playlist: c.state.detail!.playlist,
                ),
              ),
            ),
          );
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull);
          await c.refreshList();
          await tester.pumpWidget(
            app(
              PlaylistListScreen(
                controller: c,
                onOpenPlaylist: (_) async {},
                autoLoad: false,
              ),
            ),
          );
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull);
        },
      );
    }
  }
  test(
    'uncertain create cannot be acknowledged before successful readback',
    () async {
      final a = CollectionAuthority();
      final t = CollectionTransport((r, f) {
        if (r.method == ApiMethod.post) throw TimeoutException('lost');
        return const ApiResponse(503, null);
      });
      final c = PlaylistController(repository: repository(a, t));
      addTearDown(c.dispose);
      await expectLater(
        c.create(const PlaylistDraft(name: 'Плейлист')),
        throwsA(anything),
      );
      c.acknowledgeReconciliation();
      expect(c.state.uncertain, true);
      await c.reconcile();
      c.acknowledgeReconciliation();
      expect(c.state.uncertain, true);
      expect(t.requests.where((r) => r.method == ApiMethod.post).length, 1);
    },
  );
  test('partial queue save retains created destination when add gets 403 and no duplicate create', () async {
    final a = CollectionAuthority();
    final t = CollectionTransport((r, f) {
      if (r.method == ApiMethod.post && r.path == '/api/playlists') {
        return ApiResponse(200, {
          'id': 'created',
          'name': 'Очередь',
          'isPublic': false,
        });
      }
      if (r.method == ApiMethod.post) return const ApiResponse(403, null);
      if (r.path == '/api/playlists/created') {
        return ApiResponse(200, {...detail([]), 'id': 'created'});
      }
      return const ApiResponse(200, []);
    });
    final c = PlaylistController(repository: repository(a, t));
    addTearDown(c.dispose);
    await expectLater(
      c.saveQueue(const PlaylistDraft(name: 'Очередь'), [collectionTrack(0)]),
      throwsA(anything),
    );
    expect(c.state.uncertain, true);
    await c.reconcile();
    expect(c.state.detail?.playlist.id, 'created');
    await expectLater(
      c.saveQueue(const PlaylistDraft(name: 'Очередь'), [collectionTrack(0)]),
      throwsA(anything),
    );
    expect(
      t.requests
          .where(
            (r) => r.method == ApiMethod.post && r.path == '/api/playlists',
          )
          .length,
      1,
    );
  });
  test(
    'lost add after first committed item never resends either payload',
    () async {
      final a = CollectionAuthority();
      var adds = 0;
      final t = CollectionTransport((r, f) {
        if (r.method == ApiMethod.post) {
          adds++;
          if (adds == 2) throw TimeoutException('lost');
          return ApiResponse(200, item(1));
        }
        if (r.path == '/api/playlists') return const ApiResponse(200, []);
        return ApiResponse(200, detail([item(0), item(1)]));
      });
      final c = PlaylistController(repository: repository(a, t));
      addTearDown(c.dispose);
      await c.open('p');
      await expectLater(
        c.add([collectionTrack(1), collectionTrack(2)]),
        throwsA(anything),
      );
      await c.reconcile();
      await expectLater(
        c.add([collectionTrack(1), collectionTrack(2)]),
        throwsA(anything),
      );
      expect(adds, 2);
      expect(c.state.detail!.items.length, 2);
    },
  );
  test('definite rejected reorder rolls optimistic rows back without ambiguous intent', () async {
    final a = CollectionAuthority();
    final t = CollectionTransport(
      (r, f) => r.method == ApiMethod.put
          ? const ApiResponse(403, null)
          : ApiResponse(200, detail([item(0), item(1)])),
    );
    final c = PlaylistController(repository: repository(a, t));
    addTearDown(c.dispose);
    await c.open('p');
    await expectLater(c.reorder(['item-1', 'item-0']), throwsA(anything));
    expect(c.state.detail!.items.map((e) => e.id), ['item-0', 'item-1']);
    expect(c.state.uncertain, false);
  });
  test(
    'pending exact remove path and persisted rename privacy hide unhide delete',
    () async {
      final a = CollectionAuthority();
      var name = 'Исходный';
      var public = false;
      var hidden = false;
      var deleted = false;
      final t = CollectionTransport((r, f) {
        if (r.method == ApiMethod.put) {
          name = r.body!['name'] as String;
          public = r.body!['isPublic'] as bool;
        }
        if (r.path.endsWith('/hide')) {
          hidden = r.method == ApiMethod.post;
          return ApiResponse(200, {'isHidden': hidden});
        }
        if (r.method == ApiMethod.delete && r.path == '/api/playlists/p') {
          deleted = true;
        }
        return ApiResponse(200, {
          ...detail([item(1, pending: true)]),
          'name': name,
          'isPublic': public,
          'isHidden': hidden,
        });
      });
      final c = PlaylistController(repository: repository(a, t));
      addTearDown(c.dispose);
      await c.open('p');
      await c.update(const PlaylistPatch(name: 'Новое', isPublic: true));
      expect(c.state.detail!.playlist.name, 'Новое');
      expect(c.state.detail!.playlist.isPublic, true);
      await c.hide(true);
      expect(c.state.detail!.playlist.isHidden, true);
      await c.hide(false);
      expect(c.state.detail!.playlist.isHidden, false);
      await c.remove(c.state.detail!.items.single);
      expect(
        t.requests.any(
          (r) =>
              r.path == '/api/playlists/p/pending/pending-1' &&
              r.method == ApiMethod.delete,
        ),
        true,
      );
      await c.delete();
      expect(deleted, true);
      expect(c.state.deleted, true);
      expect(c.state.detail, isNull);
    },
  );
  test('offlineValidated uses online network but explicit policy rejects mutation before HTTP', () async {
    final a = CollectionAuthority()..restoreLocally();
    final t = CollectionTransport(
      (r, f) => ApiResponse(200, detail([item(0)])),
    );
    await repository(a, t).page('p', null);
    expect(t.requests.length, 1);
  });
  test('101 merged rows keep pending and duplicate track occurrences across opaque cursor', () async {
    final a = CollectionAuthority();
    final t = CollectionTransport(
      (r, f) => ApiResponse(
        200,
        r.query['cursor'] == null
            ? detail(
                List.generate(100, (n) => item(n, pending: n == 1)),
                total: 101,
                cursor: 'opaque==',
              )
            : detail([item(100)], total: 101),
      ),
    );
    final c = PlaylistController(repository: repository(a, t));
    addTearDown(c.dispose);
    await c.open('p');
    await c.loadMore();
    expect(c.state.detail!.items.length, 101);
    expect(c.state.detail!.items[1].pending, true);
    expect(
      c.state.detail!.items[0].track.ref,
      c.state.detail!.items[2].track.ref,
    );
    expect(t.requests.last.query['cursor'], 'opaque==');
    expect(c.state.detail!.complete, true);
  });
  test(
    '1000 complete exact item IDs reorder but incomplete and 1001 never PUT',
    () async {
      for (final count in [1000, 1001]) {
        final a = CollectionAuthority();
        final t = CollectionTransport((r, f) {
          if (r.method == ApiMethod.put) {
            return const ApiResponse(200, {'message': 'Playlist reordered'});
          }
          final start = int.parse(r.query['cursor'] ?? '0');
          final end = (start + 100).clamp(0, count);
          return ApiResponse(
            200,
            detail(
              List.generate(end - start, (n) => item(start + n)),
              total: count,
              cursor: end < count ? '$end' : null,
            ),
          );
        });
        final c = PlaylistController(repository: repository(a, t));
        await c.open('p');
        while (c.state.detail!.hasMore) {
          await c.loadMore();
        }
        final ids = c.state.detail!.items.reversed.map((e) => e.id).toList();
        if (count == 1000) {
          await c.reorder(ids);
          expect(
            t.requests.where((r) => r.method == ApiMethod.put).single.body,
            {'itemIds': ids},
          );
        } else {
          await expectLater(c.reorder(ids), throwsA(anything));
          expect(t.requests.where((r) => r.method == ApiMethod.put), isEmpty);
        }
        c.dispose();
      }
      final a = CollectionAuthority();
      final t = CollectionTransport(
        (r, f) => ApiResponse(200, detail([item(0)], total: 2, cursor: 'next')),
      );
      final c = PlaylistController(repository: repository(a, t));
      await c.open('p');
      await expectLater(c.reorder(['item-0']), throwsA(anything));
      expect(t.requests.where((r) => r.method == ApiMethod.put), isEmpty);
      c.dispose();
    },
  );
  test('lost create response blocks second submission and reconciliation only GETs', () async {
    final a = CollectionAuthority();
    var created = false;
    final t = CollectionTransport((r, f) {
      if (r.method == ApiMethod.post) {
        created = true;
        throw TimeoutException('lost');
      }
      return ApiResponse(
        200,
        created
            ? [
                {
                  'id': 'new',
                  'name': 'Новый',
                  'isPublic': false,
                  'isOwner': true,
                  'isHidden': false,
                  'trackCount': 0,
                },
              ]
            : [],
      );
    });
    final c = PlaylistController(repository: repository(a, t));
    addTearDown(c.dispose);
    await expectLater(
      c.create(const PlaylistDraft(name: 'Новый')),
      throwsA(anything),
    );
    await expectLater(
      c.create(const PlaylistDraft(name: 'Новый')),
      throwsA(anything),
    );
    await c.reconcile();
    expect(t.requests.where((r) => r.method == ApiMethod.post).length, 1);
    expect(c.state.playlists.single.id, 'new');
    expect(c.state.uncertain, true);
  });
  test(
    'late owner A read is discarded and A repository rejects subsequent writes',
    () async {
      final a = CollectionAuthority();
      final response = Completer<ApiResponse>();
      final t = CollectionTransport((r, f) => response.future);
      final c = PlaylistController(repository: repository(a, t));
      addTearDown(c.dispose);
      final future = c.open('p');
      await Future<void>.delayed(Duration.zero);
      a.switchOwner();
      response.complete(ApiResponse(200, detail([item(0)])));
      await future;
      expect(c.state.stale, true);
      expect(c.state.detail, isNull);
      await expectLater(
        c.create(const PlaylistDraft(name: 'Чужой')),
        throwsA(anything),
      );
      expect(t.requests.length, 1);
    },
  );
  test(
    'library Youtube and native exact add payloads retain input order',
    () async {
      final a = CollectionAuthority();
      final t = CollectionTransport((r, f) => ApiResponse(200, item(0)));
      final repo = repository(a, t);
      await repo.add('p', [
        const Track(
          ref: LibraryTrackRef('exact'),
          title: 'Локальная',
          artist: 'Артист',
        ),
        const Track(
          ref: YoutubeTrackRef('video'),
          title: 'Видео',
          artist: 'Артист',
          album: 'Сингл',
          duration: Duration(seconds: 181),
        ),
      ]);
      expect(t.requests[0].body, {'trackId': 'exact'});
      expect(t.requests[1].body, {
        'youtubeVideoId': 'video',
        'title': 'Видео',
        'artist': 'Артист',
        'album': 'Сингл',
        'duration': 181,
      });
      final native = Track(
        ref: NativeTrackRef(
          MusicRecording(
            provider: NativeMusicProvider.vk,
            id: '-1_2',
            title: 'Трек',
            artists: ['Артист'],
            durationSeconds: 180,
            contentVersion: MusicContentVersion.unknown,
          ),
        ),
        title: 'Трек',
        artist: 'Артист',
      );
      await repo.add('p', [
        const Track(ref: LibraryTrackRef('other'), title: 'A', artist: 'B'),
        native,
      ]);
      expect(t.requests.length, 4);
      expect(t.requests[2].body, {'trackId': 'other'});
      expect(t.requests[3].body, {
        'musicSourceRecording': (native.ref as NativeTrackRef).recording
            .toJson(),
      });
    },
  );
  test('foreign detail rejects mutation without request and direct repository 403 stays 403', () async {
    final a = CollectionAuthority();
    final t = CollectionTransport(
      (r, f) => r.method == ApiMethod.get
          ? ApiResponse(200, detail([item(0)], owner: false))
          : const ApiResponse(403, null),
    );
    final c = PlaylistController(repository: repository(a, t));
    addTearDown(c.dispose);
    await c.open('p');
    await expectLater(
      c.update(const PlaylistPatch(name: 'Чужой')),
      throwsA(anything),
    );
    expect(t.requests.length, 1);
    await expectLater(
      c.repository.delete('p'),
      throwsA(predicate((e) => e.toString().contains('http_error'))),
    );
    expect(t.requests.length, 2);
  });
  testWidgets(
    'single first row overflow opens real item actions and Back dismisses',
    (tester) async {
      final a = CollectionAuthority();
      final t = CollectionTransport(
        (r, f) => ApiResponse(200, detail([item(0)])),
      );
      final c = PlaylistController(repository: repository(a, t));
      final p = PreferenceController(
        transport: t,
        authority: a,
        fence: collectionFence,
      );
      addTearDown(c.dispose);
      addTearDown(p.dispose);
      await c.open('p');
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: PlaylistDetailScreen(
            controller: c,
            preferences: p,
            onPlay: (_) async {},
            autoLoad: false,
          ),
        ),
      );
      await tester.tap(find.byKey(const ValueKey('playlist-item-menu-item-0')));
      await tester.pumpAndSettle();
      expect(find.text('Удалить из плейлиста'), findsOneWidget);
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(find.text('Удалить из плейлиста'), findsNothing);
      expect(t.requests.where((r) => r.method == ApiMethod.delete), isEmpty);
    },
  );
}
