import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/dart_api_transport.dart';
import 'package:soundspan/playback/track_audio_admin.dart';

import '../support/auth_fakes.dart';
import '../support/fake_tls_server.dart';
import '../support/media_fixtures.dart' show mediaAuthority, recordingRef;

const draftId = '19b2ace6-d28a-4d70-9cb5-44fce755a86e';
const otherId = '9f49e547-c6a7-4cbe-b1dd-269813195764';
const track = LibraryTrackRef('track-1');
const path = '/api/track-audio/library/track-1';

void main() {
  test('exact supported identities never fall back to titles or guesses', () {
    final vk = NativeTrackRef(
      MusicRecording(
        provider: NativeMusicProvider.vk,
        id: '-123_456',
        title: 'Трек',
        artists: ['Исполнитель'],
        durationSeconds: 120,
        contentVersion: MusicContentVersion.unknown,
      ),
    );
    for (final (ref, source, id) in [
      (track, 'library', 'track-1'),
      (const YoutubeTrackRef('abcdefghijk'), 'youtube', 'abcdefghijk'),
      (
        const YoutubeTrackRef('abcdefghijk', youtubeKind: YoutubeKind.regular),
        'youtube',
        'abcdefghijk',
      ),
      (recordingRef, 'yandex', '42'),
      (vk, 'vk', '-123_456'),
    ]) {
      final target = TrackAudioTarget.fromRef(ref)!;
      expect(target.source, source);
      expect(target.trackId, id);
    }
    for (final ref in [
      const LibraryTrackRef('track/other'),
      const LibraryTrackRef('track\n'),
      const LibraryTrackRef('..'),
      const YoutubeTrackRef('invalid'),
      const UnavailableTrackRef('library:track-1', reason: 'missing'),
    ]) {
      expect(TrackAudioTarget.fromRef(ref), isNull);
    }
  });

  test(
    'authenticated TLS admin routes put binary and pin each publication',
    () async {
      final payload = [0x49, 0x44, 0x33, 0, 0xff];
      final calls = <(String, String)>[];
      final server = await FakeTlsServer.start((request) async {
        final method = request.method;
        calls.add((method, request.uri.path));
        expect(request.uri.hasQuery, isFalse);
        expect(
          request.headers.value(HttpHeaders.authorizationHeader),
          'Bearer initial',
        );
        final bytes = await request.fold(
          <int>[],
          (data, chunk) => data..addAll(chunk),
        );
        final state = switch (method) {
          'GET' => {'draftId': null, 'publishedId': otherId},
          'PUT' => {'draftId': draftId, 'publishedId': otherId},
          'POST' => {'draftId': draftId, 'publishedId': draftId},
          _ => {'draftId': draftId, 'publishedId': null},
        };
        if (method == 'PUT') {
          expect(request.headers.contentType?.mimeType, 'audio/mpeg');
          expect(request.contentLength, payload.length);
          expect(bytes, payload);
          request.response.statusCode = 201;
        } else if (method == 'POST') {
          expect(request.headers.contentType?.mimeType, 'application/json');
          expect(jsonDecode(utf8.decode(bytes)), {'versionId': draftId});
        } else {
          expect(bytes, isEmpty);
        }
        request.response.headers.contentType = ContentType.json;
        request.response.write(jsonEncode(state));
        await request.response.close();
      });
      addTearDown(server.close);
      final authority = await mediaAuthority(server.origin);
      addTearDown(authority.invalidate);
      final client = DartJsonHttpClient(securityContext: server.clientContext);
      addTearDown(client.close);
      final admin = TrackAudioAdmin(
        authority: authority,
        transport: DartApiTransport(authority: authority, client: client),
      );
      final target = TrackAudioTarget.fromRef(track)!;
      final fence = authority.requireFence();

      final initial = await admin.read(target, fence);
      expect(initial.draftId, isNull);
      expect(initial.publishedId, otherId);
      final bytes = Uint8List.fromList(payload);
      final upload = admin.upload(target, fence, bytes);
      bytes.fillRange(0, bytes.length, 0);
      final uploaded = await upload;
      expect(uploaded.draftId, draftId);
      expect(uploaded.publishedId, otherId);
      expect(
        (await admin.publish(target, fence, draftId)).publishedId,
        draftId,
      );
      expect(
        (await admin.withdraw(target, fence, draftId)).publishedId,
        isNull,
      );
      expect(calls, [
        ('GET', '$path/manage'),
        ('PUT', '$path/draft'),
        ('POST', '$path/publish'),
        ('DELETE', '$path/published/$draftId'),
      ]);
    },
  );

  test('invalid version IDs and MP3 sizes fail before sending', () async {
    final authority = await mediaAuthority(origin);
    addTearDown(authority.invalidate);
    final transport = RecordingTransport(
      (_, _) async => throw StateError('unexpected network'),
    );
    final admin = TrackAudioAdmin(authority: authority, transport: transport);
    final target = TrackAudioTarget.fromRef(track)!;
    final fence = authority.requireFence();
    for (final bytes in [
      Uint8List(0),
      Uint8List(TrackAudioAdmin.maxUploadBytes + 1),
    ]) {
      await expectLater(
        admin.upload(target, fence, bytes),
        throwsA(isA<AppFailure>()),
      );
    }
    await expectLater(
      admin.publish(target, fence, '../draft'),
      throwsA(isA<AppFailure>()),
    );
    await expectLater(
      admin.withdraw(target, fence, ''),
      throwsA(isA<AppFailure>()),
    );
    expect(TrackAudioAdmin.maxUploadBytes, 16 * 1024 * 1024);
    expect(transport.calls, 0);
  });

  test('role failures and stale IDs surface without retries and malformed state fails closed', () async {
    final authority = await mediaAuthority(origin);
    addTearDown(authority.invalidate);
    final outcomes = [
      const ApiResponse(403, {'error': 'Admin access required'}),
      const ApiResponse(409, {'error': 'version_changed'}),
      const ApiResponse(200, {'publishedId': null}),
      const ApiResponse(200, {'draftId': '../stream', 'publishedId': null}),
    ];
    final transport = RecordingTransport((_, _) async => outcomes.removeAt(0));
    final admin = TrackAudioAdmin(authority: authority, transport: transport);
    final target = TrackAudioTarget.fromRef(track)!;
    final fence = authority.requireFence();

    await expectLater(
      admin.read(target, fence),
      throwsA(isA<AppFailure>().having((e) => e.statusCode, 'statusCode', 403)),
    );
    await expectLater(
      admin.publish(target, fence, draftId),
      throwsA(isA<AppFailure>().having((e) => e.statusCode, 'statusCode', 409)),
    );
    for (var i = 0; i < 2; i++) {
      await expectLater(admin.read(target, fence), throwsA(isA<AppFailure>()));
    }
    expect(transport.calls, 4);
  });

  test(
    'a session change rejects pending results and future stale dispatch',
    () async {
      final authority = await mediaAuthority(origin);
      addTearDown(authority.invalidate);
      final fence = authority.requireFence();
      final response = Completer<ApiResponse>();
      final started = Completer<void>();
      final transport = RecordingTransport((request, sentFence) {
        expect(sentFence, fence);
        expect(request.origin, fence.owner.serverOrigin);
        started.complete();
        return response.future;
      });
      final admin = TrackAudioAdmin(authority: authority, transport: transport);
      final target = TrackAudioTarget.fromRef(track)!;
      final operation = admin.read(target, fence);
      final failed = expectLater(operation, throwsA(isA<AppFailure>()));
      await started.future;
      await authority.invalidate();
      response.complete(
        const ApiResponse(200, {'draftId': null, 'publishedId': draftId}),
      );
      await failed;
      await expectLater(
        admin.publish(target, fence, draftId),
        throwsA(isA<AppFailure>()),
      );
      expect(transport.calls, 1);
    },
  );
}

final class RecordingTransport implements ApiTransport {
  RecordingTransport(this.handler);

  final Future<ApiResponse> Function(ApiRequest, SessionFence?) handler;
  int calls = 0;

  @override
  Future<ApiResponse> send(ApiRequest request, {SessionFence? fence}) {
    calls++;
    return handler(request, fence);
  }
}
