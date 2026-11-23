import 'dart:async';

import 'package:flutter/material.dart';

import 'music_controls.dart';
import 'tokens.dart';

class MusicStatus extends StatelessWidget {
  const MusicStatus({
    super.key,
    required this.message,
    this.icon = Icons.info_outline,
    this.error = false,
  });
  final String message;
  final IconData icon;
  final bool error;
  @override
  Widget build(BuildContext context) => Semantics(
    liveRegion: error,
    child: Padding(
      padding: const EdgeInsets.symmetric(vertical: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            icon,
            color: error ? MusicColors.error : MusicColors.textSecondary,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              message,
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: error ? MusicColors.error : MusicColors.textSecondary,
              ),
            ),
          ),
        ],
      ),
    ),
  );
}

class MusicEmptyState extends StatelessWidget {
  const MusicEmptyState({
    super.key,
    required this.title,
    required this.message,
    this.actionLabel,
    this.onAction,
    this.icon = Icons.library_music_outlined,
    this.iconColor = MusicColors.primary,
  }) : assert((actionLabel == null) == (onAction == null));
  final String title;
  final String message;
  final String? actionLabel;
  final VoidCallback? onAction;
  final IconData icon;
  final Color iconColor;
  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final content = Padding(
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
        child: Align(
          alignment: Alignment.topCenter,
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 400),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Center(
                  child: Container(
                    width: 64,
                    height: 64,
                    decoration: BoxDecoration(
                      color: MusicColors.surface2,
                      borderRadius: BorderRadius.circular(20),
                    ),
                    child: Icon(icon, size: 30, color: iconColor),
                  ),
                ),
                const SizedBox(height: 20),
                Semantics(
                  header: true,
                  child: Text(
                    title,
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.headlineSmall,
                  ),
                ),
                const SizedBox(height: 12),
                Text(
                  message,
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.bodyLarge
                      ?.copyWith(color: MusicColors.textSecondary),
                ),
                if (onAction != null) ...[
                  const SizedBox(height: 24),
                  MusicButton(label: actionLabel!, onPressed: onAction),
                ],
              ],
            ),
          ),
        ),
      );
      return constraints.hasBoundedHeight
          ? SingleChildScrollView(child: content)
          : content;
    },
  );
}

class MusicErrorState extends StatelessWidget {
  const MusicErrorState({
    super.key,
    required this.title,
    required this.message,
    required this.onRetry,
  });
  final String title;
  final String message;
  final VoidCallback onRetry;
  @override
  Widget build(BuildContext context) => Semantics(
    liveRegion: true,
    child: MusicEmptyState(
      title: title,
      message: message,
      actionLabel: 'Повторить',
      onAction: onRetry,
      icon: Icons.error_outline,
      iconColor: MusicColors.error,
    ),
  );
}

/// Static content geometry first, delayed indeterminate progress after 300 ms.
class MusicLoadingState extends StatefulWidget {
  const MusicLoadingState({
    super.key,
    this.label = 'Загружаем музыку',
    this.rows = 4,
  });
  final String label;
  final int rows;
  @override
  State<MusicLoadingState> createState() => _MusicLoadingStateState();
}

class _MusicLoadingStateState extends State<MusicLoadingState> {
  Timer? _timer;
  bool _showProgress = false;
  @override
  void initState() {
    super.initState();
    _timer = Timer(const Duration(milliseconds: 300), () {
      if (mounted) setState(() => _showProgress = true);
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Semantics(
    label: widget.label,
    child: Column(
      children: [
        for (var i = 0; i < widget.rows; i++)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 12),
            child: ExcludeSemantics(
              child: Row(
                children: [
                  Container(
                    width: 48,
                    height: 48,
                    decoration: BoxDecoration(
                      color: MusicColors.surface2,
                      borderRadius: BorderRadius.circular(8),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Container(height: 16, color: MusicColors.surface2),
                        const SizedBox(height: 8),
                        FractionallySizedBox(
                          widthFactor: 0.65,
                          child: Container(
                            height: 12,
                            color: MusicColors.surface1,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        if (_showProgress)
          Padding(
            padding: const EdgeInsets.all(16),
            child: MediaQuery.disableAnimationsOf(context)
                ? Text(widget.label)
                : const SizedBox.square(
                    dimension: 24,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
          ),
      ],
    ),
  );
}
