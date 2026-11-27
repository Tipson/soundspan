import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show LogicalKeyboardKey;
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/features/player/track_audio_admin_sheet.dart';
import 'package:soundspan/playback/track_audio_admin.dart';

const _empty = TrackAudioAdminState(draftId: null, publishedId: null);
const _draft = TrackAudioAdminState(draftId: 'draft-1', publishedId: null);
const _published = TrackAudioAdminState(draftId: null, publishedId: 'draft-1');
const _choose = 'Выбрать MP3';
const _upload = 'Загрузить черновик';
const _publish = 'Опубликовать для всех';
const _withdraw = 'Снять с публикации';

Future<void> _open(
  WidgetTester tester, {
  Future<TrackAudioAdminState> Function()? load,
  Future<TrackAudioAdminState> Function(Uint8List)? upload,
  Future<TrackAudioAdminState> Function(String)? publish,
  Future<TrackAudioAdminState> Function(String)? withdraw,
  Future<({String name, Uint8List bytes})?> Function()? pickFile,
  bool Function()? isCurrent,
  VoidCallback? onDispose,
  double scale = 1,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context)
            .copyWith(textScaler: TextScaler.linear(scale)),
        child: child!,
      ),
      home: Scaffold(
        body: Builder(
          builder: (context) => TextButton(
            onPressed: () => TrackAudioAdminSheet.show(
              context,
              trackTitle: 'Очень длинное название любимой песни',
              load: load ?? () async => _empty,
              upload: upload ?? (_) async => _draft,
              publish: publish ?? (_) async => _published,
              withdraw: withdraw ?? (_) async => _empty,
              pickFile: pickFile ?? () async => null,
              isCurrent: isCurrent ?? () => true,
              onDispose: onDispose,
            ),
            child: const Text('Открыть'),
          ),
        ),
      ),
    ),
  );
  await _tap(tester, 'Открыть');
}

Future<void> _tap(WidgetTester tester, String label) async {
  final target = find.text(label);
  await tester.ensureVisible(target);
  await tester.tap(target);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('selects, stages, publishes and withdraws exact versions', (
    tester,
  ) async {
    final bytes = Uint8List.fromList([1, 2, 3]);
    final calls = <Object>[];
    await _open(
      tester,
      pickFile: () async => (name: 'полная версия.MP3', bytes: bytes),
      upload: (body) async {
        calls.add(body);
        return _draft;
      },
      publish: (id) async {
        calls.add('publish $id');
        return _published;
      },
      withdraw: (id) async {
        calls.add('withdraw $id');
        return _empty;
      },
    );

    expect(find.text(_publish), findsNothing);
    await _tap(tester, _choose);
    expect(find.text('полная версия.MP3'), findsOneWidget);
    expect(calls, isEmpty);
    await _tap(tester, _upload);
    expect(calls, [bytes]);
    expect(find.text(_withdraw), findsNothing);
    expect(
      find.text('Черновик можно прослушать в веб-версии в меню трека.'),
      findsOneWidget,
    );
    await _tap(tester, _publish);
    expect(calls, [bytes, 'publish draft-1']);
    expect(find.text(_publish), findsNothing);
    await _tap(tester, _withdraw);
    expect(calls, [bytes, 'publish draft-1', 'withdraw draft-1']);
    expect(find.text(_withdraw), findsNothing);
  });

  for (final (code, status, message) in [
    ('not_found', 404, 'Эта версия сервера не поддерживает замену аудио.'),
    ('unauthorized', 401, 'Для замены аудио войдите с правами администратора.'),
    ('forbidden', 403, 'Для замены аудио войдите с правами администратора.'),
    (
      'offline_mode',
      null,
      'Отключите офлайн-режим, чтобы управлять версиями трека.',
    ),
  ]) {
    testWidgets('explains unavailable management for $code', (tester) async {
      await _open(
        tester,
        load: () async => throw AppFailure(
          code: code,
          message: 'Management unavailable',
          statusCode: status,
        ),
      );

      expect(find.text(message), findsOneWidget);
      expect(find.text(_choose), findsNothing);
      expect(find.text(_publish), findsNothing);
    });
  }

  testWidgets('failed publication reloads the exact current draft', (
    tester,
  ) async {
    var reads = 0;
    final calls = <String>[];
    await _open(
      tester,
      load: () async => ++reads == 1
          ? _draft
          : const TrackAudioAdminState(draftId: 'new-draft', publishedId: null),
      publish: (id) async {
        calls.add(id);
        if (id == 'draft-1') {
          throw const AppFailure(
            code: 'version_changed',
            message: 'Версия изменилась.',
            statusCode: 409,
          );
        }
        return _published;
      },
    );

    await _tap(tester, _publish);
    expect(calls, ['draft-1']);
    expect(find.textContaining('загрузите MP3 заново'), findsOneWidget);
    expect(find.text(_publish), findsNothing);
    expect(find.text(_choose), findsNothing);
    await _tap(tester, 'Обновить версии');
    await _tap(tester, _publish);
    expect(calls, ['draft-1', 'new-draft']);
  });

  testWidgets('size limit prevents staging or retaining an oversized file', (
    tester,
  ) async {
    var uploaded = false;
    await _open(
      tester,
      pickFile: () async =>
          (name: 'oversized.mp3', bytes: Uint8List(16 * 1024 * 1024 + 1)),
      upload: (_) async {
        uploaded = true;
        return _draft;
      },
    );

    await _tap(tester, _choose);
    expect(
      find.text('Выберите непустой MP3 размером до 16 МиБ.'),
      findsOneWidget,
    );
    expect(find.text('oversized.mp3'), findsNothing);
    expect(uploaded, isFalse);
  });

  testWidgets('a selected replacement blocks publishing an older draft', (
    tester,
  ) async {
    final publications = <String>[];
    await _open(
      tester,
      load: () async => _draft,
      pickFile: () async => (name: 'replacement.mp3', bytes: Uint8List(1)),
      upload: (_) async =>
          const TrackAudioAdminState(draftId: 'new-draft', publishedId: null),
      publish: (id) async {
        publications.add(id);
        return _published;
      },
    );

    final publishButton = find.ancestor(
      of: find.text(_publish),
      matching: find.byType(FilledButton),
    );
    await _tap(tester, _choose);
    expect(tester.widget<FilledButton>(publishButton).onPressed, isNull);
    await _tap(tester, 'Сбросить выбор файла');
    expect(tester.widget<FilledButton>(publishButton).onPressed, isNotNull);
    await _tap(tester, _choose);
    await _tap(tester, _upload);
    await _tap(tester, _publish);
    expect(publications, ['new-draft']);
  });

  testWidgets('an open chooser cannot supply a file to a stale session', (
    tester,
  ) async {
    var current = true;
    final selected = Completer<({String name, Uint8List bytes})?>();
    await _open(
      tester,
      pickFile: () => selected.future,
      isCurrent: () => current,
    );

    await tester.tap(find.text(_choose));
    await tester.pump();
    current = false;
    selected.complete((name: 'private.mp3', bytes: Uint8List(1)));
    await tester.pumpAndSettle();

    expect(find.text('private.mp3'), findsNothing);
    expect(find.text(_upload), findsNothing);
    expect(find.text('Сеанс завершён.'), findsOneWidget);
  });

  testWidgets('actions stay reachable at large text and Escape dismisses', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(320, 500));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    var disposed = false;
    await _open(
      tester,
      scale: 2,
      onDispose: () => disposed = true,
      load: () async => const TrackAudioAdminState(
        draftId: 'draft-2',
        publishedId: 'draft-1',
      ),
    );

    for (final label in [_choose, _publish, _withdraw]) {
      final target = find.text(label);
      await tester.ensureVisible(target);
      await tester.pumpAndSettle();
      expect(target.hitTestable(), findsOneWidget);
    }
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.text('Полная версия трека'), findsNothing);
    expect(disposed, isTrue);
    expect(tester.takeException(), isNull);
  });
}
