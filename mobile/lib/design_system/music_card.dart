import 'package:flutter/material.dart';

import '../core/model/track_ref.dart';
import 'artwork.dart';
import 'music_controls.dart';
import 'tokens.dart';

class MusicCard extends StatelessWidget {
  const MusicCard({
    super.key,
    required this.title,
    required this.onOpen,
    this.subtitle,
    this.artwork,
    this.trackRef,
    this.onMore,
    this.width = 148,
  });
  final String title;
  final String? subtitle;
  final Uri? artwork;
  final TrackRef? trackRef;
  final VoidCallback onOpen;
  final VoidCallback? onMore;
  final double width;
  @override
  Widget build(BuildContext context) => SizedBox(
    width: width,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Semantics(
          button: true,
          label: 'Открыть $title${subtitle == null ? '' : ', $subtitle'}',
          child: MusicTapTarget(
            onTap: onOpen,
            borderRadius: BorderRadius.circular(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Artwork(uri: artwork, trackRef: trackRef, radius: 16),
                const SizedBox(height: 12),
                Text(
                  title,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                if (subtitle != null) ...[
                  const SizedBox(height: 4),
                  Text(
                    subtitle!,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.bodyMedium
                        ?.copyWith(color: MusicColors.textSecondary),
                  ),
                ],
              ],
            ),
          ),
        ),
        if (onMore != null)
          Align(
            alignment: Alignment.centerRight,
            child: MusicIconButton(
              label: 'Действия с подборкой «$title»',
              icon: Icons.more_horiz,
              onPressed: onMore,
            ),
          ),
      ],
    ),
  );
}

class MusicShelf extends StatelessWidget {
  const MusicShelf({
    super.key,
    required this.title,
    required this.children,
    this.onShowAll,
  });
  final String title;
  final List<Widget> children;
  final VoidCallback? onShowAll;
  static double cardWidth(double width) =>
      width < 360 ? 132 : (width < 410 ? 148 : 160);
  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Padding(
        padding: EdgeInsets.symmetric(
          horizontal: MusicSpace.gutter(MediaQuery.sizeOf(context).width),
        ),
        child: Wrap(
          alignment: WrapAlignment.spaceBetween,
          crossAxisAlignment: WrapCrossAlignment.center,
          spacing: 12,
          children: [
            Semantics(
              header: true,
              child: Text(title, style: Theme.of(context).textTheme.titleLarge),
            ),
            if (onShowAll != null)
              TextButton(
                onPressed: onShowAll,
                child: const Text('Показать все'),
              ),
          ],
        ),
      ),
      const SizedBox(height: 12),
      SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: EdgeInsets.symmetric(
          horizontal: MusicSpace.gutter(MediaQuery.sizeOf(context).width),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (var i = 0; i < children.length; i++) ...[
              if (i != 0) const SizedBox(width: 12),
              children[i],
            ],
          ],
        ),
      ),
    ],
  );
}
