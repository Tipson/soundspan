import 'package:flutter/material.dart';

import '../../core/model/app_failure.dart';
import '../../core/model/track.dart';
import '../../design_system/design_system.dart';
import '../library/library_models.dart';
import 'playlist_controller.dart';
import 'playlist_models.dart';

/// Owner-captured editor. Closing a busy sheet never resubmits its intent.
class PlaylistEditorSheet extends StatefulWidget {
  const PlaylistEditorSheet({
    super.key,
    required this.controller,
    this.playlist,
    this.queue,
    this.beforeSave,
  });
  final PlaylistController controller;
  final PlaylistSummary? playlist;
  final List<Track>? queue;

  /// Root validates the captured queue/owner after the user's editor input.
  final Future<void> Function()? beforeSave;
  static Future<PlaylistSummary?> show(
    BuildContext context, {
    required PlaylistController controller,
    PlaylistSummary? playlist,
    List<Track>? queue,
    Future<void> Function()? beforeSave,
  }) => showModalBottomSheet<PlaylistSummary>(
    context: context,
    useRootNavigator: true,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (_) => PlaylistEditorSheet(
      controller: controller,
      playlist: playlist,
      queue: queue == null ? null : List.unmodifiable(queue),
      beforeSave: beforeSave,
    ),
  );
  @override
  State<PlaylistEditorSheet> createState() => _PlaylistEditorSheetState();
}

class _PlaylistEditorSheetState extends State<PlaylistEditorSheet> {
  late final TextEditingController _name = TextEditingController(
    text: widget.playlist?.name ?? '',
  );
  late bool _public = widget.playlist?.isPublic ?? false;
  AppFailure? _failure;
  bool _subsetApproved = false;
  bool _admitting = false;
  late final PlaylistController _owner = widget.controller;
  List<Track> get _compatible {
    final keys = <String>{};
    return widget.queue?.where((t) {
          try {
            playlistAddPayload(t);
            return keys.add(t.ref.identityKey);
          } catch (_) {
            return false;
          }
        }).toList() ??
        [];
  }

  bool get _needsReview =>
      widget.queue != null && _compatible.length != widget.queue!.length;
  Future<void> _save() async {
    if (_admitting ||
        !_owner.isCurrent ||
        _owner != widget.controller ||
        !_owner.canMutate) {
      return;
    }
    if (widget.playlist != null &&
        _owner.state.detail?.playlist.id != widget.playlist!.id) {
      setState(
        () => _failure = const AppFailure(
          code: 'stale_playlist_editor',
          message: 'Открыт другой плейлист. Закройте это окно и откройте редактирование снова.',
        ),
      );
      return;
    }
    setState(() => _failure = null);
    try {
      final draft = PlaylistDraft(name: _name.text, isPublic: _public);
      draft.payload;
      if (_needsReview && !_subsetApproved) return;
      _admitting = true;
      await widget.beforeSave?.call();
      if (!mounted ||
          !(ModalRoute.of(context)?.isCurrent ?? false) ||
          !_owner.isCurrent ||
          _owner != widget.controller ||
          !_owner.canMutate ||
          (widget.playlist != null &&
              _owner.state.detail?.playlist.id != widget.playlist!.id)) {
        return;
      }
      PlaylistSummary? created;
      if (widget.playlist != null) {
        await _owner.update(PlaylistPatch(name: draft.name, isPublic: _public));
      } else if (widget.queue != null) {
        created = await _owner.saveQueue(draft, _compatible);
      } else {
        created = await _owner.create(draft);
      }
      if (mounted && _owner.isCurrent && _owner == widget.controller) {
        Navigator.of(context).pop(created);
      }
    } catch (e) {
      if (mounted && _owner.isCurrent) {
        setState(() => _failure = collectionFailure(e));
      }
    } finally {
      _admitting = false;
    }
  }

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _owner,
    builder: (context, _) {
      final state = _owner.state;
      return SafeArea(
        top: false,
        child: Padding(
          padding: EdgeInsets.only(
            bottom: MediaQuery.viewInsetsOf(context).bottom,
          ),
          child: ConstrainedBox(
            constraints: BoxConstraints(
              maxHeight: MediaQuery.sizeOf(context).height * .9,
            ),
            child: SingleChildScrollView(
              child: Padding(
                padding: const EdgeInsets.all(20),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(
                          child: Text(
                            widget.playlist == null
                                ? 'Новый плейлист'
                                : 'Изменить плейлист',
                            style: Theme.of(context).textTheme.titleLarge,
                          ),
                        ),
                        MusicIconButton(
                          label: 'Закрыть',
                          icon: Icons.close,
                          onPressed: () => Navigator.of(context).pop(),
                        ),
                      ],
                    ),
                    if (state.stale)
                      const MusicStatus(
                        message: 'Аккаунт изменился. Закройте этот экран.',
                      )
                    else ...[
                      TextField(
                        key: const ValueKey('playlist-name'),
                        controller: _name,
                        maxLength: 200,
                        minLines: 1,
                        maxLines: 3,
                        enabled: !state.busy,
                        decoration: const InputDecoration(
                          labelText: 'Название плейлиста',
                        ),
                        textInputAction: TextInputAction.done,
                      ),
                      SwitchListTile(
                        contentPadding: EdgeInsets.zero,
                        title: const Text('Публичный плейлист'),
                        subtitle: const Text(
                          'Другие слушатели смогут открыть плейлист.',
                        ),
                        value: _public,
                        onChanged: state.busy
                            ? null
                            : (v) => setState(() => _public = v),
                      ),
                      if (_needsReview) ...[
                        Text(
                          'Сервер сохранит ${_compatible.length} уникальных совместимых треков из ${widget.queue!.length} позиций очереди. Повторы и неподдерживаемые записи не будут сохранены.',
                        ),
                        CheckboxListTile(
                          contentPadding: EdgeInsets.zero,
                          value: _subsetApproved,
                          title: const Text(
                            'Сохранить только эти уникальные треки',
                          ),
                          onChanged: state.busy
                              ? null
                              : (v) => setState(
                                  () => _subsetApproved = v ?? false,
                                ),
                        ),
                      ],
                      if (_failure != null)
                        MusicStatus(message: _failure!.message, error: true),
                      if (state.uncertain) ...[
                        MusicStatus(
                          message:
                              '${state.pendingIntent ?? 'Изменение'}: ответ потерян. Повторная отправка заблокирована.',
                          error: true,
                        ),
                        MusicButton(
                          label: 'Проверить состояние',
                          onPressed: _owner.reconcile,
                        ),
                        const SizedBox(height: 12),
                        MusicButton(
                          label: 'Закрыть и проверить плейлисты',
                          tonal: true,
                          onPressed: () => Navigator.of(context).pop(),
                        ),
                      ] else
                        MusicButton(
                          label: widget.playlist != null
                              ? 'Сохранить изменения'
                              : _needsReview
                              ? 'Сохранить уникальные треки'
                              : 'Создать плейлист',
                          busy: state.busy,
                          onPressed:
                              _owner.canMutate &&
                                  (!_needsReview ||
                                      (_subsetApproved &&
                                          _compatible.isNotEmpty))
                              ? _save
                              : null,
                          disabledReason:
                              !_owner.repository.networkPolicy.networkAllowed
                              ? 'Для сохранения нужно подключение к сети.'
                              : null,
                        ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
      );
    },
  );
}
