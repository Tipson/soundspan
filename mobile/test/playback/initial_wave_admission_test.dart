import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/playback/finite_queue_admission_api.dart';
import 'package:soundspan/playback/finite_queue_admission_coordinator.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/queue_coordinator.dart';
import 'package:soundspan/features/recommendations/recommendation_repository.dart';
import 'package:soundspan/playback/wave_continuation.dart';

import '../support/media_fixtures.dart';
import '../support/wave_reporting_fixtures.dart';

void main() {
  for (final ordered in [false, true]) {
    for (final policy in [
      'allowed',
      'legacy404',
      'deniedSelected',
      'blockedSuffix',
    ]) {
      test(
        'Clear restart honors initial entry with production admission ordered=$ordered policy=$policy',
        () async {
          final authority = await mediaAuthority(
            Uri.parse('https://report.test'),
          );
          final fence = authority.requireFence();
          const ids = [
            'AAAAAAAAAA1',
            'BBBBBBBBBB1',
            'CCCCCCCCCC1',
            'DDDDDDDDDD1',
            'EEEEEEEEEE1',
            'FFFFFFFFFF1',
          ];
          var reads = 0;
          final prepared = <String>[];
          final transport = ControlledTransport()
            ..respond = (request) async {
              if (request.path == '/api/personalized/queue-admission') {
                if (policy == 'legacy404') return const ApiResponse(404, null);
                final refs = request.body!['references'] as List;
                return ApiResponse(200, {
                  'version': 1,
                  'appliesTo': 'recommended_future',
                  'decisions': [
                    for (final ref in refs)
                      {
                        ...ref as Map,
                        'state':
                            (policy == 'deniedSelected' &&
                                    ref['id'] == ids[1]) ||
                                (policy == 'blockedSuffix' &&
                                    ref['id'] != ids[0])
                            ? 'denied'
                            : 'allowed',
                      },
                  ],
                });
              }
              if (request.path != '/api/personalized/home') {
                throw StateError(request.path);
              }
              reads++;
              if (!ordered) {
                return ApiResponse(200, waveFeed(ids));
              }
              return ApiResponse(200, {
                'generationId': 'restart-$reads',
                'orderedWave': {
                  'version': 1,
                  'sequenceId': '5d73c623-d11d-4fda-943e-0e01ce5b3be7',
                  'startPosition': 0,
                  'nextCursor': 'next',
                  'items': [
                    for (final (index, id) in ids.indexed)
                      {'position': index, 'track': waveDto(id)},
                  ],
                  'tail': [
                    for (final (index, id) in ids.indexed.skip(ids.length - 2))
                      {'source': 'youtube', 'id': id, 'position': index},
                  ],
                },
              });
            };
          final queue = QueueCoordinator(
            authority: authority,
            engine: ReportingEngine(),
            prepare: (entry, _) async {
              prepared.add(entry.track.ref.identityKey);
              return PreparedAudio(
                uri: Uri.parse('http://127.0.0.1/synthetic'),
                revoke: () async {},
              );
            },
          );
          final admission = FiniteQueueAdmissionCoordinator(
            api: FiniteQueueAdmissionApi(transport: transport),
            authority: authority,
            snapshot: () => queue.snapshot,
            snapshots: queue.snapshots,
          );
          queue.finiteAdmission = admission;
          final wave = WaveContinuation(
            controller: queue,
            repository: RecommendationRepository(
              transport: transport,
              orderedWaveCapability: (_, _) async => ordered,
            ),
            authority: authority,
            finiteAdmission: admission,
          );
          addTearDown(() async {
            await wave.dispose();
            await admission.close();
            await queue.dispose();
          });
          await wave.start(const WaveSelection(), fence);
          await settle();
          expect(
            queue.snapshot.currentEntry!.track.ref.identityKey,
            'yt:${ids[0]}',
          );
          await queue.dispatch(const Clear());
          await settle();
          expect(queue.snapshot.entries, isEmpty);
          expect(prepared, ['yt:${ids[0]}']);
          await wave.start(const WaveSelection(), fence);
          await settle();
          if (policy == 'blockedSuffix') {
            expect(
              queue.snapshot.entries,
              isEmpty,
              reason: 'an allowed history prefix cannot replace an unavailable requested suffix',
            );
            expect(prepared, ['yt:${ids[0]}']);
            expect(reads, 2);
            return;
          }
          final expected = policy == 'deniedSelected' ? ids[2] : ids[1];
          expect(
            queue.snapshot.currentEntry!.track.ref.identityKey,
            'yt:$expected',
          );
          expect(prepared, ['yt:${ids[0]}', 'yt:$expected']);
          expect(reads, 2);
          expect(
            queue.snapshot.entries.map((entry) => entry.track.ref.identityKey),
            ids.map((id) => 'yt:$id'),
          );
        },
      );
    }
  }
}
