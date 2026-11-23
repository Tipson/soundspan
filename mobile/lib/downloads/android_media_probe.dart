import 'dart:io';

import 'package:flutter/services.dart';

import '../core/session/session_broker_protocol.dart';
import '../playback/resolved_media.dart';
import 'download_verifier.dart';

final class AndroidMediaProbe implements MediaProbe {
  const AndroidMediaProbe();
  @override
  Future<MediaProbeResult> probe(File file) async {
    final data = BrokerCodec.object(
      await const MethodChannel('soundspan/media_probe')
          .invokeMethod<Object?>('probe', file.absolute.path)
          .timeout(const Duration(seconds: 10)),
      {'decodable', 'durationUs'},
    );
    if (data['decodable'] != true ||
        data['durationUs'] is! int ||
        (data['durationUs'] as int) <= 0) {
      throw invalidMedia;
    }
    return MediaProbeResult(
      decodable: true,
      duration: Duration(microseconds: data['durationUs'] as int),
    );
  }
}
