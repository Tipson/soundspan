import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/app/app_destinations.dart';
import 'package:soundspan/app/launcher_shortcut.dart';
import 'package:soundspan/app/owner_feature_scope.dart';
import 'package:soundspan/app/owner_playback_actions.dart';
import 'package:soundspan/app/owner_services.dart';
import 'package:soundspan/app/owner_ui_session.dart';
import 'package:soundspan/core/session/session_authority.dart';
import 'package:soundspan/features/settings/settings_models.dart';
import 'package:soundspan/features/library/library_models.dart';
import 'package:soundspan/playback/playback_controller.dart';

import '../support/collection_fixtures.dart';
import '../support/wave_reporting_fixtures.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'launcher resume keeps the current occurrence and downloads only navigates',
    () async {
      final authority = CollectionAuthority(), store = ReportingStore();
      final root = await Directory.systemTemp.createTemp(
        'soundspan-shortcuts-',
      );
      final playback = CollectionPlayback(
        QueueSnapshot(fence: collectionFence),
      );
      await store.transaction(
        collectionFence,
        (tx) =>
            tx.write('settings', 'network', {'version': 1, 'offline': true}),
      );
      final owner = await NativeOwnerServices.create(
        authority: authority,
        store: store,
        fence: collectionFence,
        playback: playback,
        supportDirectory: Directory(await root.resolveSymbolicLinks()),
        cancelDownloads: (_) async {},
      );
      final session = await OwnerUiSession.create(
        owner: owner,
        logout: () async {},
      );
      addTearDown(() async {
        await session.close();
        await owner.close();
        await authority.updates.close();
        await root.delete(recursive: true);
      });

      await session.launchShortcut(LauncherShortcut.resume);
      expect(playback.commands, isEmpty);
      expect(session.notice.value, contains('Нет сохранённой очереди'));

      final entries = playback.createEntries([
        collectionTrack(1),
        collectionTrack(2),
      ], const PlayContext(surface: PlaySurface.library));
      playback.value = QueueSnapshot(
        fence: collectionFence,
        entries: entries,
        currentEntryId: entries.last.entryId,
        position: const Duration(seconds: 43),
      );
      await session.launchShortcut(LauncherShortcut.resume);
      expect(playback.commands.single, isA<Resume>());
      expect(playback.snapshot.currentEntryId, entries.last.entryId);
      expect(playback.snapshot.position, const Duration(seconds: 43));

      await session.launchShortcut(LauncherShortcut.downloads);
      expect(session.router.currentTab, AppTab.downloads);
      expect(playback.commands, hasLength(1));

      authority.switchOwner();
      await session.launchShortcut(LauncherShortcut.resume);
      expect(playback.commands, hasLength(1));
    },
  );

  test('real owner UI retains controllers on token refresh and restores offline loudness', () async {
    final authority = CollectionAuthority(), store = ReportingStore();
    await store.transaction(collectionFence, (tx) async {
      await tx.write('settings', 'network', {'version': 1, 'offline': true});
      await tx.write('settings', 'loudness', {'version': 1, 'value': 'off'});
    });
    final base = await Directory('D:/CodexData/temp/soundspan-owner-ui')
        .create(recursive: true);
    final root = Directory(
      await (await base.createTemp()).resolveSymbolicLinks(),
    );
    final playback = CollectionPlayback(QueueSnapshot(fence: collectionFence));
    final owner = await NativeOwnerServices.create(
      authority: authority,
      store: store,
      fence: collectionFence,
      playback: playback,
      supportDirectory: root,
      cancelDownloads: (_) async {},
    );
    final session = await OwnerUiSession.create(
      owner: owner,
      logout: () async {},
    );
    try {
      final preferences = session.preferences, router = session.router;
      expect(session.settings.loudnessMode, LoudnessMode.off);
      authority.updates.add(
        SessionState(
          status: SessionStatus.authenticated,
          fence: collectionFence,
          tokenRevision: 2,
        ),
      );
      expect(identical(session.preferences, preferences), isTrue);
      expect(identical(session.router, router), isTrue);
      await session.settings.load();
      expect(session.settings.loudnessMode, LoudnessMode.off);
      final closing = session.close();
      expect(session.isCurrent, isFalse);
      expect(session.downloads.isCurrent, isFalse);
      expect(session.automation.isCurrent, isFalse);
      expect(session.preferences.isCurrent, isFalse);
      await closing;
    } finally {
      await session.close();
      await owner.close();
      await authority.updates.close();
      await root.delete(recursive: true);
    }
  });
  test(
    'malformed loudness cache fails closed with a visible preference error',
    () async {
      final authority = CollectionAuthority(), store = ReportingStore();
      await store.transaction(collectionFence, (tx) async {
        await tx.write('settings', 'network', {'version': 1, 'offline': true});
        await tx.write('settings', 'loudness', {
          'version': 1,
          'value': 'louder',
        });
      });
      final base = await Directory('D:/CodexData/temp/soundspan-owner-ui')
          .create(recursive: true);
      final root = Directory(
        await (await base.createTemp()).resolveSymbolicLinks(),
      );
      final owner = await NativeOwnerServices.create(
        authority: authority,
        store: store,
        fence: collectionFence,
        playback: CollectionPlayback(QueueSnapshot(fence: collectionFence)),
        supportDirectory: root,
        cancelDownloads: (_) async {},
      );
      final session = await OwnerUiSession.create(
        owner: owner,
        logout: () async {},
      );
      expect(session.settings.loudnessMode, LoudnessMode.off);
      expect(session.notice.value, contains('Нормализация выключена'));
      await session.close();
      await owner.close();
      await authority.updates.close();
      await root.delete(recursive: true);
    },
  );
  test(
    'close revokes all features synchronously and drains before core',
    () async {
      final drain = Completer<void>();
      final calls = <String>[];
      final scope = OwnerFeatureLifetime();
      scope.add(() {
        calls.add('one');
        return drain.future;
      });
      scope.add(() async {
        calls.add('two');
      });
      final closing = scope.close();
      expect(scope.isOpen, isFalse);
      expect(calls, ['two', 'one']);
      expect(() => scope.add(() async {}), throwsStateError);
      var done = false;
      closing.then((_) => done = true);
      await Future<void>.delayed(Duration.zero);
      expect(done, isFalse);
      drain.complete();
      await closing;
      expect(identical(closing, scope.close()), isTrue);
    },
  );
  test('popped routes release owner cleanup registrations', () async {
    final scope = OwnerFeatureLifetime();
    var calls = 0;
    final release = scope.add(() => calls++);
    release();
    release();
    await scope.close();
    expect(calls, 0);
  });
  test(
    'collection dispatch preserves duplicate occurrence and generation',
    () async {
      final authority = CollectionAuthority();
      final playback = CollectionPlayback(
        QueueSnapshot(fence: collectionFence, lineage: 7),
      );
      final actions = OwnerPlaybackActions(
        authority: authority,
        fence: collectionFence,
        playback: playback,
        isCurrent: () => true,
        prefetch: (_) async {},
      );
      final track = collectionTrack(1);
      const context = PlayContext(
        surface: PlaySurface.home,
        recommendationGenerationId: 'generation',
      );
      await actions.play(
        CollectionPlaybackRequest(
          tracks: [track, track],
          startIndex: 1,
          fence: collectionFence,
          context: context,
        ),
      );
      final command = playback.commands.whereType<ReplaceQueue>().single;
      expect(command.entries, hasLength(2));
      expect(command.initialEntryId, command.entries[1].entryId);
      expect(command.expectedLineage, 7);
      expect(command.entries.every((e) => e.context == context), isTrue);
      await authority.updates.close();
    },
  );
  test('owner change during admission prevents queue replacement', () async {
    final authority = CollectionAuthority();
    final playback = CollectionPlayback(QueueSnapshot(fence: collectionFence));
    final gate = Completer<void>();
    final actions = OwnerPlaybackActions(
      authority: authority,
      fence: collectionFence,
      playback: playback,
      isCurrent: () => true,
      prefetch: (_) => gate.future,
    );
    final result = actions.play(
      CollectionPlaybackRequest(
        tracks: [collectionTrack(1)],
        startIndex: 0,
        fence: collectionFence,
      ),
    );
    final rejected = expectLater(result, throwsA(isA<Object>()));
    authority.switchOwner();
    await Future<void>.delayed(Duration.zero);
    gate.complete();
    await rejected;
    expect(playback.commands, isEmpty);
    await authority.updates.close();
  });
}
