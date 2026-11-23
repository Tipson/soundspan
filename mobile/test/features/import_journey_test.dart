import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/material.dart';
import 'package:soundspan/app/native_documents.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/storage/owner_store.dart';
import 'package:soundspan/design_system/theme.dart';
import 'package:soundspan/features/imports/import_screen.dart';
import 'package:soundspan/features/imports/import_job_screen.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/features/imports/import_models.dart';
import 'package:soundspan/features/imports/import_repository.dart';
import 'package:soundspan/features/imports/import_controller.dart';

import '../support/collection_fixtures.dart';
import '../support/import_fixtures.dart';

Map<String, Object?> job({
  String status = 'resolving',
  int unresolved = 1,
  String? playlist,
}) => {
  'id': 'j1',
  'userId': 'a',
  'sourceType': 'yandex',
  'sourceId': 'owner:42',
  'sourceUrl': 'https://music.yandex.ru/users/owner/playlists/42',
  'normalizedSource': 'yandex:owner:42',
  'playlistName': 'Название',
  'requestedPlaylistName': null,
  'status': status,
  'progress': 40,
  'summary': {
    'total': 2,
    'local': 1,
    'youtube': 0,
    'tidal': 0,
    'unresolved': unresolved,
  },
  'createdPlaylistId': playlist,
  'resolutionStartedAt': null,
  'resolutionProcessed': 1,
  'resolutionAttempt': 0,
  'estimatedRemainingSeconds': null,
  'error': null,
  'createdAt': '2026-10-15T00:00:00Z',
  'updatedAt': '2026-10-15T00:00:01Z',
};
Map<String, Object?> preview() => {
  'playlistName': 'Файл',
  'resolved': [
    {
      'index': 0,
      'artist': 'Автор',
      'title': 'Песня',
      'source': 'local',
      'trackId': 'local-1',
      'confidence': 1,
    },
    {
      'index': 1,
      'artist': 'Автор',
      'title': 'Не найдена',
      'source': 'unresolved',
      'confidence': 0,
    },
  ],
  'summary': {
    'total': 2,
    'local': 1,
    'youtube': 0,
    'tidal': 0,
    'unresolved': 1,
  },
};
ImportController controller(
  CollectionAuthority a,
  CollectionTransport t, {
  NetworkPolicy policy = const NetworkPolicy.online(),
  OwnerStore? store,
}) => ImportController(
  repository: ImportRepository(
    transport: t,
    authority: a,
    fence: collectionFence,
    networkPolicy: policy,
    store: store,
  ),
);
void main() {
  WidgetController.hitTestWarningShouldBeFatal = true;
  testWidgets(
    'job list opens detail and Back retains input without another submit',
    (tester) async {
      final a = CollectionAuthority();
      final t = CollectionTransport(
        (r, f) => ApiResponse(
          200,
          r.path.endsWith('/j1')
              ? {'job': job(status: 'completed', playlist: 'p1')}
              : {
                  'jobs': [job(status: 'completed', playlist: 'p1')],
                },
        ),
      );
      final c = controller(a, t);
      addTearDown(c.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: ImportScreen(
            controller: c,
            pickDocument: () async => null,
            onOpenPlaylist: (_) {},
            initialUrl: 'https://open.spotify.com/playlist/saved',
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.text('Название'),
        300,
        scrollable: find
            .descendant(
              of: find.byType(CustomScrollView),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      await tester.pump();
      await tester.tap(find.text('Название'));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(find.text('Задание импорта'), findsOneWidget);
      await tester.pageBack();
      await tester.pumpAndSettle();
      expect(
        find.widgetWithText(
          TextField,
          'https://open.spotify.com/playlist/saved',
        ),
        findsOneWidget,
      );
      expect(t.requests.every((r) => r.method == ApiMethod.get), isTrue);
    },
  );
  test(
    'close revokes admission immediately and drains an in-flight read',
    () async {
      final a = CollectionAuthority();
      final pending = Completer<ApiResponse>();
      final t = CollectionTransport((r, f) => pending.future);
      final c = controller(a, t);
      final reading = c.refresh();
      await Future<void>.delayed(Duration.zero);
      bool closed = false;
      final closing = c.close().then((_) => closed = true);
      await Future<void>.delayed(Duration.zero);
      expect(closed, isFalse);
      await c.submit('https://music.yandex.ru/users/owner/playlists/42');
      expect(t.requests.length, 1);
      pending.complete(
        ApiResponse(200, {
          'jobs': [job()],
        }),
      );
      await reading;
      await closing;
      expect(closed, isTrue);
      expect(c.state.jobs, isEmpty);
    },
  );
  test('DTO source IDs survive detached preview; retired entries are not importable', () {
    final dto = preview();
    final parsed = ImportPreview.fromJson(dto);
    (dto['resolved'] as List).clear();
    final exposed = parsed.json;
    (exposed['resolved'] as List).clear();
    expect(parsed.json['resolved'], hasLength(2));
    final retired = ImportPreview.fromJson({
      'playlistName': 'Старый',
      'resolved': [
        {
          'index': 0,
          'artist': 'Автор',
          'title': 'Запись',
          'source': 'tidal',
          'trackTidalId': '123',
          'confidence': 1,
        },
      ],
      'summary': {
        'total': 1,
        'local': 0,
        'youtube': 0,
        'tidal': 1,
        'unresolved': 0,
      },
    });
    expect(retired.summary.importable, 0);
    expect(retired.tracks.single.importable, isFalse);
  });
  testWidgets('1001 jobs lazy in landscape with keyboard and large text', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(844, 390);
    tester.view.devicePixelRatio = 1;
    tester.view.viewInsets = const FakeViewPadding(bottom: 160);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetViewInsets);
    final a = CollectionAuthority();
    final t = CollectionTransport(
      (r, f) => ApiResponse(200, {
        'jobs': List.generate(
          1001,
          (i) => {
            ...job(status: 'completed', playlist: 'p$i'),
            'id': 'j$i',
            'playlistName':
                'Очень длинное название музыкального плейлиста номер $i',
          },
        ),
      }),
    );
    final c = controller(a, t);
    addTearDown(c.dispose);
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: SoundspanTheme.dark(),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: const TextScaler.linear(2)),
          child: child!,
        ),
        home: ImportScreen(
          controller: c,
          pickDocument: () async => null,
          onOpenPlaylist: (_) {},
          autoLoad: false,
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await tester.drag(find.byType(CustomScrollView), const Offset(0, -4000));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.byType(ListTile).evaluate().length, lessThan(30));
    expect(
      find.text('Очень длинное название музыкального плейлиста номер 1000'),
      findsNothing,
    );
  });
  test(
    'lost M3U execute durable guard survives reopen and never GET-acknowledges',
    () async {
      final a = CollectionAuthority();
      final store = ImportMemoryStore();
      var executes = 0;
      final t = CollectionTransport((r, f) {
        if (r.path.endsWith('/preview')) return ApiResponse(200, preview());
        if (r.path.endsWith('/execute')) {
          executes++;
          expect(store.values.length, 1);
          throw TimeoutException('lost');
        }
        return ApiResponse(200, {
          'jobs': [job(status: 'completed', playlist: 'old')],
        });
      });
      final first = controller(a, t, store: store);
      await first.previewM3u('song.mp3', name: 'Файл');
      await first.execute();
      expect(first.state.uncertain, isTrue);
      await first.close();
      final next = controller(a, t, store: store);
      addTearDown(next.dispose);
      await next.refresh();
      expect(next.state.uncertain, isTrue);
      await next.previewM3u('song.mp3');
      await next.execute();
      expect(executes, 1);
      expect(store.values.values.single.containsKey('fingerprint'), isTrue);
      expect(store.values.values.single.containsKey('previewData'), isFalse);
      await next.acknowledgeDuplicateRisk();
      expect(next.state.uncertain, isFalse);
      expect(executes, 1);
      expect(store.values, isEmpty);
    },
  );
  test('checkpoint storage failure admits zero POST; owner cannot read another pending', () async {
    final a = CollectionAuthority();
    final store = ImportMemoryStore()..failWrites = true;
    final t = CollectionTransport((r, f) => throw StateError('must not send'));
    final c = controller(a, t, store: store);
    addTearDown(c.dispose);
    await c.submit('music.yandex.ru/users/owner/playlists/42');
    expect(t.requests, isEmpty);
    expect(c.state.failure, isNotNull);
  });
  test(
    'cancel and retry use existing exact job; lost responses do not replay',
    () async {
      final a = CollectionAuthority();
      var posts = 0;
      final t = CollectionTransport((r, f) {
        if (r.method == ApiMethod.post) {
          posts++;
          throw TimeoutException('lost');
        }
        return ApiResponse(200, {
          'jobs': [job(status: 'completed', playlist: 'p1')],
        });
      });
      final c = controller(a, t);
      addTearDown(c.dispose);
      await c.refresh();
      await c.retry(c.state.jobs.single);
      await c.retry(c.state.jobs.single);
      expect(posts, 1);
      expect(t.requests.last.path, '/api/import/jobs/j1/retry');
      expect(c.state.uncertain, isTrue);
      await c.refresh();
      expect(c.state.uncertain, isTrue);
      final a2 = CollectionAuthority();
      final t2 = CollectionTransport(
        (r, f) => ApiResponse(
          200,
          r.method == ApiMethod.get
              ? {
                  'jobs': [job()],
                }
              : {'job': job(status: 'cancelling')},
        ),
      );
      final c2 = controller(a2, t2);
      addTearDown(c2.dispose);
      await c2.refresh();
      await c2.cancel(c2.state.jobs.single);
      expect(c2.state.selected!.status, 'cancelling');
      expect(t2.requests.last.path, '/api/import/jobs/j1/cancel');
      expect(t2.requests.last.body, isNull);
    },
  );
  test('same submission in flight is sent once, response must match source and owner', () async {
    final a = CollectionAuthority();
    final pending = Completer<ApiResponse>();
    final t = CollectionTransport((r, f) => pending.future);
    final c = controller(a, t);
    addTearDown(c.dispose);
    final first = c.submit('music.yandex.ru/users/owner/playlists/42');
    await Future<void>.delayed(Duration.zero);
    await c.submit('music.yandex.ru/users/owner/playlists/42');
    expect(t.requests.length, 1);
    pending.complete(
      ApiResponse(202, {
        'deduped': false,
        'job': {...job(), 'userId': 'b'},
      }),
    );
    await first;
    expect(c.state.uncertain, isTrue);
    expect(c.state.jobs, isEmpty);
  });
  test(
    'reopen existing completed job is GET only and retains unavailable counts',
    () async {
      final a = CollectionAuthority();
      final t = CollectionTransport(
        (r, f) =>
            ApiResponse(200, {'job': job(status: 'completed', playlist: 'p1')}),
      );
      final c = controller(a, t);
      addTearDown(c.dispose);
      await c.openJob('j1');
      expect(c.state.selected!.playlistId, 'p1');
      expect(c.state.selected!.summary.unresolved, 1);
      expect(c.state.selected!.canRetry, isTrue);
      expect(t.requests.single.method, ApiMethod.get);
    },
  );
  test('private unavailable preview is failure, oversized and empty M3U make zero HTTP', () async {
    final a = CollectionAuthority();
    final t = CollectionTransport(
      (r, f) => const ApiResponse(400, {'error': 'private'}),
    );
    final c = controller(a, t);
    addTearDown(c.dispose);
    await c.previewM3u('');
    await c.previewM3u('a' * (512 * 1024 + 1));
    expect(t.requests, isEmpty);
    await c.previewUrl('https://open.spotify.com/playlist/secret');
    expect(c.state.failure, isA<AppFailure>());
    expect(c.state.preview, isNull);
    expect(c.state.uncertain, isFalse);
  });
  testWidgets(
    'prefilled URL is display only; picker cancellation makes no POST',
    (tester) async {
      final a = CollectionAuthority();
      final t = CollectionTransport(
        (r, f) => const ApiResponse(200, {'jobs': []}),
      );
      final c = controller(a, t);
      addTearDown(c.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          home: ImportScreen(
            controller: c,
            pickDocument: () async => null,
            onOpenPlaylist: (_) {},
            initialUrl: 'https://open.spotify.com/playlist/abc',
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(t.requests.every((r) => r.method == ApiMethod.get), isTrue);
      await tester.scrollUntilVisible(
        find.text('Выбрать файл M3U'),
        200,
        scrollable: find
            .descendant(
              of: find.byType(CustomScrollView),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      await tester.pump();
      await tester.tap(find.text('Выбрать файл M3U'));
      await tester.pumpAndSettle();
      expect(t.requests.length, 1);
    },
  );
  testWidgets(
    'visible foreground polls; hidden TickerMode and background stop HTTP',
    (tester) async {
      final a = CollectionAuthority();
      final t = CollectionTransport(
        (r, f) => ApiResponse(200, {
          'jobs': [job()],
        }),
      );
      final c = controller(a, t);
      addTearDown(c.dispose);
      final visible = ValueNotifier(true);
      addTearDown(visible.dispose);
      Widget screen(bool tickers) => MaterialApp(
        home: TickerMode(
          enabled: tickers,
          child: ImportScreen(
            controller: c,
            pickDocument: () async => null,
            onOpenPlaylist: (_) {},
            foreground: visible,
          ),
        ),
      );
      await tester.pumpWidget(screen(true));
      await tester.pump();
      expect(t.requests.length, 1);
      await tester.pump(const Duration(seconds: 5));
      await tester.pump();
      expect(t.requests.length, 2);
      visible.value = false;
      await tester.pump();
      final count = t.requests.length;
      await tester.pump(const Duration(seconds: 20));
      expect(t.requests.length, count);
      visible.value = true;
      await tester.pumpWidget(screen(false));
      await tester.pump(const Duration(seconds: 20));
      expect(t.requests.length, count);
      await tester.pumpWidget(const SizedBox());
    },
  );
  for (final width in [320.0, 390.0, 430.0]) {
    testWidgets('preview 1001 rows is lazy at width $width scale 2', (
      tester,
    ) async {
      tester.view.physicalSize = Size(width, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final rows = List.generate(
        1001,
        (i) => {
          'index': i,
          'artist': 'Длинное имя исполнителя',
          'title': 'Запись номер $i',
          'source': 'unresolved',
          'confidence': 0,
        },
      );
      final a = CollectionAuthority();
      final t = CollectionTransport(
        (r, f) => ApiResponse(200, {
          'playlistName': 'Большой файл',
          'resolved': rows,
          'summary': {
            'total': 1001,
            'local': 0,
            'youtube': 0,
            'tidal': 0,
            'unresolved': 1001,
          },
        }),
      );
      final c = controller(a, t);
      addTearDown(c.dispose);
      await c.previewM3u('a.mp3');
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: const TextScaler.linear(2)),
            child: child!,
          ),
          home: ImportScreen(
            controller: c,
            pickDocument: () async => null,
            onOpenPlaylist: (_) {},
            autoLoad: false,
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(find.text('1001. Запись номер 1000'), findsNothing);
      await tester.drag(find.byType(CustomScrollView), const Offset(0, -1700));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(find.byType(ListTile).evaluate().length, lessThan(30));
    });
  }
  testWidgets('Back during native picker never posts or pops a newer route', (
    tester,
  ) async {
    final a = CollectionAuthority();
    final t = CollectionTransport(
      (r, f) => const ApiResponse(200, {'jobs': []}),
    );
    final c = controller(a, t);
    addTearDown(c.dispose);
    final picker = Completer<PlaylistDocument?>();
    final nav = GlobalKey<NavigatorState>();
    await tester.pumpWidget(
      MaterialApp(
        navigatorKey: nav,
        home: const Scaffold(body: Text('Начало')),
      ),
    );
    nav.currentState!.push(
      MaterialPageRoute<void>(
        builder: (_) => ImportScreen(
          controller: c,
          pickDocument: () => picker.future,
          onOpenPlaylist: (_) {},
          autoLoad: false,
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(
      find.text('Выбрать файл M3U'),
      200,
      scrollable: find
          .descendant(
            of: find.byType(CustomScrollView),
            matching: find.byType(Scrollable),
          )
          .first,
    );
    await tester.pump();
    await tester.tap(find.text('Выбрать файл M3U'));
    await tester.pump();
    nav.currentState!.pop();
    nav.currentState!.push(
      MaterialPageRoute<void>(
        builder: (_) => const Scaffold(body: Text('Другой экран')),
      ),
    );
    await tester.pumpAndSettle();
    picker.complete(
      const PlaylistDocument(name: 'Плейлист', content: 'song.mp3'),
    );
    await tester.pumpAndSettle();
    expect(t.requests, isEmpty);
    expect(find.text('Другой экран'), findsOneWidget);
  });
  testWidgets('completed job can open playlist without mutation', (
    tester,
  ) async {
    final a = CollectionAuthority();
    final t = CollectionTransport(
      (r, f) =>
          ApiResponse(200, {'job': job(status: 'completed', playlist: 'p1')}),
    );
    final c = controller(a, t);
    addTearDown(c.dispose);
    String? opened;
    await tester.pumpWidget(
      MaterialApp(
        home: ImportJobScreen(
          controller: c,
          jobId: 'j1',
          onOpenPlaylist: (id) => opened = id,
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Открыть плейлист'));
    expect(opened, 'p1');
    expect(t.requests.single.method, ApiMethod.get);
  });
  test('known exact URL identities and unsafe URL rejection', () {
    expect(
      ImportSource.parse('music.yandex.ru/users/Owner/playlists/00042')
          .identity,
      'yandex:owner:42',
    );
    expect(
      ImportSource.parse('https://open.spotify.com/playlist/AbC?si=ignored')
          .identity,
      'spotify:AbC',
    );
    expect(
      ImportSource.parse('https://www.deezer.com/ru/playlist/123').identity,
      'deezer:123',
    );
    expect(
      ImportSource.parse('https://music.youtube.com/playlist?list=PL_ab')
          .identity,
      'youtube:PL_ab',
    );
    for (final url in [
      'https://evil.deezer.com/playlist/1',
      'https://user@open.spotify.com/playlist/a',
      'https://youtube.com:443/playlist?list=a',
      'https://vk.com/music/playlist/1',
      'ftp://open.spotify.com/playlist/a',
      'https://open.spotify.com/playlist/a#fragment',
    ]) {
      expect(() => ImportSource.parse(url), throwsA(anything));
    }
  });
  test('lost submission reconciles by reads and never resubmits', () async {
    final a = CollectionAuthority();
    var submits = 0;
    final t = CollectionTransport((r, f) {
      if (r.method == ApiMethod.post) {
        submits++;
        throw TimeoutException('lost');
      }
      return ApiResponse(200, {
        'jobs': [job()],
      });
    });
    final c = controller(a, t);
    addTearDown(c.dispose);
    await c.submit('https://music.yandex.ru/users/owner/playlists/42');
    expect(c.state.uncertain, isTrue);
    await c.submit('https://music.yandex.ru/users/owner/playlists/42');
    expect(submits, 1);
    await c.refresh();
    expect(c.state.jobs.single.id, 'j1');
    expect(c.state.uncertain, isTrue);
    expect(submits, 1);
  });
  test('M3U preview only then explicit execute preserves source IDs', () async {
    final a = CollectionAuthority();
    final t = CollectionTransport(
      (r, f) => ApiResponse(
        200,
        r.path.endsWith('/preview')
            ? preview()
            : {'playlistId': 'p1', 'summary': preview()['summary']},
      ),
    );
    final c = controller(a, t);
    addTearDown(c.dispose);
    await c.previewM3u('#EXTM3U\nsong.mp3', name: 'Файл');
    expect(t.requests.length, 1);
    expect(c.state.preview!.tracks.length, 2);
    await c.execute();
    expect(t.requests.last.path, '/api/import/execute');
    expect(
      (t.requests.last.body!['previewData'] as Map)['resolved'],
      preview()['resolved'],
    );
    expect(c.state.outcome!.playlistId, 'p1');
  });
  test('explicit offline denies HTTP; restored online owner allowed', () async {
    final a = CollectionAuthority()..restoreLocally();
    final t = CollectionTransport(
      (r, f) => ApiResponse(200, {
        'jobs': [job()],
      }),
    );
    final off = controller(a, t, policy: const NetworkPolicy.offline());
    addTearDown(off.dispose);
    await off.refresh();
    expect(t.requests, isEmpty);
    final on = controller(a, t);
    addTearDown(on.dispose);
    await on.refresh();
    expect(on.state.jobs.length, 1);
    expect(t.fences.single, collectionFence);
  });
  test('owner switch while awaiting cannot publish old job', () async {
    final a = CollectionAuthority();
    final pending = Completer<ApiResponse>();
    final t = CollectionTransport((r, f) => pending.future);
    final c = controller(a, t);
    addTearDown(c.dispose);
    final work = c.refresh();
    await Future<void>.delayed(Duration.zero);
    a.switchOwner();
    pending.complete(
      ApiResponse(200, {
        'jobs': [job()],
      }),
    );
    await work;
    expect(c.state.jobs, isEmpty);
    expect(c.isCurrent, isFalse);
  });
}
