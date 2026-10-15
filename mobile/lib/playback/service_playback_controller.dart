import '../core/model/track.dart';
import 'playback_controller.dart';
import 'soundspan_audio_handler.dart';

/// The process controller owns the complete handler, including audio focus.
final class ServicePlaybackController implements PlaybackController {
  ServicePlaybackController(this.handler);
  final SoundspanAudioHandler handler;
  Future<void>? _closing;
  @override
  QueueSnapshot get snapshot => handler.controller.snapshot;
  @override
  Stream<QueueSnapshot> get snapshots => handler.controller.snapshots;
  @override
  Stream<PlaybackEvent> get events => handler.controller.events;
  @override
  List<QueueEntry> createEntries(Iterable<Track> tracks, PlayContext context) =>
      handler.controller.createEntries(tracks, context);
  @override
  Future<void> dispatch(PlaybackCommand command) =>
      handler.controller.dispatch(command);
  @override
  Future<void> dispose() => _closing ??= handler.dispose();
}
