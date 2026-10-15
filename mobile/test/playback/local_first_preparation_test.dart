import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/playback/local_first_preparation.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/playback_engine.dart';

import '../support/collection_fixtures.dart';

void main() {
  final entry = QueueEntry(
    entryId: 'occurrence',
    track: const Track(
      ref: LibraryTrackRef('track'),
      title: 'Title',
      artist: 'Artist',
    ),
    context: const PlayContext(surface: PlaySurface.library),
  );
  test(
    'verified ready file wins offline and across download qualities',
    () async {
      final authority = CollectionAuthority();
      final qualities = <String>[];
      var network = 0;
      final file = File.fromUri(
        Uri.file('D:/CodexData/temp/ready-fixture.wav'),
      );
      final preparation = LocalFirstPreparation(
        authority: authority,
        policy: const NetworkPolicy.offline(),
        qualities: () => ['high', 'medium'],
        openReady: (ref, quality, fence) async {
          qualities.add(quality);
          return quality == 'medium' ? file : null;
        },
        network: (_, _) async {
          network++;
          throw StateError('unexpected network');
        },
      );
      final prepared = await preparation.prepare(entry, collectionFence);
      expect(prepared.uri, file.uri);
      expect(qualities, ['high', 'medium']);
      expect(network, 0);
      await prepared.revoke();
    },
  );

  test(
    'offline cold miss fails without resolving or opening network',
    () async {
      var network = 0;
      final preparation = LocalFirstPreparation(
        authority: CollectionAuthority(),
        policy: const NetworkPolicy.offline(),
        qualities: () => ['high'],
        openReady: (_, _, _) async => null,
        network: (_, _) async {
          network++;
          throw StateError('unexpected network');
        },
      );
      await expectLater(
        preparation.prepare(entry, collectionFence),
        throwsA(isA<AppFailure>()),
      );
      expect(network, 0);
    },
  );

  test(
    'online misses use one selected original-fenced network preparation',
    () async {
      final calls = <String>[];
      final preparation = LocalFirstPreparation(
        authority: CollectionAuthority(),
        policy: const NetworkPolicy.online(),
        qualities: () => ['high'],
        openReady: (_, _, _) async => null,
        network: (captured, fence) async {
          expect(identical(captured, entry), isTrue);
          expect(fence, collectionFence);
          calls.add(captured.entryId);
          return PreparedAudio(
            uri: Uri.parse('http://127.0.0.1:1234/capability'),
            revoke: () async {},
          );
        },
      );
      await preparation.prepare(entry, collectionFence);
      expect(calls, ['occurrence']);
    },
  );

  test(
    'owner changed during local lookup never opens returned file or network',
    () async {
      final authority = CollectionAuthority();
      var network = 0;
      final preparation = LocalFirstPreparation(
        authority: authority,
        policy: const NetworkPolicy.online(),
        qualities: () => ['high'],
        openReady: (_, _, _) async {
          authority.switchOwner();
          return File.fromUri(Uri.file('D:/CodexData/temp/ready-fixture.wav'));
        },
        network: (_, _) async {
          network++;
          throw StateError('unexpected network');
        },
      );
      await expectLater(
        preparation.prepare(entry, collectionFence),
        throwsA(isA<AppFailure>()),
      );
      expect(network, 0);
    },
  );

  test(
    'offline activation during resolve revokes the late gateway handle',
    () async {
      final policy = _Policy();
      final held = Completer<PreparedAudio>();
      final started = Completer<void>();
      var revokes = 0;
      final preparation = LocalFirstPreparation(
        authority: CollectionAuthority(),
        policy: policy,
        qualities: () => ['high'],
        openReady: (_, _, _) async => null,
        network: (_, _) {
          started.complete();
          return held.future;
        },
      );
      final pending = preparation.prepare(entry, collectionFence);
      await started.future;
      policy.online = false;
      held.complete(
        PreparedAudio(
          uri: Uri.parse('http://127.0.0.1:1234/capability'),
          revoke: () async {
            revokes++;
          },
        ),
      );
      await expectLater(pending, throwsA(isA<AppFailure>()));
      expect(revokes, 1);
    },
  );
}

class _Policy implements NetworkPolicy {
  bool online = true;
  @override
  bool get networkAllowed => online;
  @override
  void requireNetwork() {
    if (!online) {
      throw const AppFailure(code: 'offline_mode', message: 'offline');
    }
  }
}
