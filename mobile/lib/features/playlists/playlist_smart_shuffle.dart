import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';

import '../../core/model/app_failure.dart';
import '../../core/storage/music_codec.dart';
import '../../playback/playback_controller.dart';
import '../../playback/finite_queue_admission_api.dart';
import '../../playback/finite_queue_admission_coordinator.dart';
import '../../playback/finite_smart_shuffle.dart';
import '../../playback/queue_snapshot_store.dart';
import '../../playback/smart_shuffle_checkpoint.dart';
import '../radio/radio_repository.dart';
import 'playlist_controller.dart';

/// One route's preparation intent over the existing owner player and admission.
final class PlaylistSmartShuffle extends ChangeNotifier {
  PlaylistSmartShuffle({
    required this.playlist,
    required this.playback,
    required this.admission,
    required this.radio,
    Random? random,
    this.onClosed,
  }) : _random = random ?? Random.secure() {
    var before = playback.snapshot;
    _subscription = playback.snapshots.listen((now) {
      if (busy &&
          _committingSession != null &&
          now.entries.isNotEmpty &&
          now.entries.every(
            (entry) => entry.smartShuffle?.sessionId == _committingSession,
          )) {
        busy = false;
        _committingSession = null;
      }
      if (before.fence == now.fence &&
          before.lineage == now.lineage &&
          before.generation == now.generation &&
          before.currentEntryId == now.currentEntryId &&
          listEquals(before.entries, now.entries)) {
        return;
      }
      before = now;
      if (!_disposed) notifyListeners();
    });
  }
  final PlaylistController playlist;
  final PlaybackController playback;
  final FiniteQueueAdmissionCoordinator admission;
  final RadioRepository radio;
  final Random _random;
  final void Function()? onClosed;
  late final StreamSubscription<QueueSnapshot> _subscription;
  bool _disposed = false, busy = false;
  int _request = 0;
  String? _committingSession;
  String? notice;
  AppFailure? failure;
  ({QueueSnapshot before, QueueSnapshot after, int mutation, int queue})? _undo;
  bool get isCurrent => !_disposed && playlist.isCurrent;
  String? get sessionId {
    final id = playlist.state.detail?.playlist.id;
    final rows = playback.snapshot.entries
        .where((entry) => entry.smartShuffle?.playlistId == id)
        .toList();
    if (rows.isEmpty ||
        rows.any(
          (entry) =>
              entry.smartShuffle!.sessionId !=
                  rows.first.smartShuffle!.sessionId ||
              !entry.smartShuffle!.enabled,
        )) {
      return null;
    }
    return rows.first.smartShuffle!.sessionId;
  }

  bool get active => sessionId != null;
  bool get canUndo {
    final u = _undo, now = playback.snapshot;
    return isCurrent &&
        u != null &&
        now.fence == playlist.fence &&
        now.lineage == u.after.lineage &&
        now.generation == u.after.generation &&
        now.currentEntryId == u.after.currentEntryId &&
        admission.queueEpoch == u.queue &&
        admission.isMutationCurrent(u.mutation);
  }

  void cancel() {
    ++_request;
    _committingSession = null;
    if (busy) {
      busy = false;
      if (!_disposed) notifyListeners();
    }
  }

  Future<void> toggle({bool Function()? presented}) async {
    if (!isCurrent || presented?.call() == false) return;
    if (busy) {
      cancel();
      return;
    }
    final session = sessionId;
    if (session != null) {
      ++_request;
      busy = false;
      _committingSession = null;
      final before = playback.snapshot;
      await playback.dispatch(
        EditSmartShuffle(
          fence: playlist.fence,
          expectedLineage: before.lineage,
          expectedGeneration: before.generation,
          expectedCurrentEntryId: before.currentEntryId,
          sessionId: session,
        ),
      );
      if (!isCurrent) return;
      final after = playback.snapshot;
      if (after.lineage == before.lineage + 1 && !active) {
        _undo =
            after.generation == before.generation &&
                after.currentEntryId == before.currentEntryId
            ? (
                before: before,
                after: after,
                mutation: admission.mutationEpoch,
                queue: admission.queueEpoch,
              )
            : null;
        notice = 'Будущие находки выключены. Текущий трек и история сохранены.';
        notifyListeners();
      }
      return;
    }
    final detail = playlist.state.detail;
    if (detail == null ||
        !detail.playlist.isOwner ||
        playlist.state.busy ||
        playlist.state.uncertain) {
      return;
    }
    final ticket = ++_request;
    _undo = null;
    busy = true;
    failure = null;
    notice = null;
    final before = playback.snapshot,
        epoch = admission.queueEpoch,
        mutation = admission.mutationEpoch;
    bool current() =>
        isCurrent &&
        _request == ticket &&
        (presented?.call() ?? true) &&
        identical(playlist.state.detail, detail) &&
        !playlist.state.busy &&
        !playlist.state.loading &&
        !playlist.state.uncertain &&
        playback.snapshot.lineage == before.lineage &&
        playback.snapshot.generation == before.generation &&
        playback.snapshot.currentEntryId == before.currentEntryId &&
        admission.queueEpoch == epoch &&
        admission.isMutationCurrent(mutation);
    notifyListeners();
    try {
      if (!current()) return;
      final snapshot = playlist.repository.networkPolicy.networkAllowed
          ? await playlist.repository.snapshot(detail.playlist.id)
          : detail;
      if (!current()) return;
      if (!snapshot.complete ||
          !snapshot.playlist.isOwner ||
          snapshot.playlist.id != detail.playlist.id ||
          snapshot.total > smartShuffleSnapshotLimit) {
        throw const FormatException('Invalid complete owner playlist');
      }
      final rows =
          snapshot.items
              .where((item) => !item.pending && item.track.playable)
              .toList()
            ..sort((a, b) {
              final order = a.sort.compareTo(b.sort);
              return order == 0 ? a.id.compareTo(b.id) : order;
            });
      if (rows.isEmpty) {
        throw const FormatException('No playable own occurrences');
      }
      if (rows.length >= QueueSnapshotStore.maxEntries) {
        notice =
            'С находками доступно до ${QueueSnapshotStore.maxEntries - 1} ваших треков. Плейлист не сокращён; обычное воспроизведение доступно.';
        return;
      }
      final seed = _random.nextInt(0x100000000);
      final session = base64Url.encode(
        List.generate(18, (_) => _random.nextInt(256)),
      );
      final own = playback.createEntries(
        rows.map((item) => item.track),
        const PlayContext(surface: PlaySurface.playlist),
      );
      var candidates = <QueueEntry>[];
      if (playlist.repository.networkPolicy.networkAllowed) {
        try {
          final station = await radio.readSeed(
            RadioSeed.playlist(snapshot.playlist.id),
            current: current,
            limit: smartShufflePoolLimit,
          );
          if (!current()) return;
          if (station.tracks.length <= smartShufflePoolLimit) {
            final seen = own
                .map((entry) => entry.track.ref.identityKey)
                .toSet();
            for (final track in station.tracks) {
              if (!track.playable || !seen.add(track.ref.identityKey)) continue;
              final ref = FiniteQueueAdmissionReference.fromTrack(
                track.ref,
                generationId:
                    track.recommendationGenerationId ?? station.generationId,
              );
              if (ref == null || !ref.valid) continue;
              candidates.addAll(
                playback.createEntries(
                  [track],
                  PlayContext(
                    surface: PlaySurface.playlist,
                    recommendationGenerationId: ref.generationId,
                    recommendationSessionId: 'smart-shuffle:$session',
                  ),
                ),
              );
            }
            if (candidates.isNotEmpty) {
              final evaluated = await admission.admit(
                captured: before,
                emptyQueueFence: playlist.fence,
                references: candidates
                    .map(
                      (entry) => FiniteQueueAdmissionReference.fromTrack(
                        entry.track.ref,
                        generationId: entry.context.recommendationGenerationId,
                      )!,
                    )
                    .toList(),
              );
              if (!current()) return;
              candidates =
                  evaluated.isCurrent &&
                      evaluated.mode == FiniteQueueAdmissionMode.authoritative
                  ? [
                      for (var i = 0; i < candidates.length; i++)
                        if (evaluated.stateAt(i) ==
                            FiniteQueueAdmissionState.allowed)
                          candidates[i],
                    ]
                  : [];
            }
          }
        } catch (_) {
          if (!current()) return;
          candidates = [];
        }
      }
      if (!current()) return;
      final entries = buildFiniteSmartShuffle(
        own: own,
        itemIds: rows.map((item) => item.id).toList(),
        pool: candidates,
        playlistId: snapshot.playlist.id,
        sessionId: session,
        seed: seed,
      );
      // Check the existing durable byte bound before replacing even one row.
      final encoded = jsonEncode({
        'entries': entries.map(MusicCodec.encodeQueueEntry).toList(),
        'effectiveOrder': entries.map((entry) => entry.entryId).toList(),
      });
      SmartShuffleCheckpoint.encode(
        entries,
        entries.map((entry) => entry.entryId).toList(),
      );
      if (utf8.encode(encoded).length >
          QueueSnapshotStore.maxPayloadBytes - 1024) {
        throw const FormatException('Finite checkpoint too large');
      }
      if (!current()) return;
      _committingSession = session;
      await playback.dispatch(
        ReplaceQueue(
          entries,
          fence: playlist.fence,
          expectedLineage: before.lineage,
          orderedRecommendation: true,
          preparationCurrent: current,
        ),
      );
      if (!isCurrent || _request != ticket) return;
      final actual = playback.snapshot.entries;
      if (actual.length == entries.length &&
          actual.every((entry) => entry.smartShuffle?.sessionId == session)) {
        notice = candidates.isEmpty
            ? 'Находки сейчас недоступны — играют только ваши треки.'
            : rows.length < 3
            ? 'Одна находка в конце. Плейлист не изменён.'
            : 'Одна находка после трёх ваших треков. Плейлист не изменён.';
      }
    } catch (error) {
      if (current()) {
        failure = error is AppFailure
            ? error
            : const AppFailure(
                code: 'smart_shuffle_unavailable',
                message:
                    'Нужен полный доступный плейлист. Очередь не изменена.',
              );
      }
    } finally {
      if (!_disposed && _request == ticket) {
        busy = false;
        _committingSession = null;
        notifyListeners();
      }
    }
  }

  Future<void> undo({bool Function()? presented}) async {
    if (!canUndo || presented?.call() == false) return;
    final u = _undo!;
    final session = u.before.entries
        .firstWhere(
          (entry) =>
              entry.smartShuffle?.playlistId ==
              playlist.state.detail?.playlist.id,
        )
        .smartShuffle!
        .sessionId;
    final future = u.before.effectiveOrder
        .skip(u.before.effectiveOrder.indexOf(u.before.currentEntryId!) + 1)
        .toSet();
    final restored = u.before.entries
        .where(
          (entry) =>
              future.contains(entry.entryId) &&
              entry.smartShuffle?.sessionId == session &&
              entry.smartShuffle?.injected == true,
        )
        .toList();
    FiniteQueueAdmissionEvaluation? evaluation;
    if (restored.isNotEmpty) {
      evaluation = await admission.admit(
        captured: playback.snapshot,
        references: restored
            .map(
              (entry) => FiniteQueueAdmissionReference.fromTrack(
                entry.track.ref,
                generationId: entry.context.recommendationGenerationId,
              )!,
            )
            .toList(),
        futureTail: true,
      );
    }
    if (!canUndo ||
        presented?.call() == false ||
        (evaluation != null &&
            (!evaluation.isCurrent ||
                evaluation.mode != FiniteQueueAdmissionMode.authoritative))) {
      return;
    }
    final denied = {
      for (var i = 0; i < restored.length; i++)
        if (evaluation!.stateAt(i) != FiniteQueueAdmissionState.allowed)
          restored[i].entryId,
    };
    var entries = u.before.entries
        .where((entry) => !denied.contains(entry.entryId))
        .toList();
    final hasInjected = entries.any(
      (entry) =>
          entry.smartShuffle?.sessionId == session &&
          entry.smartShuffle?.injected == true,
    );
    if (!hasInjected) {
      entries = entries
          .map(
            (entry) => entry.smartShuffle?.sessionId == session
                ? entry.withSmartShuffle(entry.smartShuffle!.withEnabled(false))
                : entry,
          )
          .toList();
    }
    await playback.dispatch(
      EditSmartShuffle(
        fence: playlist.fence,
        expectedLineage: u.after.lineage,
        expectedGeneration: u.after.generation,
        expectedCurrentEntryId: u.after.currentEntryId,
        sessionId: session,
        restoreEntries: entries,
        restoreOrder: u.before.effectiveOrder
            .where((id) => !denied.contains(id))
            .toList(),
        admissionCurrent: () =>
            canUndo &&
            (presented?.call() ?? true) &&
            (evaluation?.isCurrent ?? true),
      ),
    );
    _undo = null;
    if (isCurrent && playback.snapshot.lineage == u.after.lineage + 1) {
      notice = hasInjected
          ? 'Будущие находки восстановлены.'
          : 'Находки сейчас недоступны — играют только ваши треки.';
      notifyListeners();
    }
  }

  @override
  void dispose() {
    if (_disposed) return;
    cancel();
    _disposed = true;
    _subscription.cancel();
    onClosed?.call();
    super.dispose();
  }
}
