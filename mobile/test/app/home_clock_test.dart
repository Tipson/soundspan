import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/app/owner_services.dart';
import 'package:soundspan/app/owner_ui_session.dart';
import 'package:soundspan/playback/playback_controller.dart';

import '../support/collection_fixtures.dart';
import '../support/wave_reporting_fixtures.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  for (final scenario in [
    (
      name:
          'fractional-offset UTC midnight refreshes within the same local hour',
      before: _ClockInstant('2026-11-16T23:59:30Z', 330),
      after: _ClockInstant('2026-11-17T00:00:30Z', 330),
      refreshes: true,
    ),
    (
      name: 'timezone offset change refreshes even within the same local hour',
      before: _ClockInstant('2026-11-17T07:00:00Z', 180),
      after: _ClockInstant('2026-11-17T07:00:00Z', 210),
      refreshes: true,
    ),
    (
      name: 'repeated clock observation of the same instant does not refresh',
      before: _ClockInstant('2026-11-17T07:00:00Z', 180),
      after: _ClockInstant('2026-11-17T07:00:00Z', 180),
      refreshes: false,
    ),
  ]) {
    test(scenario.name, () async {
      const prefix =
          'D:/CodexData/temp/soundspan-development-34-20261115/dev12-daypart-mobile/';
      final created = await (await Directory(prefix).create(recursive: true))
          .createTemp();
      final root = Directory(await created.resolveSymbolicLinks());
      final authority = CollectionAuthority(), store = ReportingStore();
      await store.transaction(
        collectionFence,
        (tx) =>
            tx.write('settings', 'network', {'version': 1, 'offline': true}),
      );
      final playback = CollectionPlayback(
        QueueSnapshot(fence: collectionFence),
      );
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
        final loading = <bool>[];
        session.home.addListener(() => loading.add(session.home.state.loading));
        session.refreshClock(scenario.before);
        await Future<void>.delayed(Duration.zero);
        expect(loading, isEmpty);
        session.refreshClock(scenario.after);
        await Future<void>.delayed(Duration.zero);
        expect(loading.contains(true), scenario.refreshes);
        expect(session.home.request.localHour, scenario.after.hour);
        expect(
          session.home.request.timezoneOffsetMinutes,
          scenario.after.timeZoneOffset.inMinutes,
        );
        expect(playback.commands, isEmpty);
      } finally {
        await session.close();
        await owner.close();
        await authority.updates.close();
        final resolved = (await root.resolveSymbolicLinks()).replaceAll(
          '\\',
          '/',
        );
        if (!resolved.startsWith(prefix)) {
          throw StateError('Unexpected test path');
        }
        await root.delete(recursive: true);
      }
    });
  }
}

/// Device wall clock and offset for one real instant, independent of host TZ.
final class _ClockInstant implements DateTime {
  _ClockInstant(String value, int offsetMinutes)
    : instant = DateTime.parse(value).toUtc(),
      timeZoneOffset = Duration(minutes: offsetMinutes);
  final DateTime instant;
  @override
  final Duration timeZoneOffset;
  DateTime get _local => instant.add(timeZoneOffset);
  @override
  int get year => _local.year;
  @override
  int get month => _local.month;
  @override
  int get day => _local.day;
  @override
  int get hour => _local.hour;
  @override
  DateTime toUtc() => instant;
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
