import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/app/owner_services.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/playback/loudness_gain_policy.dart';
import 'package:soundspan/playback/playback_controller.dart';

import '../support/collection_fixtures.dart';
import '../support/wave_reporting_fixtures.dart';

void main() {
  for (final value in [null, 'album', 'broken']) {
    test(
      'owner restores cached loudness $value before features; canonical write and fence',
      () async {
        final authority = CollectionAuthority(), store = ReportingStore();
        await store.transaction(collectionFence, (tx) async {
          await tx.write('settings', 'network', {
            'version': 1,
            'offline': true,
          });
          if (value != null) {
            await tx.write('settings', 'loudness', {
              'version': 1,
              'value': value,
            });
          }
        });
        final base = await Directory(
          'D:/CodexData/temp/soundspan-loudness-owner',
        ).create(recursive: true);
        final directory = Directory(
          await (await base.createTemp()).resolveSymbolicLinks(),
        );
        final owner = await NativeOwnerServices.create(
          authority: authority,
          store: store,
          fence: collectionFence,
          playback: CollectionPlayback(QueueSnapshot()),
          supportDirectory: directory,
          cancelDownloads: (_) async {},
        );
        try {
          expect(
            owner.loudnessMode.value,
            value == null
                ? LoudnessMode.auto
                : value == 'album'
                ? LoudnessMode.album
                : LoudnessMode.off,
          );
          expect(owner.gainAvailable.value, isFalse);
          expect(
            owner.loudnessFailure.value?.code,
            value == 'broken' ? 'invalid_loudness_mode' : null,
          );
          await owner.setLoudnessMode(LoudnessMode.track);
          expect(
            await store.transaction(
              collectionFence,
              (tx) => tx.read('settings', 'loudness'),
            ),
            {'version': 1, 'value': 'track'},
          );
          expect(owner.loudnessMode.value, LoudnessMode.track);
          await owner.close();
          await expectLater(
            owner.setLoudnessMode(LoudnessMode.album),
            throwsA(isA<AppFailure>()),
          );
        } finally {
          await owner.close();
          await directory.delete(recursive: true);
          await authority.updates.close();
        }
      },
    );
  }
}
