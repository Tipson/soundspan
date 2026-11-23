import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/app/server_capabilities.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/features/imports/import_draft_models.dart';
import 'package:soundspan/features/imports/import_repository.dart';

import '../support/collection_fixtures.dart';
import '../support/import_draft_fixtures.dart';
import '../support/import_fixtures.dart';

void main() {
  test(
    'cached support cannot admit imports without a fresh owner-bound response',
    () async {
      const flags = {
        'discovery': true,
        'autoPlaylists': true,
        'federation': false,
        'importDrafts': {'version': 1},
      };
      final authority = CollectionAuthority();
      final store = ImportMemoryStore();
      await store.transaction(
        collectionFence,
        (tx) =>
            tx.write('capabilities', 'system', {'version': 1, 'flags': flags}),
      );
      var elapsed = Duration.zero;
      final capabilities = ServerCapabilitiesRepository(
        transport: CollectionTransport((_, _) => ApiResponse(200, flags)),
        store: store,
        authority: authority,
        fence: collectionFence,
        policy: const NetworkPolicy.online(),
        elapsed: () => elapsed,
      );
      addTearDown(capabilities.close);
      await capabilities.restore();
      expect(capabilities.state.value!.importDrafts, isTrue);
      expect(capabilities.importDraftsEnabled, isNull);
      await capabilities.refresh();
      expect(capabilities.importDraftsEnabled, isTrue);
      elapsed = const Duration(minutes: 5);
      expect(capabilities.importDraftsEnabled, isNull);
      elapsed = Duration.zero;
      authority.switchOwner();
      expect(capabilities.importDraftsEnabled, isNull);
    },
  );
  const flags = {'discovery': true, 'autoPlaylists': true, 'federation': false};
  test(
    'draft capability is optional and unknown versions cannot enable it',
    () {
      expect(ServerCapabilities.decode(flags).importDrafts, isFalse);
      for (final raw in [
        true,
        {'version': 2},
        {'version': '1'},
        {'version': 1, 'unknown': true},
      ]) {
        expect(
          ServerCapabilities.decode({...flags, 'importDrafts': raw})
              .importDrafts,
          isFalse,
        );
      }
      final supported = ServerCapabilities.decode({
        ...flags,
        'importDrafts': {'version': 1},
      });
      expect(supported.importDrafts, isTrue);
      expect(
        ServerCapabilities.decode(supported.toJson()).importDrafts,
        isTrue,
      );
    },
  );
  test('draft preview binds revision and ordered entry identities', () {
    final raw = draftJobDto();
    final draft = ImportDraftJob.fromJson(raw);
    expect(draft.entries.single.title, 'Song');
    expect(draft.preview!.rows.single.confidence, 85);
    final data = raw['draftData'] as Map;
    (data['preview'] as Map)['revision'] = 9;
    expect(() => ImportDraftJob.fromJson(raw), throwsA(isA<AppFailure>()));
  });
  test('confirm sends only server token and explicit categories, never matching IDs', () async {
    final authority = CollectionAuthority();
    final transport = CollectionTransport(
      (_, _) => ApiResponse(202, {'job': draftJobDto(status: 'pending')}),
    );
    final repo = ImportRepository(
      transport: transport,
      authority: authority,
      fence: collectionFence,
      networkPolicy: const NetworkPolicy.online(),
    );
    final draft = ImportDraftJob.fromJson(draftJobDto());
    await expectLater(repo.confirmDraft(draft, {}), throwsA(isA<AppFailure>()));
    expect(transport.requests, isEmpty);
    await repo.confirmDraft(draft, {ImportDraftCategory.playlists});
    final sent = transport.requests.single;
    expect(sent.path, '/api/import/drafts/draft-1/confirm');
    expect(sent.body, {
      'revision': 1,
      'previewRevision': 2,
      'mappingDigest': 'b' * 64,
      'categories': ['playlists'],
    });
    expect(transport.fences.single, collectionFence);
  });
  test('UTF8 export byte bound rejects before HTTP', () async {
    final authority = CollectionAuthority();
    final transport = CollectionTransport(
      (_, _) => throw StateError('No HTTP'),
    );
    final repo = ImportRepository(
      transport: transport,
      authority: authority,
      fence: collectionFence,
      networkPolicy: const NetworkPolicy.online(),
    );
    await expectLater(
      repo.createDraft(content: 'Я' * (256 * 1024 + 1)),
      throwsA(isA<AppFailure>()),
    );
    expect(transport.requests, isEmpty);
  });
  test(
    'draft response belongs to original owner; late owner changes reject it',
    () async {
      final authority = CollectionAuthority();
      final response = Completer<ApiResponse>();
      final transport = CollectionTransport((_, _) => response.future);
      final repo = ImportRepository(
        transport: transport,
        authority: authority,
        fence: collectionFence,
        networkPolicy: const NetworkPolicy.online(),
      );
      final reading = repo.getDraft('draft-1');
      await Future<void>.delayed(Duration.zero);
      authority.switchOwner();
      response.complete(ApiResponse(200, {'job': draftJobDto()}));
      await expectLater(reading, throwsA(isA<AppFailure>()));
    },
  );
  test(
    'new draft history explicitly opts in without changing the legacy list',
    () async {
      final authority = CollectionAuthority();
      final transport = CollectionTransport(
        (r, _) => ApiResponse(200, {
          'jobs': r.query['includeDrafts'] == '1' ? [draftJobDto()] : [],
        }),
      );
      final repo = ImportRepository(
        transport: transport,
        authority: authority,
        fence: collectionFence,
        networkPolicy: const NetworkPolicy.online(),
      );
      expect(await repo.listJobs(), isEmpty);
      expect(await repo.listDrafts(), hasLength(1));
      expect(transport.requests.first.query, isEmpty);
      expect(transport.requests.last.query, {'includeDrafts': '1'});
    },
  );
}
