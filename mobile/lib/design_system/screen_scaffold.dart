import 'package:flutter/material.dart';

import 'tokens.dart';

/// Feature content lives above the shell's measured footer, never behind it.
class ScreenScaffold extends StatelessWidget {
  const ScreenScaffold({
    super.key,
    required this.title,
    required this.child,
    this.actions,
    this.leading,
    this.scrollController,
    this.scrollable = true,
  });
  final String title;
  final Widget child;
  final List<Widget>? actions;
  final Widget? leading;
  final ScrollController? scrollController;
  final bool scrollable;
  @override
  Widget build(BuildContext context) {
    final largeText = MediaQuery.textScalerOf(context).scale(16) > 20.8;
    return Scaffold(
      appBar: AppBar(
        title: largeText
            ? null
            : Semantics(
                header: true,
                child: Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
        leading: leading,
        actions: actions,
      ),
      body: SafeArea(
        top: false,
        bottom: false,
        child: LayoutBuilder(
          builder: (context, constraints) {
            final gutter = MusicSpace.gutter(constraints.maxWidth);
            final content = Align(
              alignment: Alignment.topCenter,
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 960),
                child: Padding(
                  padding: EdgeInsets.fromLTRB(gutter, 16, gutter, 16),
                  child: largeText
                      ? Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Semantics(
                              header: true,
                              child: Text(
                                title,
                                style: Theme.of(context)
                                    .textTheme
                                    .headlineMedium,
                                maxLines: 3,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                            const SizedBox(height: 20),
                            child,
                          ],
                        )
                      : child,
                ),
              ),
            );
            return scrollable
                ? SingleChildScrollView(
                    controller: scrollController,
                    keyboardDismissBehavior:
                        ScrollViewKeyboardDismissBehavior.onDrag,
                    child: content,
                  )
                : content;
          },
        ),
      ),
    );
  }
}
