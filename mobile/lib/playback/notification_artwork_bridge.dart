import 'dart:async';
import 'dart:io';

import '../artwork/artwork_repository.dart';
import '../core/model/owner_key.dart';
import '../core/session/session_authority.dart';
import 'playback_controller.dart';
import 'soundspan_audio_handler.dart';

/// Adds only repository-verified private PNG files to native metadata.
final class NotificationArtworkBridge {
  NotificationArtworkBridge({
    required this.handler,
    required this.artwork,
    required this.authority,
    required this.fence,
  }) {
    _queue = handler.controller.snapshots.listen(_observe);
    _items = handler.mediaItem.listen((_) => _publish());
    _observe(handler.controller.snapshot);
  }
  final SoundspanAudioHandler handler;
  final ArtworkRepository artwork;
  final SessionAuthority authority;
  final SessionFence fence;
  late final StreamSubscription<QueueSnapshot> _queue;
  late final StreamSubscription<dynamic> _items;
  String? _entry;
  int? _generation;
  File? _file;
  bool _closed = false;
  final _pending = <Future<void>>{};
  bool get _current {
    final state = handler.controller.snapshot;
    return !_closed &&
        authority.isCurrent(fence) &&
        state.fence == fence &&
        state.currentEntryId == _entry &&
        state.generation == _generation;
  }

  void _observe(QueueSnapshot state) {
    if (_closed || state.fence != fence || !authority.isCurrent(fence)) return;
    if (state.currentEntryId == _entry && state.generation == _generation) {
      return;
    }
    _entry = state.currentEntryId;
    _generation = state.generation;
    _file = null;
    final entry = state.currentEntry;
    if (entry == null) return;
    final generation = state.generation;
    final operation = () async {
      final file = await artwork.load(
        ref: entry.track.ref,
        hint: entry.track.artwork,
      );
      if (!_current || _entry != entry.entryId || _generation != generation) {
        return;
      }
      _file = file;
      _publish();
    }();
    _pending.add(operation);
    unawaited(
      operation.then<void>(
        (_) => _pending.remove(operation),
        onError: (Object _) {
          _pending.remove(operation);
        },
      ),
    );
  }

  void _publish() {
    if (!_current) return;
    final item = handler.mediaItem.value;
    final uri = _file?.uri;
    if (item == null ||
        item.id != _entry ||
        uri == null ||
        uri.scheme != 'file' ||
        item.artUri == uri) {
      return;
    }
    // A duration update publishes the base item again. Equality prevents loops.
    handler.mediaItem.add(item.copyWith(artUri: uri));
  }

  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    final item = handler.mediaItem.value;
    if (item != null && item.id == _entry && item.artUri != null) {
      handler.mediaItem.add(item.copyWith(artUri: null));
    }
    await _queue.cancel();
    await _items.cancel();
    await Future.wait(_pending.toList());
  }
}
