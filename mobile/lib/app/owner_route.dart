import 'package:flutter/material.dart';

import 'owner_ui_session.dart';

/// A controller belongs to this route occurrence, also retired on owner revoke.
class OwnerRoute extends StatefulWidget {
  const OwnerRoute({super.key, required this.session, required this.create});
  final OwnerUiSession session;
  final Widget Function(void Function(VoidCallback) retire) create;
  @override
  State<OwnerRoute> createState() => _OwnerRouteState();
}

class _OwnerRouteState extends State<OwnerRoute> {
  final _retire = <VoidCallback>[];
  late final Widget _child;
  late final VoidCallback _release;
  bool _closed = false;
  @override
  void initState() {
    super.initState();
    _release = widget.session.lifetime.add(_close);
    _child = widget.create(_retire.add);
  }

  void _close() {
    if (_closed) return;
    _closed = true;
    _release();
    for (final close in _retire.reversed) {
      close();
    }
    _retire.clear();
  }

  @override
  void dispose() {
    _close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => _child;
}
