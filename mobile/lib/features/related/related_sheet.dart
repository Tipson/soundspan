import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/model/track.dart';
import '../library/library_models.dart';
import '../lyrics/lyrics_controller.dart';
import '../lyrics/lyrics_sheet.dart';
import 'related_controller.dart';
import 'related_repository.dart';

typedef RelatedEntityAction = FutureOr<void> Function(
  RelatedEntity entity,
  ExtrasActionTarget target,
);

class RelatedSheet extends StatefulWidget {
  const RelatedSheet({
    super.key,
    required this.controller,
    this.track,
    this.onArtist,
    this.onAlbum,
    this.onTrackActions,
  });
  final RelatedController controller;
  final Track? track;
  final RelatedEntityAction? onArtist, onAlbum;
  final ExtrasTrackAction? onTrackActions;
  @override
  State<RelatedSheet> createState() => _RelatedSheetState();
}

class _RelatedSheetState extends State<RelatedSheet> {
  @override
  void didUpdateWidget(RelatedSheet old) {
    super.didUpdateWidget(old);
    if (widget.track != null &&
        (old.controller != widget.controller ||
            old.track?.ref != widget.track!.ref)) {
      unawaited(widget.controller.open(widget.track!));
    }
  }

  Future<void> _entity(
    RelatedEntity entity,
    RelatedEntityAction callback,
  ) async {
    final c = widget.controller, t = c.target([]);
    try {
      await t.assertCurrent();
      if (mounted) await callback(entity, t);
    } catch (e) {
      if (mounted && t.isCurrent) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(collectionFailure(e).message)));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    return ExtrasFrame(
      controller: c,
      title: 'Похожая музыка',
      onMount: () {
        if (widget.track != null) unawaited(c.open(widget.track!));
      },
      onRetry: () => unawaited(c.retry()),
      contents: (context) {
        final feed = c.feed,
            tracks = feed?.tracks ?? [],
            entities = [...?feed?.artists, ...?feed?.albums];
        return ExtrasContents(
          header: [
            if (c.seed != null)
              Text(
                c.seed!.title,
                style: Theme.of(context).textTheme.headlineSmall,
              ),
            if (feed?.degradedSources.isNotEmpty ?? false)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 12),
                child: Text('Часть источников временно недоступна'),
              ),
            if (feed != null && tracks.isEmpty && entities.isEmpty)
              const Text('Похожие треки пока не найдены'),
            if (c.seed == null) const Text('Выберите трек в плеере'),
          ],
          count: tracks.length + entities.length,
          itemBuilder: (context, index) {
            if (index < tracks.length) {
              return ExtrasTrackTile(
                track: tracks[index],
                controller: c,
                onPlay: () => unawaited(c.play(index)),
                onEnqueue: () => unawaited(c.enqueue(index)),
                onActions: widget.onTrackActions,
              );
            }
            final entity = entities[index - tracks.length],
                callback = entity.artist ? widget.onArtist : widget.onAlbum;
            return Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    entity.artist ? 'Исполнитель' : 'Альбом',
                    style: Theme.of(context).textTheme.labelSmall,
                  ),
                  if (callback != null)
                    TextButton(
                      onPressed: c.busy
                          ? null
                          : () => _entity(entity, callback),
                      child: Text(entity.title),
                    )
                  else
                    Text(entity.title),
                ],
              ),
            );
          },
        );
      },
    );
  }
}
