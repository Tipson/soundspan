import 'dart:async';

import 'package:flutter/material.dart';

import '../features/settings/profile_screen.dart';
import '../features/settings/settings_models.dart';
import 'owner_avatar_uploader.dart';
import 'owner_ui_session.dart';

/// The only profile-photo reader uses the same fenced native owner uploader.
class OwnerProfileScreen extends StatefulWidget {
  const OwnerProfileScreen({
    super.key,
    required this.session,
    this.pickAvatar,
    required this.onAccount,
  });
  final OwnerUiSession session;
  final Future<AvatarInput?> Function()? pickAvatar;
  final VoidCallback onAccount;
  @override
  State<OwnerProfileScreen> createState() => _OwnerProfileScreenState();
}

class _OwnerProfileScreenState extends State<OwnerProfileScreen> {
  bool _loading = false, _attempted = false;
  String? _failure;
  OwnerAvatarUploader? get _uploader =>
      switch (widget.session.settings.repository.avatarUploader) {
        final OwnerAvatarUploader uploader => uploader,
        _ => null,
      };
  @override
  void initState() {
    super.initState();
    widget.session.settings.addListener(_sync);
    _sync();
  }

  void _sync() {
    final s = widget.session,
        settings = s.settings.settings,
        uploader = _uploader;
    if (!mounted || !s.isCurrent || uploader == null || settings == null) {
      return;
    }
    if (!settings.hasProfilePicture) {
      uploader.clearPicture();
      _attempted = false;
      return;
    }
    if (!_attempted &&
        !_loading &&
        uploader.picture.value == null &&
        s.owner.policy.networkAllowed) {
      _attempted = true;
      _loading = true;
      unawaited(
        uploader
            .loadPicture()
            .catchError((Object _) {
              if (mounted && s.isCurrent) {
                setState(() => _failure = 'Не удалось загрузить фото профиля.');
              }
            })
            .whenComplete(() {
              if (mounted) setState(() => _loading = false);
            }),
      );
    }
  }

  @override
  void dispose() {
    widget.session.settings.removeListener(_sync);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final uploader = _uploader;
    return ProfileScreen(
      controller: widget.session.settings,
      pickAvatar: uploader == null ? null : widget.pickAvatar,
      onAccount: widget.onAccount,
      avatar: uploader == null
          ? null
          : ValueListenableBuilder(
              valueListenable: uploader.picture,
              builder: (_, bytes, _) => Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  CircleAvatar(
                    radius: 44,
                    backgroundImage: bytes == null ? null : MemoryImage(bytes),
                    child: bytes == null
                        ? const Icon(Icons.person_outline, size: 40)
                        : null,
                  ),
                  if (_loading)
                    const Padding(
                      padding: EdgeInsets.all(8),
                      child: LinearProgressIndicator(),
                    ),
                  if (_failure != null)
                    TextButton(
                      onPressed: () {
                        setState(() {
                          _attempted = false;
                          _failure = null;
                        });
                        _sync();
                      },
                      child: Text('$_failure Повторить'),
                    ),
                ],
              ),
            ),
    );
  }
}
