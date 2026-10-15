import 'package:flutter/material.dart';

import '../core/model/track.dart';
import '../features/library/library_models.dart';
import '../features/playlists/playlist_controller.dart';
import '../features/playlists/playlist_models.dart';

/// No write occurs before a destination and any lossy subset are confirmed.
class AddToPlaylistSheet extends StatefulWidget {
  const AddToPlaylistSheet({
    super.key,
    required this.controller,
    required this.tracks,
    required this.assertCurrent,
  });
  final PlaylistController controller;
  final List<Track> tracks;
  final Future<void> Function() assertCurrent;
  @override
  State<AddToPlaylistSheet> createState() => _AddToPlaylistSheetState();
}

class _AddToPlaylistSheetState extends State<AddToPlaylistSheet> {
  String? _id, _failure;
  bool _approved = false, _busy = false;
  late final List<Track> _compatible = () {
    final seen = <String>{};
    return widget.tracks.where((track) {
      try {
        playlistAddPayload(track);
        return seen.add(track.ref.identityKey);
      } catch (_) {
        return false;
      }
    }).toList();
  }();
  bool get _lossy => _compatible.length != widget.tracks.length;
  @override
  void initState() {
    super.initState();
    widget.controller.refreshList();
  }

  Future<void> _save() async {
    final id = _id;
    if (_busy || id == null || _compatible.isEmpty || (_lossy && !_approved)) {
      return;
    }
    setState(() {
      _busy = true;
      _failure = null;
    });
    try {
      await widget.assertCurrent();
      await widget.controller.open(id);
      await widget.assertCurrent();
      if (!mounted) return;
      await widget.controller.add(_compatible);
      await widget.assertCurrent();
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      if (mounted) setState(() => _failure = collectionFailure(e).message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final c = widget.controller;
      final rows = c.state.playlists.where((p) => p.isOwner).toList();
      return SafeArea(
        child: SizedBox(
          height: MediaQuery.sizeOf(context).height * .8,
          child: CustomScrollView(
            slivers: [
              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.all(20),
                  child: Row(
                    children: [
                      const Expanded(
                        child: Text(
                          'Добавить в плейлист',
                          style: TextStyle(fontSize: 22),
                        ),
                      ),
                      IconButton(
                        tooltip: 'Закрыть',
                        onPressed: () => Navigator.pop(context),
                        icon: const Icon(Icons.close),
                      ),
                    ],
                  ),
                ),
              ),
              if (_lossy)
                SliverToBoxAdapter(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    child: CheckboxListTile(
                      title: const Text(
                        'Сохранить только эти уникальные треки',
                      ),
                      subtitle: Text(
                        '${_compatible.length} совместимых треков из ${widget.tracks.length} позиций. Повторы и неподдерживаемые записи не сохранятся.',
                      ),
                      value: _approved,
                      onChanged: _busy
                          ? null
                          : (v) => setState(() => _approved = v == true),
                    ),
                  ),
                ),
              if (_failure != null || c.state.failure != null)
                SliverToBoxAdapter(
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Text(_failure ?? c.state.failure!.message),
                  ),
                ),
              if (c.state.loading || _busy)
                const SliverToBoxAdapter(child: LinearProgressIndicator()),
              if (c.state.uncertain)
                SliverToBoxAdapter(
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Column(
                      children: [
                        const Text(
                          'Результат добавления неизвестен. Проверьте плейлист перед новым действием.',
                        ),
                        TextButton(
                          onPressed: _busy ? null : c.reconcile,
                          child: const Text('Проверить плейлист'),
                        ),
                      ],
                    ),
                  ),
                ),
              if (rows.isEmpty)
                SliverToBoxAdapter(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Text(
                      c.state.loading
                          ? 'Загружаем плейлисты'
                          : 'Сначала создайте плейлист в Моей музыке',
                    ),
                  ),
                )
              else
                SliverList.builder(
                  itemCount: rows.length,
                  itemBuilder: (_, i) => ListTile(
                    leading: Icon(
                      _id == rows[i].id
                          ? Icons.radio_button_checked
                          : Icons.radio_button_off,
                    ),
                    title: Text(rows[i].name),
                    subtitle: Text('${rows[i].trackCount} треков'),
                    onTap: _busy || c.state.uncertain
                        ? null
                        : () => setState(() => _id = rows[i].id),
                  ),
                ),
              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: FilledButton(
                    onPressed:
                        _busy ||
                            c.state.uncertain ||
                            _id == null ||
                            _compatible.isEmpty ||
                            (_lossy && !_approved)
                        ? null
                        : _save,
                    child: Text('Добавить ${_compatible.length}'),
                  ),
                ),
              ),
            ],
          ),
        ),
      );
    },
  );
}
