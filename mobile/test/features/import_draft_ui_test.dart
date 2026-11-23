import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/design_system/design_system.dart';
import 'package:soundspan/features/imports/import_draft_controller.dart';
import 'package:soundspan/features/imports/import_draft_screen.dart';
import 'package:soundspan/features/imports/import_repository.dart';
import 'package:soundspan/features/imports/import_controller.dart';
import 'package:soundspan/features/imports/import_screen.dart';

import '../support/collection_fixtures.dart';
import '../support/import_draft_fixtures.dart';

void main() {
  testWidgets(
    'replacing the owner controller clears unsubmitted private text',
    (tester) async {
      final authority = CollectionAuthority();
      final transport = CollectionTransport(
        (_, _) => ApiResponse(200, {'jobs': []}),
      );
      ImportDraftController create() => ImportDraftController(
        repository: ImportRepository(
          transport: transport,
          authority: authority,
          fence: authority.active!,
          networkPolicy: const NetworkPolicy.online(),
        ),
        supported: () => true,
      );
      final first = create();
      addTearDown(first.close);
      Widget app(ImportDraftController c) => MaterialApp(
        home: ImportDraftScreen(
          controller: c,
          pickDocument: () async => null,
          onOpenPlaylist: (_) {},
        ),
      );
      await tester.pumpWidget(app(first));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.widgetWithText(TextField, 'Список треков'),
        'PRIVATE OLD OWNER TEXT',
      );
      authority.switchOwner();
      final second = create();
      addTearDown(second.close);
      await tester.pumpWidget(app(second));
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<TextField>(find.widgetWithText(TextField, 'Список треков'))
            .controller!
            .text,
        isEmpty,
      );
    },
  );
  testWidgets(
    'text import entry is optional and Back returns to the existing URL form',
    (tester) async {
      final authority = CollectionAuthority();
      final repository = ImportRepository(
        transport: CollectionTransport(
          (_, _) => ApiResponse(200, {'jobs': []}),
        ),
        authority: authority,
        fence: collectionFence,
        networkPolicy: const NetworkPolicy.online(),
      );
      final legacy = ImportController(repository: repository);
      addTearDown(legacy.close);
      Widget app({WidgetBuilder? draftBuilder}) => MaterialApp(
        home: ImportScreen(
          controller: legacy,
          pickDocument: () async => null,
          onOpenPlaylist: (_) {},
          autoLoad: false,
          draftBuilder: draftBuilder,
        ),
      );
      await tester.pumpWidget(app());
      expect(find.text('Текст или экспорт'), findsNothing);
      await tester.pumpWidget(
        app(
          draftBuilder: (_) =>
              Scaffold(appBar: AppBar(title: const Text('Черновик'))),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Текст или экспорт'));
      await tester.pumpAndSettle();
      expect(find.text('Черновик'), findsOneWidget);
      await tester.tap(find.byType(BackButton));
      await tester.pumpAndSettle();
      expect(find.text('Ссылка на плейлист'), findsOneWidget);
    },
  );
  testWidgets(
    'preview requires a category choice and keeps 320px text2 usable',
    (tester) async {
      final authority = CollectionAuthority();
      final transport = CollectionTransport(
        (r, _) => ApiResponse(200, {
          'job': draftJobDto(
            status: r.path.endsWith('/confirm')
                ? 'pending'
                : 'awaiting_confirmation',
          ),
        }),
      );
      final c = ImportDraftController(
        repository: ImportRepository(
          transport: transport,
          authority: authority,
          fence: collectionFence,
          networkPolicy: const NetworkPolicy.online(),
        ),
        supported: () => true,
      );
      addTearDown(c.close);
      await c.open('draft-1');
      tester.view.physicalSize = const Size(320, 700);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(
        MaterialApp(
          theme: SoundspanTheme.dark(),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: TextScaler.linear(2)),
            child: child!,
          ),
          home: ImportDraftScreen(
            controller: c,
            pickDocument: () async => null,
            onOpenPlaylist: (_) {},
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(c.selection, isEmpty);
      final confirm = find.widgetWithText(MusicButton, 'Добавить выбранное');
      expect(tester.widget<MusicButton>(confirm).onPressed, isNull);
      await tester.drag(find.byType(CustomScrollView), const Offset(0, -500));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Плейлисты'));
      await tester.pumpAndSettle();
      expect(tester.widget<MusicButton>(confirm).onPressed, isNotNull);
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets('old unsupported server displays no mutation form', (
    tester,
  ) async {
    final authority = CollectionAuthority();
    final transport = CollectionTransport((_, _) => throw StateError('No API'));
    final c = ImportDraftController(
      repository: ImportRepository(
        transport: transport,
        authority: authority,
        fence: collectionFence,
        networkPolicy: const NetworkPolicy.online(),
      ),
      supported: () => false,
    );
    addTearDown(c.close);
    await tester.pumpWidget(
      MaterialApp(
        theme: SoundspanTheme.dark(),
        home: ImportDraftScreen(
          controller: c,
          pickDocument: () async => null,
          onOpenPlaylist: (_) {},
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Найти совпадения'), findsNothing);
    expect(transport.requests, isEmpty);
  });
}
