import 'package:flutter/material.dart';

import 'tokens.dart';

/// Shared keyboard focus ring for musical rows, cards and navigation targets.
class MusicTapTarget extends StatefulWidget {
  const MusicTapTarget({
    super.key,
    required this.child,
    required this.onTap,
    this.borderRadius = const BorderRadius.all(Radius.circular(12)),
  });
  final Widget child;
  final VoidCallback? onTap;
  final BorderRadius borderRadius;
  @override
  State<MusicTapTarget> createState() => _MusicTapTargetState();
}

class _MusicTapTargetState extends State<MusicTapTarget> {
  bool _focused = false;
  @override
  Widget build(BuildContext context) => InkWell(
    onTap: widget.onTap,
    borderRadius: widget.borderRadius,
    onFocusChange: (focused) => setState(() => _focused = focused),
    child: ConstrainedBox(
      constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
      child: DecoratedBox(
        position: DecorationPosition.foreground,
        decoration: BoxDecoration(
          borderRadius: widget.borderRadius,
          border: _focused
              ? Border.all(color: MusicColors.primary, width: 2)
              : null,
        ),
        child: widget.child,
      ),
    ),
  );
}

/// A labelled 48 dp control; no callback means no interactive affordance.
class MusicIconButton extends StatelessWidget {
  const MusicIconButton({
    super.key,
    required this.label,
    required this.icon,
    required this.onPressed,
    this.selected = false,
    this.disabledReason,
  });
  final String label;
  final IconData icon;
  final VoidCallback? onPressed;
  final bool selected;
  final String? disabledReason;
  @override
  Widget build(BuildContext context) => Semantics(
    selected: selected,
    enabled: onPressed != null,
    child: IconButton(
      tooltip: disabledReason == null ? label : '$label. $disabledReason',
      onPressed: onPressed,
      isSelected: selected,
      color: selected ? MusicColors.primary : MusicColors.text,
      icon: Icon(icon),
      constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
    ),
  );
}

/// Intrinsic-height primary action, including very large Russian text.
class MusicButton extends StatelessWidget {
  const MusicButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.icon,
    this.busy = false,
    this.disabledReason,
    this.tonal = false,
  });
  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;
  final bool busy;
  final String? disabledReason;
  final bool tonal;
  @override
  Widget build(BuildContext context) {
    final child = Row(
      mainAxisSize: MainAxisSize.min,
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        if (icon != null) ...[Icon(icon, size: 24), const SizedBox(width: 8)],
        Flexible(child: Text(label, textAlign: TextAlign.center)),
      ],
    );
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        MergeSemantics(
          child: Semantics(
            liveRegion: busy,
            value: busy ? 'Выполняется' : disabledReason,
            enabled: onPressed != null && !busy,
            child: FilledButton(
              style: tonal
                  ? FilledButton.styleFrom(
                      backgroundColor: MusicColors.text,
                      foregroundColor: MusicColors.canvas,
                    )
                  : null,
              onPressed: busy ? null : onPressed,
              child: child,
            ),
          ),
        ),
        if (disabledReason != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              disabledReason!,
              style: Theme.of(context).textTheme.bodyMedium
                  ?.copyWith(color: MusicColors.textSecondary),
            ),
          ),
      ],
    );
  }
}
