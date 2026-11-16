import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/queue_entry.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/playback/play_create_protocol.dart';

void main() {
  for (final provider in NativeMusicProvider.values) {
    test(
      '${provider.name} keyed snapshot retains exact native version without URL or alias conversion',
      () {
        final recording = MusicRecording(
          provider: provider,
          id: provider == NativeMusicProvider.vk ? '-12_34' : '1234',
          title: 'Exact',
          artists: ['Artist'],
          durationSeconds: 200,
          contentVersion: MusicContentVersion.clean,
        );
        final frozen = FrozenPlayCreate.fromEntry(
          QueueEntry(
            entryId: 'native',
            track: Track(
              ref: NativeTrackRef(recording),
              title: 'Display',
              artist: 'Display',
            ),
            context: const PlayContext(surface: PlaySurface.wave),
          ),
        );
        expect(frozen.source, provider.name);
        expect(frozen.body['musicSourceRecording'], {
          'provider': provider.name,
          'id': provider == NativeMusicProvider.vk ? '-12_34' : '1234',
          'title': 'Exact',
          'artists': ['Artist'],
          'duration': 200.0,
          'contentVersion': 'clean',
          'preview': false,
        });
        expect(frozen.body.containsKey('youtubeVideoId'), isFalse);
        final nested = frozen.body['musicSourceRecording'] as Map;
        expect(
          () => (nested['artists'] as List).add('mutation'),
          throwsUnsupportedError,
        );
        expect(
          () => FrozenPlayCreate.decode({
            ...frozen.body,
            'musicSourceRecording': {
              ...nested,
              'url': 'https://private.invalid/lease',
            },
          }),
          throwsFormatException,
        );
      },
    );
  }
  test('long remote metadata keeps its original duration instead of borrowing the engagement cap', () {
    final entry = QueueEntry(
      entryId: 'long',
      track: const Track(
        ref: YoutubeTrackRef('long-video'),
        title: 'Long',
        artist: 'Artist',
        duration: Duration(hours: 25),
      ),
      context: const PlayContext(surface: PlaySurface.wave),
    );
    expect(FrozenPlayCreate.fromEntry(entry).body['duration'], 90000);
  });
  test(
    'keyed payload freezes the accepted remote snapshot without artwork URL',
    () {
      final entry = QueueEntry(
        entryId: 'occurrence',
        track: Track(
          ref: const YoutubeTrackRef('video-one'),
          title: ' Title ',
          artist: ' Artist ',
          artwork: Uri.parse('https://private.invalid/lease?token=secret'),
          duration: const Duration(seconds: 200),
        ),
        context: const PlayContext(
          surface: PlaySurface.wave,
          recommendationSessionId: 'session',
        ),
      );
      final frozen = FrozenPlayCreate.fromEntry(entry);
      expect(frozen.source, 'youtube');
      expect(frozen.body, {
        'youtubeVideoId': 'video-one',
        'title': 'Title',
        'artist': 'Artist',
        'album': 'Single',
        'duration': 200,
        'playContext': 'wave',
        'recommendationSessionId': 'session',
      });
      expect(() => frozen.body['title'] = 'mutated', throwsUnsupportedError);
      expect(
        () => FrozenPlayCreate.decode({
          ...frozen.body,
          'thumbnailUrl': 'https://private.invalid',
        }),
        throwsFormatException,
      );
    },
  );
  test(
    'immutable key binds owner epoch, canonical server time and bounded nonce',
    () {
      final key = PlayCreateKey.issue(
        epoch: 7,
        issuedAtMs: 1700000000000,
        nonce: 'A' * 32,
      );
      expect(key.value, 'p1.7.loyw3v28.${'A' * 32}');
      expect(key.expiresAtMs, 1700086400000);
      expect(PlayCreateKey.parse(key.value).issuedAtMs, 1700000000000);
      expect(
        () => PlayCreateKey.parse(key.value.replaceFirst('p1.7.', 'p1.07.')),
        throwsFormatException,
      );
      expect(
        () => PlayCreateKey.issue(epoch: -1, issuedAtMs: 0, nonce: 'A' * 32),
        throwsFormatException,
      );
    },
  );
  test('ACK accepts exactly the original key and immutable replay window', () {
    final key = PlayCreateKey.issue(
      epoch: 7,
      issuedAtMs: 1700000000000,
      nonce: 'A' * 32,
    );
    final ack = {
      'id': 'play-one',
      'playCreation': {
        'version': 1,
        'clientPlaybackId': key.value,
        'disposition': 'replayed',
        'replayExpiresAt': '2023-11-15T22:13:20.000Z',
      },
    };
    expect(PlayCreateAck.decode(ack, key).playId, 'play-one');
    expect(
      () => PlayCreateAck.decode({
        ...ack,
        'playCreation': {
          ...(ack['playCreation'] as Map),
          'clientPlaybackId': 'another',
        },
      }, key),
      throwsFormatException,
    );
    expect(
      () => PlayCreateAck.decode({
        ...ack,
        'playCreation': {
          ...(ack['playCreation'] as Map),
          'replayExpiresAt': '2023-11-16T22:13:20.000Z',
        },
      }, key),
      throwsFormatException,
    );
  });
  test('keyed cohort never coerces a local or unavailable identity', () {
    for (final ref in [
      const LibraryTrackRef('one'),
      const UnavailableTrackRef('retired', reason: 'unavailable'),
    ]) {
      expect(
        () => FrozenPlayCreate.fromEntry(
          QueueEntry(
            entryId: 'entry',
            track: Track(ref: ref, title: 'T', artist: 'A'),
            context: const PlayContext(surface: PlaySurface.library),
          ),
        ),
        throwsArgumentError,
      );
    }
  });
}
