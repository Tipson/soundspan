import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/model/track.dart';
import '../../design_system/artwork.dart';
import '../../design_system/tokens.dart';
import '../library/library_models.dart';
import 'lyrics_controller.dart';

typedef ExtrasTrackAction = FutureOr<void> Function(
  Track track,
  ExtrasActionTarget target,
);

class ExtrasContents {
  const ExtrasContents({
    required this.header,
    this.count = 0,
    this.itemBuilder,
  });
  final List<Widget> header;
  final int count;
  final Widget Function(BuildContext, int)? itemBuilder;
}

/// Lazy scroll body, accessible Back during loading, lifetime action retirement.
class ExtrasFrame extends StatefulWidget {
  const ExtrasFrame({
    super.key,
    required this.controller,
    required this.title,
    required this.contents,
    this.onMount,
    this.onRetry,
  });
  final ExtrasController controller;
  final String title;
  final ExtrasContents Function(BuildContext) contents;
  final VoidCallback? onMount, onRetry;
  @override
  State<ExtrasFrame> createState() => _ExtrasFrameState();
}

class _ExtrasFrameState extends State<ExtrasFrame> {
  @override
  void initState() {
    super.initState();
    widget.onMount?.call();
  }

  @override
  void didUpdateWidget(ExtrasFrame old) {
    super.didUpdateWidget(old);
    if (old.controller != widget.controller) {
      old.controller.reset();
      widget.onMount?.call();
    }
  }

  @override
  void dispose() {
    widget.controller.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.controller,
    builder: (context, _) {
      final c = widget.controller, body = widget.contents(context);
      return PopScope(
        onPopInvokedWithResult: (popped, result) {
          if (popped) c.cancel();
        },
        child: Scaffold(
          appBar: AppBar(
            leading: IconButton(
              tooltip: 'Назад',
              icon: const Icon(Icons.arrow_back),
              onPressed: () {
                c.reset();
                Navigator.maybePop(context);
              },
            ),
            title: Text(
              widget.title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          body: SafeArea(
            top: false,
            child: ListView.builder(
              padding: const EdgeInsets.fromLTRB(20, 12, 20, 32),
              itemCount: c.isCurrent ? body.count + 1 : 1,
              itemBuilder: (context, index) {
                if (index > 0) return body.itemBuilder!(context, index - 1);
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (!c.isCurrent)
                      const Text('Аккаунт изменился. Откройте раздел снова.')
                    else
                      ...body.header,
                    if (c.isCurrent &&
                        !c.repository.networkPolicy.networkAllowed &&
                        c.failure?.code != 'offline_mode')
                      const Padding(
                        padding: EdgeInsets.symmetric(vertical: 12),
                        child: Text(
                          'Включён офлайн-режим. Этот раздел требует подключения.',
                        ),
                      ),
                    if (c.busy)
                      const Padding(
                        padding: EdgeInsets.symmetric(vertical: 16),
                        child: LinearProgressIndicator(
                          semanticsLabel: 'Загрузка',
                        ),
                      ),
                    if (c.failure != null && c.isCurrent) ...[
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 12),
                        child: Text(
                          c.failure!.message,
                          style: const TextStyle(color: MusicColors.error),
                        ),
                      ),
                      if (widget.onRetry != null)
                        TextButton(
                          onPressed: c.busy ? null : widget.onRetry,
                          child: const Text('Повторить'),
                        ),
                    ],
                  ],
                );
              },
            ),
          ),
        ),
      );
    },
  );
}

/// Display/actions never discard unsupported rows or invent a provider fallback.
class ExtrasTrackTile extends StatelessWidget {
  const ExtrasTrackTile({
    super.key,
    required this.track,
    required this.controller,
    required this.onPlay,
    this.subtitle,
    this.onActions,
    this.onEnqueue,
  });
  final Track track;
  final ExtrasController controller;
  final VoidCallback onPlay;
  final String? subtitle;
  final ExtrasTrackAction? onActions;
  final VoidCallback? onEnqueue;
  Future<void> _actions(BuildContext context) async {
    final target = controller.target([track]);
    try {
      await target.assertCurrent();
      if (context.mounted) await onActions?.call(track, target);
    } catch (e) {
      if (context.mounted && target.isCurrent) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(collectionFailure(e).message)));
      }
    }
  }

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 8),
    child: Material(
      color: MusicColors.surface1,
      borderRadius: BorderRadius.circular(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InkWell(
            borderRadius: BorderRadius.circular(16),
            onTap: track.playable && !controller.busy && controller.isCurrent
                ? onPlay
                : null,
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Artwork(trackRef: track.ref, uri: track.artwork, size: 48),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          track.title.isEmpty
                              ? 'Недоступный трек'
                              : track.title,
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                        Text(
                          track.artist,
                          style: Theme.of(context).textTheme.bodyMedium,
                        ),
                        if (subtitle != null)
                          Text(
                            subtitle!,
                            style: Theme.of(context).textTheme.labelSmall,
                          ),
                        if (!track.playable)
                          const Text(
                            'Воспроизведение недоступно',
                            style: TextStyle(color: MusicColors.textMuted),
                          ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
          if ((onEnqueue != null && track.playable) || onActions != null)
            Wrap(
              alignment: WrapAlignment.end,
              children: [
                if (onEnqueue != null && track.playable)
                  TextButton(
                    onPressed: controller.busy ? null : onEnqueue,
                    child: const Text('В очередь'),
                  ),
                if (onActions != null)
                  IconButton(
                    tooltip: 'Действия с треком',
                    onPressed: controller.busy ? null : () => _actions(context),
                    icon: const Icon(Icons.more_horiz),
                  ),
              ],
            ),
        ],
      ),
    ),
  );
}

class LyricsSheet extends StatelessWidget {
  const LyricsSheet({super.key, required this.controller});
  final LyricsController controller;
  static Future<void> show(BuildContext context, LyricsController controller) =>
      showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        useSafeArea: true,
        builder: (_) => FractionallySizedBox(
          heightFactor: .94,
          child: LyricsSheet(controller: controller),
        ),
      );
  @override
  Widget build(BuildContext context) => ExtrasFrame(
    controller: controller,
    title: 'Текст песни',
    onMount: () => unawaited(controller.follow(force: true)),
    onRetry: () => unawaited(controller.follow(force: true)),
    contents: (context) {
      final doc = controller.document, lines = doc?.lines ?? [];
      return ExtrasContents(
        header: [
          if (controller.track == null)
            const Text('Сейчас ничего не играет')
          else ...[
            Text(
              controller.track!.title,
              style: Theme.of(context).textTheme.headlineSmall,
            ),
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 12),
              child: Text(controller.track!.artist),
            ),
            if (doc != null && doc.isEmpty)
              const Text('Текст песни пока не найден'),
            if (lines.isEmpty && doc?.plain != null)
              SelectableText(
                doc!.plain!,
                style: Theme.of(context).textTheme.bodyLarge,
              ),
            if (lines.isNotEmpty)
              const Text('Нажмите на строку, чтобы перейти к этому моменту.'),
          ],
        ],
        count: lines.length,
        itemBuilder: (context, index) {
          final line = lines[index], active = index == controller.activeLine;
          return Padding(
            padding: const EdgeInsets.symmetric(vertical: 3),
            child: TextButton(
              style: TextButton.styleFrom(
                alignment: Alignment.centerLeft,
                backgroundColor: active ? MusicColors.primaryContainer : null,
                foregroundColor: active
                    ? MusicColors.onPrimaryContainer
                    : MusicColors.textSecondary,
              ),
              onPressed: controller.busy
                  ? null
                  : () => unawaited(controller.seek(line)),
              child: Semantics(
                selected: active,
                child: Text(
                  line.text.isEmpty ? '♪' : line.text,
                  style: Theme.of(context).textTheme.titleLarge,
                ),
              ),
            ),
          );
        },
      );
    },
  );
}
