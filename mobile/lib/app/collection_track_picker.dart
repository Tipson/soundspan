import 'dart:async';

import 'package:flutter/material.dart';

import '../core/model/track.dart';
import '../features/playlists/playlist_models.dart';

/// One explicit selection batch; searching never clears earlier selections.
class CollectionTrackPicker extends StatefulWidget {
  const CollectionTrackPicker({
    super.key,
    required this.initial,
    required this.search,
    required this.isCurrent,
  });
  final List<Track> initial;
  final Future<List<Track>> Function(String) search;
  final bool Function() isCurrent;
  @override
  State<CollectionTrackPicker> createState() => _CollectionTrackPickerState();
}

class _CollectionTrackPickerState extends State<CollectionTrackPicker> {
  late List<Track> _rows = widget.initial;
  final _selected = <String, Track>{};
  Timer? _debounce;
  int _revision = 0;
  bool _loading = false;
  String? _error;
  bool _compatible(Track track) {
    try {
      playlistAddPayload(track);
      return true;
    } catch (_) {
      return false;
    }
  }

  void _query(String value) {
    _debounce?.cancel();
    final revision = ++_revision;
    setState(() {
      _loading = value.trim().isNotEmpty;
      _error = null;
    });
    if (value.trim().isEmpty) {
      setState(() => _rows = widget.initial);
      return;
    }
    _debounce = Timer(const Duration(milliseconds: 300), () async {
      try {
        if (!widget.isCurrent()) return;
        final rows = await widget.search(value.trim());
        if (!mounted || !widget.isCurrent() || revision != _revision) return;
        setState(() => _rows = rows);
      } catch (_) {
        if (mounted && widget.isCurrent() && revision == _revision) {
          setState(
            () => _error = 'Не удалось выполнить поиск. Попробуйте ещё раз.',
          );
        }
      } finally {
        if (mounted && revision == _revision) setState(() => _loading = false);
      }
    });
  }

  @override
  void dispose() {
    _revision++;
    _debounce?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => SafeArea(
    child: Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SizedBox(
        height: MediaQuery.sizeOf(context).height * .8,
        child: CustomScrollView(
          keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
          slivers: [
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Row(
                  children: [
                    const Expanded(
                      child: Text(
                        'Добавить музыку',
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
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: TextField(
                  onChanged: _query,
                  decoration: const InputDecoration(
                    labelText: 'Найти трек',
                    prefixIcon: Icon(Icons.search),
                  ),
                ),
              ),
            ),
            if (_loading)
              const SliverToBoxAdapter(child: LinearProgressIndicator()),
            if (_error != null)
              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Text(_error!),
                ),
              ),
            if (_rows.isEmpty)
              const SliverToBoxAdapter(
                child: Padding(
                  padding: EdgeInsets.all(24),
                  child: Text('Найдите музыку или выберите из Любимого'),
                ),
              )
            else
              SliverList.builder(
                itemCount: _rows.length,
                itemBuilder: (_, index) {
                  final track = _rows[index],
                      compatible = _compatible(_rows[index]);
                  return CheckboxListTile(
                    key: ValueKey('pick-${track.ref.identityKey}'),
                    value: _selected.containsKey(track.ref.identityKey),
                    title: Text(
                      track.title,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                    subtitle: Text(
                      compatible
                          ? track.artist
                          : 'Сервер не сохраняет эту запись в плейлист',
                    ),
                    onChanged: compatible && widget.isCurrent()
                        ? (value) => setState(() {
                            if (value == true) {
                              _selected[track.ref.identityKey] = track;
                            } else {
                              _selected.remove(track.ref.identityKey);
                            }
                          })
                        : null,
                  );
                },
              ),
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: _selected.isEmpty || !widget.isCurrent()
                        ? null
                        : () {
                            if (widget.isCurrent()) {
                              Navigator.pop(context, _selected.values.toList());
                            }
                          },
                    child: Text('Добавить ${_selected.length}'),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    ),
  );
}
