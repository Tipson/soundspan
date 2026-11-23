import 'dart:async';

import 'package:flutter/material.dart';

import 'music_controls.dart';
import 'tokens.dart';

/// Capabilities are resolved by callers; disabled visible actions explain why.
class MusicAction {
  const MusicAction({
    required this.id,
    required this.label,
    required this.icon,
    this.onSelected,
    this.disabledReason,
    this.destructive = false,
    this.selected = false,
  }) : assert(onSelected != null || disabledReason != null);
  final String id;
  final String label;
  final IconData icon;
  final FutureOr<void> Function()? onSelected;
  final String? disabledReason;
  final bool destructive;
  final bool selected;
  bool get enabled => onSelected != null && disabledReason == null;
}

abstract final class MusicActionSheet {
  /// Back, scrim, drag and Close perform no action. The chosen callback runs
  /// once after dismissal. Mutation failures belong to the owning feature.
  static Future<void> show(
    BuildContext context,
    List<MusicAction> actions, {
    String title = 'Действия',
    bool fullHeight = false,
  }) async {
    final action = await showModalBottomSheet<MusicAction>(
      context: context,
      useRootNavigator: true,
      isScrollControlled: true,
      useSafeArea: true,
      requestFocus: true,
      sheetAnimationStyle: MediaQuery.disableAnimationsOf(context)
          ? AnimationStyle.noAnimation
          : const AnimationStyle(
              duration: MusicMotion.standard,
              reverseDuration: MusicMotion.standard,
            ),
      builder: (context) => _ActionSheetBody(
        title: title,
        actions: actions,
        fullHeight: fullHeight,
      ),
    );
    if (action != null && action.enabled) await action.onSelected!();
  }
}

class _ActionSheetBody extends StatefulWidget {
  const _ActionSheetBody({
    required this.title,
    required this.actions,
    required this.fullHeight,
  });
  final String title;
  final List<MusicAction> actions;
  final bool fullHeight;
  @override
  State<_ActionSheetBody> createState() => _ActionSheetBodyState();
}

class _ActionSheetBodyState extends State<_ActionSheetBody> {
  bool _completed = false;
  void _close([MusicAction? action]) {
    if (_completed) return;
    _completed = true;
    Navigator.of(context).pop(action);
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      top: false,
      child: Padding(
        padding: EdgeInsets.only(
          bottom: MediaQuery.viewInsetsOf(context).bottom,
        ),
        child: ConstrainedBox(
          constraints: BoxConstraints(
            minHeight: widget.fullHeight
                ? MediaQuery.sizeOf(context).height
                : 0,
            maxHeight:
                MediaQuery.sizeOf(context).height *
                (widget.fullHeight ? 1 : 0.8),
          ),
          child: SingleChildScrollView(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Center(
                    child: Container(
                      width: 32,
                      height: 4,
                      decoration: BoxDecoration(
                        color: MusicColors.outlineStrong,
                        borderRadius: BorderRadius.circular(2),
                      ),
                    ),
                  ),
                  const SizedBox(height: 8),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(
                        child: Padding(
                          padding: const EdgeInsets.only(top: 8),
                          child: Semantics(
                            header: true,
                            child: Text(
                              widget.title,
                              style: Theme.of(context).textTheme.titleLarge,
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      MusicIconButton(
                        label: 'Закрыть',
                        icon: Icons.close,
                        onPressed: () => _close(),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  for (final action in widget.actions.where(
                    (a) => !a.destructive,
                  ))
                    _ActionRow(
                      action: action,
                      onSelected: () => _close(action),
                    ),
                  if (widget.actions.any((a) => a.destructive)) ...[
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 12),
                      child: Divider(),
                    ),
                    for (final action in widget.actions.where(
                      (a) => a.destructive,
                    ))
                      _ActionRow(
                        action: action,
                        onSelected: () => _close(action),
                      ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ActionRow extends StatelessWidget {
  const _ActionRow({required this.action, required this.onSelected});
  final MusicAction action;
  final VoidCallback onSelected;
  @override
  Widget build(BuildContext context) {
    final color = action.destructive
        ? MusicColors.error
        : (action.selected ? MusicColors.primary : MusicColors.text);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Semantics(
        selected: action.selected,
        enabled: action.enabled,
        button: true,
        child: Material(
          color: action.selected
              ? MusicColors.primaryContainer
              : Colors.transparent,
          borderRadius: BorderRadius.circular(12),
          child: MusicTapTarget(
            onTap: action.enabled ? onSelected : null,
            borderRadius: BorderRadius.circular(12),
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 56),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 16,
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(
                      action.icon,
                      color: action.enabled ? color : MusicColors.textMuted,
                    ),
                    const SizedBox(width: 16),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            action.label,
                            style: Theme.of(context).textTheme.titleMedium
                                ?.copyWith(color: color),
                          ),
                          if (action.disabledReason != null) ...[
                            const SizedBox(height: 4),
                            Text(
                              action.disabledReason!,
                              style: Theme.of(context).textTheme.bodyMedium
                                  ?.copyWith(color: MusicColors.textSecondary),
                            ),
                          ],
                        ],
                      ),
                    ),
                    if (action.selected) ...[
                      const SizedBox(width: 8),
                      const Icon(Icons.check, color: MusicColors.primary),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
