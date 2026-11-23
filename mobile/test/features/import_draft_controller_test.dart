import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/features/imports/import_draft_controller.dart';
import 'package:soundspan/features/imports/import_draft_models.dart';
import 'package:soundspan/features/imports/import_repository.dart';

import '../support/collection_fixtures.dart';
import '../support/import_draft_fixtures.dart';

void main() {
  late CollectionAuthority authority;
  late CollectionTransport transport;
  late ImportDraftController controller;
  var advertised = true;
  var timeoutConfirm = false;
  setUp(() {
    advertised = true;
    timeoutConfirm = false;
    authority = CollectionAuthority();
    transport = CollectionTransport((r, _) {
      if (r.path.endsWith('/confirm')) {
        if (timeoutConfirm) {
          throw const AppFailure(
            code: 'network_timeout',
            message: 'Нет ответа',
          );
        }
        return ApiResponse(202, {'job': draftJobDto(status: 'pending')});
      }
      if (r.path.endsWith('/preview')) {
        return ApiResponse(202, {'job': draftJobDto(status: 'previewing')});
      }
      if (r.method == ApiMethod.put) {
        return ApiResponse(200, {
          'job': draftJobDto(status: 'draft', revision: 2),
        });
      }
      if (r.method == ApiMethod.post) {
        return ApiResponse(201, {'job': draftJobDto(status: 'draft')});
      }
      return ApiResponse(200, {'job': draftJobDto()});
    });
    controller = ImportDraftController(
      repository: ImportRepository(
        transport: transport,
        authority: authority,
        fence: collectionFence,
        networkPolicy: const NetworkPolicy.online(),
      ),
      supported: () => advertised,
    );
    addTearDown(controller.close);
  });
  test('opening preview selects no categories; confirmation requires explicit choice', () async {
    await controller.open('draft-1');
    expect(controller.selection, isEmpty);
    await controller.confirm();
    expect(
      transport.requests.where((r) => r.method == ApiMethod.post),
      isEmpty,
    );
    controller.choose(ImportDraftCategory.playlists, true);
    await controller.confirm();
    expect(
      transport.requests.where((r) => r.path.endsWith('/confirm')),
      hasLength(1),
    );
    expect(controller.job!.status, 'pending');
  });
  test(
    'edited input retires selection and old matching confirmation',
    () async {
      await controller.open('draft-1');
      controller.choose(ImportDraftCategory.playlists, true);
      controller.sourceEdited();
      expect(controller.selection, isEmpty);
      expect(controller.canConfirm, isFalse);
      await controller.confirm();
      expect(
        transport.requests.where((r) => r.method == ApiMethod.post),
        isEmpty,
      );
    },
  );
  test('timeout confirmation is recovered by reading the same job, never replaying', () async {
    await controller.open('draft-1');
    controller.choose(ImportDraftCategory.playlists, true);
    timeoutConfirm = true;
    await controller.confirm();
    expect(controller.failure, isNotNull);
    await controller.refresh();
    expect(
      transport.requests.where((r) => r.path.endsWith('/confirm')),
      hasLength(1),
    );
    expect(transport.requests.last.path, '/api/import/drafts/draft-1');
    expect(controller.selection, isEmpty);
  });
  test('unsupported old server blocks mutation before HTTP', () async {
    advertised = false;
    await controller.prepare(content: 'Artist — Song');
    expect(transport.requests, isEmpty);
    expect(controller.failure!.code, 'import_drafts_unsupported');
  });
  test(
    'failed confirmed import retries only its immutable category snapshot',
    () async {
      final raw = draftJobDto(status: 'failed');
      raw['confirmedSnapshot'] = {
        'version': 1,
        'revision': 1,
        'previewRevision': 2,
        'sourceHash': 'a' * 64,
        'mappingDigest': 'b' * 64,
        'categories': ['playlists'],
      };
      transport = CollectionTransport(
        (r, _) => ApiResponse(200, {
          'job': r.path.endsWith('/confirm')
              ? draftJobDto(status: 'pending')
              : raw,
        }),
      );
      final other = ImportDraftController(
        repository: ImportRepository(
          transport: transport,
          authority: authority,
          fence: collectionFence,
          networkPolicy: const NetworkPolicy.online(),
        ),
        supported: () => true,
      );
      await other.open('draft-1');
      await other.retry();
      expect(
        transport.requests.last.path,
        '/api/import/drafts/draft-1/confirm',
      );
      expect(transport.requests.last.body!['categories'], ['playlists']);
      expect(
        transport.requests.where((r) => r.path == '/api/import/drafts'),
        isEmpty,
      );
      await other.close();
    },
  );
  test(
    'late file draft response cannot restore a retired owner screen',
    () async {
      final lateReply = Completer<ApiResponse>();
      transport = CollectionTransport((_, _) => lateReply.future);
      final other = ImportDraftController(
        repository: ImportRepository(
          transport: transport,
          authority: authority,
          fence: collectionFence,
          networkPolicy: const NetworkPolicy.online(),
        ),
        supported: () => true,
      );
      final pending = other.prepare(content: 'Artist — Song');
      await Future<void>.delayed(Duration.zero);
      authority.switchOwner();
      lateReply.complete(
        ApiResponse(201, {'job': draftJobDto(status: 'draft')}),
      );
      await pending;
      expect(other.job, isNull);
      expect(other.history, isEmpty);
      await other.close();
    },
  );
}
