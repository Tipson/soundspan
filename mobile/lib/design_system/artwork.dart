import 'dart:io';

import 'package:flutter/material.dart';

import '../artwork/artwork_loader.dart';
import '../artwork/artwork_scope.dart';
import '../core/model/owner_key.dart';
import '../core/model/track_ref.dart';
import 'tokens.dart';

/// The source's verified private artwork or a neutral, stable fallback.
class Artwork extends StatefulWidget {
  const Artwork({
    super.key,
    this.uri,
    this.trackRef,
    this.size,
    this.radius = MusicRadius.artwork,
    this.semanticLabel,
  });
  final Uri? uri;
  final TrackRef? trackRef;
  final double? size;
  final double radius;
  final String? semanticLabel;
  @override
  State<Artwork> createState() => _ArtworkState();
}

class _ArtworkState extends State<Artwork> {
  ArtworkLoader? _loader;
  SessionFence? _fence;
  Uri? _hint;
  TrackRef? _ref;
  int? _edge;
  int _generation = 0;
  File? _file;
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _update();
  }

  @override
  void didUpdateWidget(Artwork oldWidget) {
    super.didUpdateWidget(oldWidget);
    _update();
  }

  void _update() {
    final scope = ArtworkScope.maybeOf(context);
    final loader = scope?.loader;
    final edge = ((widget.size ?? 512) * MediaQuery.devicePixelRatioOf(context))
        .ceil()
        .clamp(1, 1024);
    if (identical(loader, _loader) &&
        _fence == scope?.fence &&
        _hint == widget.uri &&
        _ref == widget.trackRef &&
        _edge == edge) {
      if (loader?.isCurrent != true) {
        _generation++;
        _file = null;
      }
      return;
    }
    _loader = loader;
    _fence = scope?.fence;
    _hint = widget.uri;
    _ref = widget.trackRef;
    _edge = edge;
    _file = null;
    final generation = ++_generation;
    if (loader == null || !loader.isCurrent) return;
    loader.load(ref: widget.trackRef, hint: widget.uri, edge: edge).then((
      file,
    ) {
      if (!mounted ||
          generation != _generation ||
          !identical(loader, _loader) ||
          !loader.isCurrent ||
          loader.fence != _fence) {
        return;
      }
      setState(() {
        _file = file;
      });
    }, onError: (Object _) {});
  }

  @override
  Widget build(BuildContext context) {
    final fallback = ColoredBox(
      color: MusicColors.surface2,
      child: Center(
        child: Icon(
          Icons.music_note_rounded,
          color: MusicColors.textMuted,
          size: widget.size == null ? 40 : widget.size! * 0.45,
        ),
      ),
    );
    final file = _loader?.isCurrent == true ? _file : null;
    final image = file == null
        ? fallback
        : Image.file(
            file,
            key: ValueKey('${_fence?.epoch}:${file.path}'),
            fit: BoxFit.cover,
            gaplessPlayback: false,
            errorBuilder: (_, _, _) => fallback,
            frameBuilder: (_, child, frame, synchronous) =>
                frame == null ? fallback : child,
          );
    final square = ClipRRect(
      borderRadius: BorderRadius.circular(widget.radius),
      child: AspectRatio(aspectRatio: 1, child: image),
    );
    return Semantics(
      label: widget.semanticLabel,
      image: widget.semanticLabel != null,
      excludeSemantics: true,
      child: widget.size == null
          ? square
          : SizedBox.square(dimension: widget.size, child: square),
    );
  }
}
