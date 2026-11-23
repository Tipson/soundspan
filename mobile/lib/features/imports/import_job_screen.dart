import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'import_controller.dart';
import 'import_screen.dart';

class ImportJobScreen extends StatelessWidget {
  const ImportJobScreen({
    super.key,
    required this.controller,
    required this.jobId,
    required this.onOpenPlaylist,
    this.foreground,
    this.onOpenLibrary,
  });
  final ImportController controller;
  final String jobId;
  final ValueChanged<String> onOpenPlaylist;
  final VoidCallback? onOpenLibrary;
  final ValueListenable<bool>? foreground;
  @override
  Widget build(BuildContext context) => ImportScreen(
    controller: controller,
    jobId: jobId,
    pickDocument: () async => null,
    onOpenPlaylist: onOpenPlaylist,
    foreground: foreground,
    onOpenLibrary: onOpenLibrary,
  );
}
