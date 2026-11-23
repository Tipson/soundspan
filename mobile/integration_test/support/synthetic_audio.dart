import 'dart:math';
import 'dart:typed_data';

/// Original generated PCM sine wave; no user or third-party recording.
/// 16-bit mono little-endian WAV, 16 kHz. Generated solely for decoder probes.
Uint8List syntheticWav({Duration duration = const Duration(seconds: 3)}) {
  const rate = 16000;
  final samples = rate * duration.inMilliseconds ~/ 1000;
  final data = ByteData(44 + samples * 2);
  void text(int at, String value) {
    for (var i = 0; i < value.length; i++) {
      data.setUint8(at + i, value.codeUnitAt(i));
    }
  }

  text(0, 'RIFF');
  data.setUint32(4, data.lengthInBytes - 8, Endian.little);
  text(8, 'WAVE');
  text(12, 'fmt ');
  data.setUint32(16, 16, Endian.little);
  data.setUint16(20, 1, Endian.little);
  data.setUint16(22, 1, Endian.little);
  data.setUint32(24, rate, Endian.little);
  data.setUint32(28, rate * 2, Endian.little);
  data.setUint16(32, 2, Endian.little);
  data.setUint16(34, 16, Endian.little);
  text(36, 'data');
  data.setUint32(40, samples * 2, Endian.little);
  for (var i = 0; i < samples; i++) {
    data.setInt16(
      44 + i * 2,
      (sin(i * 2 * pi * 220 / rate) * 1600).round(),
      Endian.little,
    );
  }
  return data.buffer.asUint8List();
}
