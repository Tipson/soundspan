import 'dart:io';

import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/session/credential_vault.dart';
import 'package:soundspan/core/session/local_session_authority.dart';
import 'package:soundspan/playback/resolved_media.dart';

import 'auth_fakes.dart';

const leasePath =
    '/api/music-sources/leases/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/stream';
const renewedLeasePath =
    '/api/music-sources/leases/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/stream';
const recordingPath = '/api/music-sources/recordings/yandex/42/stream';
final recordingRef = NativeTrackRef(
  MusicRecording(
    provider: NativeMusicProvider.yandex,
    id: '42',
    title: 'Exact clean recording',
    artists: ['Artist'],
    durationSeconds: 180,
    contentVersion: MusicContentVersion.clean,
  ),
);
final audioBytes = [
  0x49,
  0x44,
  0x33,
  ...List<int>.generate(253, (i) => i % 256),
];

Future<LocalSessionAuthority> mediaAuthority(
  Uri origin, {
  Future<TokenPair> Function(Uri, String)? refresh,
}) async {
  final authority = LocalSessionAuthority(
    vault: MemoryVault(),
    fenceStore: MemoryFenceStore(),
    refreshTokens:
        refresh ??
        (_, _) async => const TokenPair(
          accessToken: 'fresh',
          refreshToken: 'fresh-refresh',
        ),
  );
  await authority.establish(
    OwnerKey(serverOrigin: origin, userId: 'media-user'),
    const TokenPair(accessToken: 'initial', refreshToken: 'refresh'),
  );
  return authority;
}

ResolvedMedia nativeMedia(
  LocalSessionAuthority authority, {
  String path = recordingPath,
}) => ResolvedMedia(
  ref: recordingRef,
  purpose: ResolvePurpose.playback,
  fence: authority.requireFence(),
  uri: authority.requireFence().owner.serverOrigin.resolve(path),
  renewableUri: authority.requireFence().owner.serverOrigin.resolve(
    recordingPath,
  ),
);

Future<void> sendAudio(
  HttpRequest request, {
  bool chunked = false,
  String etag = '"v1"',
}) async {
  final range = request.headers.value('range');
  var start = 0;
  var end = audioBytes.length - 1;
  if (range != null) {
    final match = RegExp(r'^bytes=(\d+)-(\d*)$').firstMatch(range)!;
    start = int.parse(match[1]!);
    end = match[2]!.isEmpty ? end : int.parse(match[2]!);
    request.response.statusCode = 206;
    request.response.headers.set(
      'content-range',
      'bytes $start-$end/${audioBytes.length}',
    );
  }
  request.response.headers.set('content-type', 'audio/mpeg');
  request.response.headers.set('etag', etag);
  if (!chunked) request.response.contentLength = end - start + 1;
  if (request.method != 'HEAD') {
    request.response.add(audioBytes.sublist(start, end + 1));
  }
  await request.response.close();
}
