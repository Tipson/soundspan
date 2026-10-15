import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/artwork/artwork_loader.dart';
import 'package:soundspan/artwork/artwork_scope.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/design_system/artwork.dart';

import 'artwork_repository_test.dart' show png;

class Loader extends ChangeNotifier implements ArtworkLoader {
  Loader(int epoch)
    : fence = SessionFence(
        owner: OwnerKey(
          serverOrigin: Uri.parse('https://example.test'),
          userId: 'a',
        ),
        epoch: epoch,
      );
  @override
  final SessionFence fence;
  @override
  bool isCurrent = true;
  int calls = 0;
  final result = Completer<File?>();
  @override
  Future<File?> load({TrackRef? ref, Uri? hint, int edge = 512}) {
    calls++;
    return result.future;
  }

  void revoke() {
    isCurrent = false;
    notifyListeners();
  }
}

void main() {
  testWidgets('unscoped artwork has neutral fallback and no network image', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(home: Artwork(uri: Uri.parse('https://foreign.test/image'))),
    );
    expect(find.byType(Image), findsNothing);
    expect(find.byIcon(Icons.music_note_rounded), findsOneWidget);
  });
  testWidgets(
    'stable rebuild uses one future and scope change rejects old image',
    (tester) async {
      final first = Loader(1), second = Loader(3);
      Widget tree(Loader loader) => MaterialApp(
        home: ArtworkScope(
          loader: loader,
          child: Artwork(uri: Uri.parse('native:cover'), size: 48),
        ),
      );
      await tester.pumpWidget(tree(first));
      await tester.pumpWidget(tree(first));
      expect(first.calls, 1);
      final dir = (await tester.runAsync(
        () => Directory.systemTemp.createTemp('art-widget-'),
      ))!;
      try {
        final file = File('${dir.path}/cover.png');
        await tester.runAsync(() async {
          await file.writeAsBytes(await png());
        });
        await tester.pumpWidget(tree(second));
        first.result.complete(file);
        await tester.pump();
        expect(find.byType(Image), findsNothing);
        expect(second.calls, 1);
        second.result.complete(file);
        await tester.pump();
        await tester.pump();
        expect(find.byType(Image), findsOneWidget);
        second.revoke();
        await tester.pump();
        expect(find.byType(Image), findsNothing);
      } finally {
        await tester.pumpWidget(const SizedBox());
        await tester.runAsync(() => dir.delete(recursive: true));
        first.dispose();
        second.dispose();
      }
    },
  );
  testWidgets(
    'revocation clears pending and already displayed private artwork',
    (tester) async {
      final loader = Loader(1);
      await tester.pumpWidget(
        MaterialApp(
          home: ArtworkScope(
            loader: loader,
            child: const Artwork(trackRef: LibraryTrackRef('cached')),
          ),
        ),
      );
      loader.revoke();
      loader.result.complete(File('D:/not-used.png'));
      await tester.pump();
      expect(find.byType(Image), findsNothing);
      await tester.pumpWidget(const SizedBox());
      loader.dispose();
    },
  );
}
