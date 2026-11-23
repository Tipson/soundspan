import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/features/likes/likes_models.dart';
import 'package:soundspan/features/likes/preference_controller.dart';

import '../support/collection_fixtures.dart';

void main() {
  test(
    'automation observes confirmed writes, never optimistic state or reads',
    () async {
      final authority = CollectionAuthority();
      final held = Completer<ApiResponse>();
      final transport = CollectionTransport(
        (r, _) => r.method == ApiMethod.get
            ? preferenceResponse('local-1', 'clear')
            : held.future,
      );
      final controller = PreferenceController(
        transport: transport,
        authority: authority,
        fence: collectionFence,
      );
      addTearDown(controller.dispose);
      final events = <Object?>[];
      final dynamic source = controller;
      final subscription = (source.applied as Stream).listen(events.add);
      addTearDown(subscription.cancel);
      final track = collectionTrack(1);
      await controller.load(track.ref);
      controller.seed(collectionTrack(2).ref, PreferenceSignal.like);
      expect(events, isEmpty);
      final operation = controller.set(track.ref, PreferenceSignal.like);
      expect(controller.current(track.ref).pending, isTrue);
      expect(events, isEmpty);
      held.complete(preferenceResponse('local-1', 'thumbs_up'));
      await operation;
      expect(events, hasLength(1));
      final dynamic event = events.single;
      expect(event.ref, track.ref);
      expect(event.signal, PreferenceSignal.like);
      expect(event.fence, collectionFence);
    },
  );

  test(
    'failed and late revoked writes never enqueue another owner downloads',
    () async {
      final authority = CollectionAuthority();
      final held = Completer<ApiResponse>();
      var count = 0;
      final controller = PreferenceController(
        transport: CollectionTransport(
          (_, _) => ++count == 1 ? const ApiResponse(403, {}) : held.future,
        ),
        authority: authority,
        fence: collectionFence,
      );
      addTearDown(controller.dispose);
      final events = <Object?>[];
      final dynamic source = controller;
      final subscription = (source.applied as Stream).listen(events.add);
      addTearDown(subscription.cancel);
      final track = collectionTrack(1);
      await expectLater(
        controller.set(track.ref, PreferenceSignal.like),
        throwsA(anything),
      );
      final writing = controller.set(track.ref, PreferenceSignal.like);
      final observed = expectLater(writing, throwsA(anything));
      authority.switchOwner();
      await observed;
      held.complete(preferenceResponse('local-1', 'thumbs_up'));
      await Future<void>.delayed(Duration.zero);
      expect(events, isEmpty);
    },
  );

  test(
    'ordered confirmations report like then unlike without optimistic replay',
    () async {
      final authority = CollectionAuthority();
      final held = Completer<ApiResponse>();
      var count = 0;
      final controller = PreferenceController(
        transport: CollectionTransport(
          (_, _) => ++count == 1
              ? held.future
              : preferenceResponse('local-1', 'clear'),
        ),
        authority: authority,
        fence: collectionFence,
      );
      addTearDown(controller.dispose);
      final signals = <PreferenceSignal>[];
      final dynamic source = controller;
      final subscription = (source.applied as Stream).listen(
        (dynamic e) => signals.add(e.signal as PreferenceSignal),
      );
      addTearDown(subscription.cancel);
      final ref = collectionTrack(1).ref;
      final like = controller.set(ref, PreferenceSignal.like);
      final unlike = controller.set(ref, PreferenceSignal.clear);
      expect(signals, isEmpty);
      held.complete(preferenceResponse('local-1', 'thumbs_up'));
      await Future.wait([like, unlike]);
      expect(signals, [PreferenceSignal.like, PreferenceSignal.clear]);
    },
  );
}
