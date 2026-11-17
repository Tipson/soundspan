import 'package:flutter/material.dart';

import '../../design_system/design_system.dart';
import 'home_models.dart';

/// Quiet, fully wrapping composition information shared by cards and detail.
class MixSnapshotDetails extends StatelessWidget {
  const MixSnapshotDetails({super.key, required this.snapshot});
  final MixSnapshot? snapshot;

  @override
  Widget build(BuildContext context) => Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      for (final label in snapshot?.labels ?? const <String>[])
        Padding(
          padding: const EdgeInsets.only(top: 4),
          child: Text(
            label,
            style: Theme.of(context).textTheme.bodySmall
                ?.copyWith(color: MusicColors.textSecondary),
          ),
        ),
    ],
  );
}
