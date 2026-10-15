import 'dart:convert';
import 'dart:math';

import '../core/model/app_failure.dart';
import '../core/model/owner_key.dart';
import '../core/model/track_ref.dart';
import '../core/network/api_transport.dart';
import '../core/network/redirect_policy.dart';
import '../core/session/session_authority.dart';
import 'resolved_media.dart';

/// Resolves only the selected identity. No title search or alternate recording
/// recovery is performed by the mobile client.
final class PlaybackResolver {
  PlaybackResolver({
    required this.transport,
    required this.authority,
    this.quality,
  });
  final ApiTransport transport;
  final SessionAuthority authority;
  final String? quality;

  Future<ResolvedMedia> resolve(
    TrackRef ref,
    ResolvePurpose purpose,
    SessionFence fence,
  ) async {
    await authority.assertCurrent(fence);
    final origin = fence.owner.serverOrigin;
    var uri = origin.resolve(RedirectPolicy.identityPath(ref));
    Uri? renewable;
    if (ref is NativeTrackRef) {
      renewable = uri;
      final r = ref.recording;
      final response = await transport.send(
        ApiRequest(
          origin: origin,
          method: ApiMethod.post,
          path: '/api/music-sources/resolve',
          body: {
            'provider': r.provider.name,
            'providerTrackId': r.id,
            'title': r.title,
            'artists': r.artists,
            'duration': r.durationSeconds,
            'contentVersion': r.contentVersion.name,
            if (r.isrc != null) 'isrc': r.isrc,
          },
        ),
        fence: fence,
      );
      await authority.assertCurrent(fence);
      response.requireSuccess();
      final data = response.data;
      if (data is! Map) throw invalidMedia;
      final playback = data['playback'];
      if (playback == null) {
        throw const AppFailure(
          code: 'recording_unavailable',
          message: 'Эта запись сейчас недоступна',
        );
      }
      if (playback is! Map ||
          playback['provider'] != r.provider.name ||
          playback['leaseId'] is! String ||
          !RegExp(r'^[a-f0-9]{48}$').hasMatch(playback['leaseId'] as String)) {
        throw invalidMedia;
      }
      final expected =
          '/api/music-sources/leases/${playback['leaseId']}/stream';
      if (playback['streamPath'] != expected) throw invalidMedia;
      uri = origin.resolve(expected);
    } else {
      final query = <String, String>{'quality': ?quality};
      if (ref is YoutubeTrackRef && ref.youtubeKind == YoutubeKind.music) {
        if (purpose == ResolvePurpose.playback) {
          final random = Random.secure();
          query['playbackSession'] = base64Url.encode(
            List.generate(24, (_) => random.nextInt(256)),
          );
        } else {
          query['purpose'] = 'preload';
        }
      }
      if (query.isNotEmpty) uri = uri.replace(queryParameters: query);
    }
    final media = ResolvedMedia(
      ref: ref,
      purpose: purpose,
      fence: fence,
      uri: uri,
      renewableUri: renewable,
    );
    RedirectPolicy.validate(uri, media);
    await authority.assertCurrent(fence);
    return media;
  }
}
