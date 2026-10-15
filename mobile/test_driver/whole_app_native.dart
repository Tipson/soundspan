import 'dart:async';
import 'dart:convert';
import 'dart:io';

// Flutter SDK's integration_test owns the host-driver dependency.
// ignore: depend_on_referenced_packages
import 'package:flutter_driver/flutter_driver.dart';
import 'package:integration_test/common.dart';

final output = Directory(
  Platform.environment['T24_OUTPUT'] ??
      'D:/CodexData/outputs/soundspan/mobile-app-20261015/t24-native',
);
const device = 'emulator-5566';
final client = HttpClient();
var finished = false;
final frames = <Map<String, Object?>>[];
Future<ProcessResult> adb(List<String> args, {bool binary = false}) async {
  final result = await Process.run('adb', [
    '-s',
    device,
    ...args,
  ], stdoutEncoding: binary ? null : utf8);
  if (result.exitCode != 0) {
    throw StateError('ADB failed ${args.join(' ')}: ${result.stderr}');
  }
  return result;
}

Future<String> shell(List<String> args) async =>
    (await adb(['shell', ...args])).stdout.toString().trim();
Future<void> poll() async {
  var last = -1;
  while (!finished) {
    try {
      final request = await client.getUrl(
        Uri.parse('http://127.0.0.1:18766/status'),
      );
      final response = await request.close();
      final data = jsonDecode(
        await utf8.decoder.bind(response).join(),
      ) as Map<String, dynamic>;
      if (data.isNotEmpty && data['id'] != last) {
        last = data['id'] as int;
        switch (data['kind']) {
          case 'device':
            await shell([
              'wm',
              'size',
              '${(data['width'] as int) * 2}x${(data['height'] as int) * 2}',
            ]);
            await shell(['wm', 'density', '320']);
            await shell([
              'settings',
              'put',
              'system',
              'font_scale',
              '${data['scale']}',
            ]);
            for (final key in [
              'window_animation_scale',
              'transition_animation_scale',
              'animator_duration_scale',
            ]) {
              await shell([
                'settings',
                'put',
                'global',
                key,
                data['reduced'] == true ? '0' : '1',
              ]);
            }
            await Future<void>.delayed(const Duration(seconds: 2));
          case 'back':
            await shell(['input', 'keyevent', '4']);
          case 'frame':
            final name = data['name'] as String;
            final png = await adb([
              'exec-out',
              'screencap',
              '-p',
            ], binary: true);
            await File('${output.path}/$name.png')
                .writeAsBytes(png.stdout as List<int>);
            frames.add({
              ...data,
              'wmSize': await shell(['wm', 'size']),
              'wmDensity': await shell(['wm', 'density']),
              'fontScale': await shell([
                'settings',
                'get',
                'system',
                'font_scale',
              ]),
            });
            await File(
              '${output.path}/frames.json',
            ).writeAsString(const JsonEncoder.withIndent('  ').convert(frames));
            stdout.writeln('T24 FRAME $name');
        }
        final ack = await client.postUrl(
          Uri.parse('http://127.0.0.1:18766/ack?id=$last'),
        );
        await (await ack.close()).drain<void>();
      }
    } on SocketException {
      /* Fixture may not have started yet. */
    } on HttpException {
      // ADB can accept the forwarded socket before the fixture binds it.
      // The native command itself has a bounded acknowledgement deadline.
    }
    await Future<void>.delayed(const Duration(milliseconds: 200));
  }
}

Future<void> main() async {
  await output.create(recursive: true);
  final baseline = <String, String>{
    'size': await shell(['wm', 'size']),
    'density': await shell(['wm', 'density']),
    'font': await shell(['settings', 'get', 'system', 'font_scale']),
  };
  for (final key in [
    'window_animation_scale',
    'transition_animation_scale',
    'animator_duration_scale',
  ]) {
    baseline[key] = await shell(['settings', 'get', 'global', key]);
  }
  await File('${output.path}/device-before.json')
      .writeAsString(jsonEncode(baseline));
  FlutterDriver? driver;
  Future<void>? polling;
  var code = 1;
  try {
    await adb(['forward', 'tcp:18766', 'tcp:18766']);
    driver = await FlutterDriver.connect();
    polling = poll();
    final response = Response.fromJson(
      await driver.requestData(null, timeout: const Duration(minutes: 25)),
    );
    await File('${output.path}/result.json').writeAsString(response.toJson());
    stdout.writeln(
      response.allTestsPassed
          ? 'T24 NATIVE PASS'
          : response.formattedFailureDetails,
    );
    code = response.allTestsPassed ? 0 : 1;
  } finally {
    finished = true;
    await polling;
    await driver?.close();
    client.close(force: true);
    for (final kind in ['size', 'density']) {
      final match = RegExp('Override $kind: (.+)').firstMatch(baseline[kind]!);
      await shell(['wm', kind, match?[1] ?? 'reset']);
    }
    await shell(['settings', 'put', 'system', 'font_scale', baseline['font']!]);
    for (final key in [
      'window_animation_scale',
      'transition_animation_scale',
      'animator_duration_scale',
    ]) {
      await shell(['settings', 'put', 'global', key, baseline[key]!]);
    }
    await adb(['forward', '--remove', 'tcp:18766']);
    await File('${output.path}/device-restored.json').writeAsString(
      jsonEncode({
        'size': await shell(['wm', 'size']),
        'density': await shell(['wm', 'density']),
        'font': await shell(['settings', 'get', 'system', 'font_scale']),
      }),
    );
  }
  exit(code);
}
