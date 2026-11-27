import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/storage/music_codec.dart';
import 'package:soundspan/core/storage/owner_store.dart';
import 'package:soundspan/playback/queue_snapshot.dart';
import 'package:soundspan/playback/queue_snapshot_store.dart';
import 'package:soundspan/playback/playback_command.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/queue_coordinator.dart';

import '../support/media_fixtures.dart';
import 'queue_coordinator_test.dart' show FakeEngine;

void main() {
  late MemoryOwnerStore owners;
  late QueueSnapshotStore store;
  setUp(() {
    owners = MemoryOwnerStore(fenceA);
    store = QueueSnapshotStore(owners);
  });

  test('loaded checkpoint enters the real coordinator without preparation until explicit resume', () async {
    final authority = await mediaAuthority(
      Uri.parse('https://music.fixture.invalid'),
    );
    final fence = authority.requireFence();
    owners.active = fence;
    await store.save(snapshot(fence: fence), fence);
    final engine = FakeEngine();
    final resolved = <String>[];
    final queue = QueueCoordinator(
      authority: authority,
      engine: engine,
      prepare: (item, _) async {
        resolved.add(item.entryId);
        return PreparedAudio(
          uri: Uri.parse('http://127.0.0.1/synthetic'),
          revoke: () async {},
        );
      },
    );
    addTearDown(queue.dispose);
    final lineage = queue.snapshot.lineage;
    final loaded = await QueueSnapshotStore(owners).load(fence);
    await queue.dispatch(
      RestoreQueue(loaded!, fence: fence, expectedLineage: lineage),
    );
    expect(queue.snapshot.currentEntryId, 'second');
    expect(queue.snapshot.position, const Duration(seconds: 37));
    expect(queue.snapshot.effectiveOrder, ['third', 'second', 'first']);
    expect(resolved, isEmpty);
    expect(engine.loaded, isEmpty);
    expect(engine.plays, 0);
    await queue.dispatch(const Resume());
    expect(resolved, ['second']);
    expect(engine.loaded, hasLength(1));
    expect(engine.position, const Duration(seconds: 37));
    expect(engine.plays, 1);
  });

  test(
    'queue round trip retains every source, blocked and unavailable rows',
    () async {
      final refs = <TrackRef>[
        const LibraryTrackRef('library-item'),
        const YoutubeTrackRef('abcdefghijk', youtubeKind: YoutubeKind.regular),
        NativeTrackRef(recording(NativeMusicProvider.vk)),
        NativeTrackRef(recording(NativeMusicProvider.yandex)),
        const UnavailableTrackRef('tidal:1', reason: 'retired_provider'),
      ];
      final entries = List.generate(
        refs.length,
        (i) => QueueEntry(
          entryId: 'source-$i',
          track: Track(
            ref: refs[i],
            title: 'Title',
            artist: 'Artist',
            playbackAllowed: i != 1,
            unavailableReason: i == 1 ? 'rights' : null,
          ),
          context: const PlayContext(surface: PlaySurface.playlist),
        ),
      );
      await store.save(
        QueueSnapshot(
          entries: entries,
          effectiveOrder: entries.map((e) => e.entryId),
          currentEntryId: 'source-4',
        ),
        fenceA,
      );
      final loaded = (await store.load(fenceA))!;
      expect(loaded.entries.map((e) => e.track.ref), refs);
      expect(
        (loaded.entries[1].track.ref as YoutubeTrackRef).youtubeKind,
        YoutubeKind.regular,
      );
      expect(loaded.entries[1].track.playable, isFalse);
      expect(loaded.entries[1].track.unavailableReason, 'rights');
      expect(loaded.currentEntry!.track.playable, isFalse);
      expect(
        (loaded.entries[2].track.ref as NativeTrackRef).recording.isrc,
        'USABC1200042',
      );
      expect(
        (loaded.entries[3].track.ref as NativeTrackRef)
            .recording
            .durationSeconds,
        180.125,
      );
    },
  );

  test('queue checkpoints retain the selected encoding and older entries stay automatic', () {
    const track = Track(
      ref: LibraryTrackRef('library-item'),
      title: 'Трек',
      artist: 'Автор',
    );
    const saved = QueueEntry(
      entryId: 'one',
      track: track,
      context: PlayContext(surface: PlaySurface.library, fromDownloads: true),
      standardAudio: true,
    );
    final encoded = MusicCodec.encodeQueueEntry(saved);
    final restored = MusicCodec.decodeQueueEntry(encoded);
    expect(restored.standardAudio, isTrue);
    expect(restored.context.fromDownloads, isTrue);
    encoded.remove('standardAudio');
    (encoded['context'] as Map).remove('fromDownloads');
    final legacy = MusicCodec.decodeQueueEntry(encoded);
    expect(legacy.standardAudio, isFalse);
    expect(legacy.context.fromDownloads, isFalse);
  });

  test('37s restore keeps duplicate occurrences, shuffled order and attribution without autoplay', () async {
    await store.save(snapshot(), fenceA);
    final restored = await QueueSnapshotStore(owners).load(fenceA);
    expect(restored, isNotNull);
    expect(restored!.entries.map((e) => e.entryId), [
      'first',
      'second',
      'third',
    ]);
    expect(restored.entries[0].track.ref, restored.entries[1].track.ref);
    expect(restored.effectiveOrder, ['third', 'second', 'first']);
    expect(restored.currentEntryId, 'second');
    expect(restored.position, const Duration(seconds: 37));
    expect(restored.duration, const Duration(seconds: 180));
    expect(restored.shuffle, isTrue);
    expect(restored.repeat, QueueRepeat.one);
    expect(restored.volume, 0.37);
    expect(restored.currentEntry!.context.surface, PlaySurface.wave);
    expect(restored.currentEntry!.context.waveMode, WaveMode.familiar);
    expect(
      restored.currentEntry!.context.recommendationGenerationId,
      'generation-A',
    );
    expect(restored.currentEntry!.context.recommendationSessionId, 'session-A');
    expect(restored.playingIntent, isFalse);
    expect(restored.audible, isFalse);
    expect(restored.processing, PlaybackProcessing.idle);
    expect(restored.bufferedPosition, Duration.zero);
    expect(restored.failure, isNull);
    expect(restored.fence, fenceA);
    expect(restored.generation, 0);
    expect(restored.lineage, 0);
    expect(() => restored.entries.clear(), throwsUnsupportedError);
  });

  test('durable shape omits artwork, credentials, ephemeral audio and runtime authority', () async {
    await store.save(snapshot(), fenceA);
    final encoded = jsonEncode(owners.records[fenceA.owner]);
    for (final forbidden in [
      'https:',
      'token',
      'secret',
      'file:',
      'stack',
      'audible',
      'bufferedPosition',
      'playingIntent',
      'processing',
      'fence',
      'epoch',
      'generation',
      'lineage',
    ]) {
      // Attribution intentionally includes recommendationGenerationId, which is
      // portable metadata rather than the runtime generation counter.
      expect(encoded, isNot(contains('"$forbidden"')));
    }
    expect(encoded, isNot(contains('fixture-signed-artwork')));
    expect((await store.load(fenceA))!.entries.first.track.artwork, isNull);
  });

  test('another owner cannot read or clear A and a new A epoch explicitly restores its own queue', () async {
    await store.save(snapshot(), fenceA);
    owners.active = fenceB;
    expect(await store.load(fenceB), isNull);
    await store.clear(fenceB);
    owners.active = fenceA3;
    final restored = await store.load(fenceA3);
    expect(restored!.currentEntryId, 'second');
    expect(restored.fence, fenceA3);
    await expectLater(store.load(fenceA), throwsA(isA<AppFailure>()));
    await expectLater(
      store.save(snapshot(), fenceA),
      throwsA(isA<AppFailure>()),
    );
    await expectLater(store.clear(fenceA), throwsA(isA<AppFailure>()));
  });

  test('same owner ABA rejects an original delayed save rather than adopting new epoch', () async {
    final gate = owners.pauseNext();
    final old = store.save(snapshot(), fenceA);
    await owners.entered!.future;
    owners.active = fenceA3;
    final rejected = expectLater(old, throwsA(isA<AppFailure>()));
    gate.complete();
    await rejected;
    expect(await store.load(fenceA3), isNull);
  });

  test(
    'serialized writer keeps later seek backwards despite delayed first write',
    () async {
      final gate = owners.pauseNext();
      final first = store.save(snapshot(position: 70), fenceA);
      await owners.entered!.future;
      final second = store.save(snapshot(position: 12), fenceA);
      final read = store.load(fenceA);
      gate.complete();
      await Future.wait([first, second]);
      expect((await read)!.position, const Duration(seconds: 12));
      expect(owners.peakActive, 1);
    },
  );

  test('a failed write does not poison later save or clear ordering', () async {
    owners.failure = StateError('disk unavailable');
    final failed = store.save(snapshot(), fenceA);
    final following = store.save(snapshot(position: 9), fenceA);
    await expectLater(failed, throwsStateError);
    await following;
    expect((await store.load(fenceA))!.position, const Duration(seconds: 9));
    final clear = store.clear(fenceA);
    final read = store.load(fenceA);
    await clear;
    expect(await read, isNull);
  });

  test(
    'storage and session failures are not disguised as a corrupt empty queue',
    () async {
      owners.failure = StateError('disk unavailable');
      await expectLater(store.load(fenceA), throwsStateError);
      owners.readFailure = const FormatException('invalid SQLite JSON');
      expect(await store.load(fenceA), isNull);
      owners.active = fenceB;
      await expectLater(store.load(fenceA), throwsA(isA<AppFailure>()));
    },
  );

  test('a malformed owner JSON object rejected by the storage freezer is recoverable', () async {
    owners.readFailure = ArgumentError('Owner JSON exceeds nesting bound');
    expect(await store.load(fenceA), isNull);
    owners.failure = ArgumentError('admission bug must propagate');
    await expectLater(store.load(fenceA), throwsArgumentError);
    owners.failure = const FormatException('admission bug must propagate');
    await expectLater(store.load(fenceA), throwsFormatException);
  });

  test('empty optional album display metadata survives persistence', () {
    const track = Track(
      ref: LibraryTrackRef('id'),
      title: 'Title',
      artist: 'Artist',
      album: '',
    );
    expect(MusicCodec.decodeTrack(MusicCodec.encodeTrack(track)).album, '');
  });

  test('truly empty queue restores and invalid current/order/IDs never save successfully', () async {
    await store.save(QueueSnapshot(), fenceA);
    expect((await store.load(fenceA))!.entries, isEmpty);
    final entries = snapshot().entries;
    for (final invalid in [
      QueueSnapshot(
        entries: entries,
        effectiveOrder: ['first', 'second', 'third'],
      ),
      QueueSnapshot(
        entries: entries,
        effectiveOrder: ['first', 'first', 'third'],
        currentEntryId: 'first',
      ),
      QueueSnapshot(
        entries: [entries.first, entries.first],
        effectiveOrder: ['first', 'first'],
        currentEntryId: 'first',
      ),
      QueueSnapshot(currentEntryId: 'ghost'),
      QueueSnapshot(
        entries: entries,
        effectiveOrder: ['first', 'second', 'third'],
        currentEntryId: 'ghost',
      ),
      snapshot(volume: double.nan),
      snapshot(position: -1),
      snapshot(position: 8 * 24 * 3600),
      snapshot(fence: fenceB),
    ]) {
      await expectLater(
        store.save(invalid, fenceA),
        throwsA(anyOf(isA<FormatException>(), isA<ArgumentError>())),
      );
    }
    expect((await store.load(fenceA))!.entries, isEmpty);
  });

  test(
    'save enforces entry and UTF8 payload bounds without claiming success',
    () async {
      final many = List.generate(
        QueueSnapshotStore.maxEntries + 1,
        (i) => entry('item-$i'),
      );
      await expectLater(
        store.save(
          QueueSnapshot(
            entries: many,
            effectiveOrder: many.map((e) => e.entryId),
            currentEntryId: 'item-0',
          ),
          fenceA,
        ),
        throwsFormatException,
      );
      final fat = List.generate(
        QueueSnapshotStore.maxEntries,
        (i) => QueueEntry(
          entryId: 'item-$i',
          track: Track(
            ref: const LibraryTrackRef('id'),
            title: 'я' * 1000,
            artist: 'я' * 1000,
            album: 'я' * 1000,
          ),
          context: const PlayContext(surface: PlaySurface.library),
        ),
      );
      await expectLater(
        store.save(
          QueueSnapshot(
            entries: fat,
            effectiveOrder: fat.map((e) => e.entryId),
            currentEntryId: 'item-0',
          ),
          fenceA,
        ),
        throwsFormatException,
      );
      expect(await store.load(fenceA), isNull);
    },
  );

  final corruptions = <String, void Function(Map<String, Object?>)>{
    'unknown version': (row) => row['version'] = 99,
    'unknown credential field': (row) => row['accessToken'] = 'fixture-secret',
    'wrong permutation': (row) =>
        row['effectiveOrder'] = ['first', 'first', 'third'],
    'unknown current': (row) => row['currentEntryId'] = 'ghost',
    'negative position': (row) => row['positionUs'] = -1,
    'noninteger position': (row) => row['positionUs'] = 1.5,
    'invalid repeat': (row) => row['repeat'] = 'forever',
    'nonboolean shuffle': (row) => row['shuffle'] = 1,
    'out of range volume': (row) => row['volume'] = 2,
    'duplicate occurrence': (row) {
      final list = row['entries'] as List;
      list[1] = list[0];
    },
    'unknown track source': (row) {
      final track = (((row['entries'] as List).first as Map)['track'] as Map);
      track['ref'] = {'kind': 'tidal', 'id': '42'};
    },
    'media URL injection': (row) {
      final track = (((row['entries'] as List).first as Map)['track'] as Map);
      track['streamUrl'] = 'https://fixture.invalid/secret';
    },
    'local path injection': (row) {
      final track = (((row['entries'] as List).first as Map)['track'] as Map);
      track['filePath'] = 'D:/arbitrary/audio.mp3';
    },
    'oversized list': (row) => row['effectiveOrder'] = List.filled(
      QueueSnapshotStore.maxEntries + 1,
      'first',
    ),
  };
  for (final corruption in corruptions.entries) {
    test(
      '${corruption.key} returns recoverable null and preserves owner row',
      () async {
        await store.save(snapshot(), fenceA);
        final row = jsonDecode(
          jsonEncode(owners.records[fenceA.owner]),
        ) as Map<String, Object?>;
        corruption.value(row);
        owners.records[fenceA.owner] = row;
        expect(await store.load(fenceA), isNull);
        expect(owners.records[fenceA.owner], same(row));
      },
    );
  }

  test(
    'codec preserves all supported exact identities and public metadata',
    () {
      final refs = <TrackRef>[
        const LibraryTrackRef('opaque-library-17'),
        const YoutubeTrackRef('abcdefghijk'),
        const YoutubeTrackRef('abcdefghijk', youtubeKind: YoutubeKind.regular),
        NativeTrackRef(recording(NativeMusicProvider.vk)),
        NativeTrackRef(recording(NativeMusicProvider.yandex)),
        const UnavailableTrackRef('tidal:77', reason: 'retired_provider'),
      ];
      for (final ref in refs) {
        final result = MusicCodec.decodeTrackRef(
          MusicCodec.encodeTrackRef(ref),
        );
        expect(result, ref);
        expect(result.playable, ref.playable);
        if (result is YoutubeTrackRef) {
          expect(result.youtubeKind, (ref as YoutubeTrackRef).youtubeKind);
        }
        if (result is NativeTrackRef) {
          expect(result.recording.title, 'Exact recording');
          expect(result.recording.artists, ['First', 'Second']);
          expect(result.recording.durationSeconds, 180.125);
          expect(result.recording.contentVersion, MusicContentVersion.clean);
          expect(result.recording.isrc, 'USABC1200042');
        }
      }
      final native = recording(NativeMusicProvider.vk);
      final exact = MusicCodec.decodeRecording(
        MusicCodec.encodeRecording(native),
      );
      expect(exact.id, '-123_456');
      final track = Track(
        ref: NativeTrackRef(native),
        title: 'Display title',
        artist: 'Display artist',
        album: 'Album',
        artwork: Uri.parse(
          'https://fixture.invalid/signed?token=fixture-signed-artwork',
        ),
        duration: const Duration(microseconds: 180125000),
        explicit: false,
        artistId: 'artist-1',
        albumId: 'album-2',
        trackNo: 5,
        loudnessLufs: -12.3,
        truePeakDb: -0.4,
        albumLoudnessLufs: -13.2,
        albumTruePeakDb: -0.6,
        recommendationGenerationId: 'gen',
        playbackAllowed: false,
        unavailableReason: 'rights',
      );
      final result = MusicCodec.decodeTrack(MusicCodec.encodeTrack(track));
      expect(result.title, 'Display title');
      expect(result.artist, 'Display artist');
      expect(result.album, 'Album');
      expect(result.artistId, 'artist-1');
      expect(result.albumId, 'album-2');
      expect(result.trackNo, 5);
      expect(result.duration, const Duration(microseconds: 180125000));
      expect(result.explicit, false);
      expect(result.loudnessLufs, -12.3);
      expect(result.truePeakDb, -0.4);
      expect(result.albumLoudnessLufs, -13.2);
      expect(result.albumTruePeakDb, -0.6);
      expect(result.recommendationGenerationId, 'gen');
      expect(result.playable, isFalse);
      expect(result.unavailableReason, 'rights');
      expect(result.artwork, isNull);
      final context = MusicCodec.decodePlayContext(
        MusicCodec.encodePlayContext(waveContext),
      );
      expect(context.surface, PlaySurface.wave);
      expect(context.waveMode, WaveMode.familiar);
      expect(context.recommendationSessionId, 'session-A');
      expect(
        MusicCodec.decodeQueueEntry(
          MusicCodec.encodeQueueEntry(entry('duplicate')),
        ).entryId,
        'duplicate',
      );
    },
  );

  test('codec rejects forged native candidate, unsafe identities and unknown fields without fallback', () {
    for (final invalid in [
      {'kind': 'library', 'libraryId': ''},
      {'kind': 'library', 'libraryId': 'file:///D:/arbitrary.mp3'},
      {
        'kind': 'youtube',
        'videoId': 'https://fixture.invalid',
        'youtubeKind': 'music',
      },
      {'kind': 'youtube', 'videoId': 'abcdefghijk', 'youtubeKind': 'unknown'},
      {
        'kind': 'native',
        'recording': {'provider': 'vk', 'id': '-123_456'},
      },
      {
        'kind': 'unavailable',
        'identityKey': 'tidal:77',
        'reason': 'retired',
        'accessToken': 'fixture-secret',
      },
    ]) {
      expect(() => MusicCodec.decodeTrackRef(invalid), throwsFormatException);
    }
    final native = MusicCodec.encodeRecording(
      recording(NativeMusicProvider.vk),
    );
    for (final change in <String, Object?>{
      'provider': 'tidal',
      'id': 'wrong',
      'durationSeconds': double.infinity,
      'contentVersion': 'remix',
      'isrc': 'invalid',
      'accessToken': 'fixture-secret',
    }.entries) {
      expect(
        () => MusicCodec.decodeRecording({...native, change.key: change.value}),
        throwsFormatException,
      );
    }
    final track = MusicCodec.encodeTrack(entry('x').track);
    expect(
      () => MusicCodec.decodeTrack({...track, 'loudnessLufs': double.nan}),
      throwsFormatException,
    );
    expect(
      () => MusicCodec.decodeTrack({...track, 'durationUs': -1}),
      throwsFormatException,
    );
    expect(
      () => MusicCodec.decodeTrack({
        ...track,
        'artwork': 'file:///D:/arbitrary.mp3',
      }),
      throwsFormatException,
    );
    expect(
      () => MusicCodec.decodePlayContext({'surface': 'unknown'}),
      throwsFormatException,
    );
  });
}

final ownerA = OwnerKey(
  serverOrigin: Uri.parse('https://music.fixture.invalid'),
  userId: 'A',
);
final ownerB = OwnerKey(
  serverOrigin: Uri.parse('https://music.fixture.invalid'),
  userId: 'B',
);
final fenceA = SessionFence(owner: ownerA, epoch: 1);
final fenceA3 = SessionFence(owner: ownerA, epoch: 3);
final fenceB = SessionFence(owner: ownerB, epoch: 2);
const waveContext = PlayContext(
  surface: PlaySurface.wave,
  waveMode: WaveMode.familiar,
  recommendationGenerationId: 'generation-A',
  recommendationSessionId: 'session-A',
);
QueueEntry entry(String id) => QueueEntry(
  entryId: id,
  track: Track(
    ref: const LibraryTrackRef('same-track'),
    title: 'Title',
    artist: 'Artist',
    artwork: Uri.parse(
      'https://fixture.invalid/cover?token=fixture-signed-artwork',
    ),
  ),
  context: waveContext,
);
QueueSnapshot snapshot({
  int position = 37,
  double volume = 0.37,
  SessionFence? fence,
}) => QueueSnapshot(
  entries: [entry('first'), entry('second'), entry('third')],
  effectiveOrder: ['third', 'second', 'first'],
  currentEntryId: 'second',
  fence: fence ?? fenceA,
  position: Duration(seconds: position),
  duration: const Duration(seconds: 180),
  bufferedPosition: const Duration(seconds: 90),
  processing: PlaybackProcessing.buffering,
  playingIntent: true,
  audible: true,
  shuffle: true,
  repeat: QueueRepeat.one,
  volume: volume,
  failure: const AppFailure(code: 'fixture', message: 'secret stack'),
  generation: 20,
  lineage: 10,
);
MusicRecording recording(NativeMusicProvider provider) => MusicRecording(
  provider: provider,
  id: provider == NativeMusicProvider.vk ? '-123_456' : '123456',
  title: 'Exact recording',
  artists: ['First', 'Second'],
  durationSeconds: 180.125,
  contentVersion: MusicContentVersion.clean,
  isrc: 'USABC1200042',
);

/// Models only OwnerStore's externally observable transactional contract. The
/// deliberately controllable IO boundary exposes queue ordering and ABA races.
final class MemoryOwnerStore implements OwnerStore {
  MemoryOwnerStore(this.active);
  SessionFence active;
  final records = <OwnerKey, Map<String, Object?>>{};
  final policies = <OwnerKey, Map<String, Object?>>{};
  final smart = <OwnerKey, Map<String, Object?>>{};
  Completer<void>? _pause;
  Completer<void>? entered;
  Object? failure;
  Object? readFailure;
  int _active = 0;
  int peakActive = 0;
  Completer<void> pauseNext() {
    entered = Completer<void>();
    return _pause = Completer<void>();
  }

  @override
  Future<T> transaction<T>(
    SessionFence fence,
    Future<T> Function(OwnerTransaction) operation,
  ) async {
    _active++;
    if (_active > peakActive) peakActive = _active;
    try {
      final pause = _pause;
      _pause = null;
      if (pause != null) {
        entered!.complete();
        await pause.future;
      }
      if (active != fence) {
        throw const AppFailure(
          code: 'session_revoked',
          message: 'Сессия завершена',
        );
      }
      final fail = failure;
      failure = null;
      if (fail != null) throw fail;
      final transaction = _MemoryTransaction(
        records,
        policies,
        smart,
        fence.owner,
      );
      transaction.readFailure = readFailure;
      readFailure = null;
      return await operation(transaction);
    } finally {
      _active--;
    }
  }
}

final class _MemoryTransaction implements OwnerTransaction {
  _MemoryTransaction(this.rows, this.policies, this.smart, this.owner);
  final Map<OwnerKey, Map<String, Object?>> rows;
  final Map<OwnerKey, Map<String, Object?>> policies;
  final Map<OwnerKey, Map<String, Object?>> smart;
  final OwnerKey owner;
  Object? readFailure;
  void _scope(String namespace, String key) {
    if (namespace != 'queue' ||
        (key != 'snapshot' &&
            key != 'recommendation-policy' &&
            key != 'smart-shuffle-v1')) {
      throw StateError('wrong durable namespace');
    }
  }

  @override
  Future<Map<String, Object?>?> read(String namespace, String key) async {
    _scope(namespace, key);
    if (readFailure != null) throw readFailure!;
    return (key == 'snapshot'
        ? rows
        : key == 'smart-shuffle-v1'
        ? smart
        : policies)[owner];
  }

  @override
  Future<void> write(
    String namespace,
    String key,
    Map<String, Object?> value,
  ) async {
    _scope(namespace, key);
    (key == 'snapshot'
        ? rows
        : key == 'smart-shuffle-v1'
        ? smart
        : policies)[owner] = OwnerRecord(
      key: key,
      value: value,
    ).value;
  }

  @override
  Future<void> remove(String namespace, String key) async {
    _scope(namespace, key);
    (key == 'snapshot'
            ? rows
            : key == 'smart-shuffle-v1'
            ? smart
            : policies)
        .remove(owner);
  }

  @override
  Future<List<OwnerRecord>> list(
    String namespace, {
    String? afterKey,
    int limit = 100,
  }) => throw UnimplementedError();
}
