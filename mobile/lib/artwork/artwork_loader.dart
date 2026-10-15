import 'dart:io';

import 'package:flutter/foundation.dart';

import '../core/model/owner_key.dart';
import '../core/model/track_ref.dart';

/// Owner-fenced, verified local raster files. No credential or remote URL escapes.
abstract interface class ArtworkLoader implements Listenable {
  SessionFence get fence;
  bool get isCurrent;
  Future<File?> load({TrackRef? ref, Uri? hint, int edge = 512});
}
