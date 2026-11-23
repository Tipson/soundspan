import 'package:flutter/material.dart';

import '../settings/settings_screen.dart';
import 'taste_controller.dart';
import 'taste_repository.dart';

class TasteScreen extends StatefulWidget {
  const TasteScreen({
    super.key,
    required this.controller,
    required this.onComplete,
    this.current,
  });
  final TasteController controller;
  final VoidCallback onComplete;

  /// Live owner-stack admission, including retained tabs and root overlays.
  final bool Function()? current;
  @override
  State<TasteScreen> createState() => _TasteScreenState();
}

class _TasteScreenState extends State<TasteScreen> {
  final _genres = ScrollController(), _artists = ScrollController();
  TasteController get c => widget.controller;
  @override
  void initState() {
    super.initState();
    final controller = c;
    if (controller.state == null) {
      // A previous route may still listen while its reverse transition ends.
      // Notify the shared controller only after this route has finished building.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted &&
            identical(c, controller) &&
            controller.isCurrent &&
            controller.state == null) {
          controller.load();
        }
      });
    }
  }

  @override
  void dispose() {
    _genres.dispose();
    _artists.dispose();
    super.dispose();
  }

  void _scroll(ScrollController scroll, int direction) {
    if (!scroll.hasClients) return;
    final offset =
        (scroll.offset + direction * scroll.position.viewportDimension * .8)
            .clamp(0.0, scroll.position.maxScrollExtent);
    if (MediaQuery.disableAnimationsOf(context)) {
      scroll.jumpTo(offset);
    } else {
      scroll.animateTo(
        offset,
        duration: const Duration(milliseconds: 220),
        curve: Curves.easeOut,
      );
    }
  }

  Future<void> _save({bool skip = false}) async {
    if (!mounted) return;
    final controller = c;
    final route = ModalRoute.of(context);
    final onComplete = widget.onComplete;
    final current = widget.current;
    if (!controller.isCurrent ||
        route?.isCurrent == false ||
        current?.call() == false) {
      return;
    }
    final saved = await controller.save(skip: skip);
    // A popped route remains mounted during its reverse transition. Keep the
    // accepted write, but only its original owner and route may navigate.
    if (saved &&
        mounted &&
        identical(c, controller) &&
        controller.isCurrent &&
        identical(ModalRoute.of(context), route) &&
        route?.isCurrent != false &&
        current?.call() != false) {
      onComplete();
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) => Scaffold(
      appBar: AppBar(title: const Text('Музыкальные вкусы')),
      bottomNavigationBar: c.state == null
          ? null
          : SafeArea(
              top: false,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(20, 12, 20, 12),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Semantics(
                      liveRegion: true,
                      child: Text(
                        'Выбрано: ${c.count}',
                        style: Theme.of(context).textTheme.labelLarge,
                      ),
                    ),
                    const SizedBox(height: 8),
                    _progressButton(context),
                    if (c.state!.needsOnboarding)
                      TextButton(
                        onPressed: c.canEdit ? () => _save(skip: true) : null,
                        child: const Text('Пропустить'),
                      ),
                  ],
                ),
              ),
            ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(20),
          children: [
            Text(
              'Ваша музыка начинается здесь',
              style: Theme.of(context).textTheme.headlineMedium,
            ),
            const SizedBox(height: 12),
            const Text(
              'Выберите близкие жанры и исполнителей. Это поможет рекомендациям понять вас. Выбор можно изменить позже.',
            ),
            const SizedBox(height: 24),
            if (c.loading) const LinearProgressIndicator(),
            if (c.failure != null)
              SettingsFailure(
                c.failure!.message,
                retry: c.state == null ? c.load : null,
              ),
            if (c.state != null) ...[
              Text('Жанры', style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 8),
              SingleChildScrollView(
                controller: _genres,
                scrollDirection: Axis.horizontal,
                child: Row(
                  children: [
                    for (final genre in tasteGenres)
                      Padding(
                        padding: const EdgeInsets.only(right: 8),
                        child: FilterChip(
                          label: Text(genre),
                          selected: c.genres.contains(genre),
                          onSelected: c.canEdit
                              ? (_) => c.toggle(genre, artist: false)
                              : null,
                        ),
                      ),
                  ],
                ),
              ),
              Wrap(
                alignment: WrapAlignment.end,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  IconButton(
                    tooltip: 'Предыдущие жанры',
                    onPressed: () => _scroll(_genres, -1),
                    icon: const Icon(Icons.chevron_left),
                  ),
                  IconButton(
                    tooltip: 'Следующие жанры',
                    onPressed: () => _scroll(_genres, 1),
                    icon: const Icon(Icons.chevron_right),
                  ),
                  TextButton.icon(
                    onPressed: c.canEdit ? _allGenres : null,
                    icon: const Icon(Icons.tune),
                    label: const Text('Все жанры'),
                  ),
                ],
              ),
              const SizedBox(height: 16),
              Text(
                'Исполнители',
                style: Theme.of(context).textTheme.titleLarge,
              ),
              const SizedBox(height: 8),
              TextField(
                enabled: c.canEdit,
                onChanged: c.search,
                textInputAction: TextInputAction.search,
                decoration: const InputDecoration(
                  labelText: 'Найти исполнителя',
                  prefixIcon: Icon(Icons.search),
                  hintText: 'Минимум 2 символа',
                ),
              ),
              if (c.searchQuery.trim().length >= 2) ...[
                if (c.searching) const LinearProgressIndicator(),
                if (c.searchFailure != null)
                  SettingsFailure(
                    c.searchFailure!.message,
                    retry: () => c.search(c.searchQuery),
                  ),
                for (final artist in c.searchResults) _searchRow(artist),
                if (!c.searching &&
                    c.searchFailure == null &&
                    c.searchResults.isEmpty)
                  const Padding(
                    padding: EdgeInsets.all(16),
                    child: Text(
                      'Исполнитель не найден. Попробуйте другое написание.',
                    ),
                  ),
              ] else ...[
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  initialValue: c.genreFilter,
                  isExpanded: true,
                  decoration: const InputDecoration(
                    labelText: 'Каталог исполнителей',
                  ),
                  items: [
                    const DropdownMenuItem(
                      value: 'all',
                      child: Text('Все исполнители'),
                    ),
                    for (final genre in tasteGenres)
                      DropdownMenuItem(
                        value: genre,
                        child: Text(
                          genre,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                  ],
                  onChanged: c.canEdit
                      ? (value) {
                          if (value != null) c.filter(value);
                        }
                      : null,
                ),
                const SizedBox(height: 16),
                SingleChildScrollView(
                  controller: _artists,
                  scrollDirection: Axis.horizontal,
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      for (final artist in c.catalog)
                        Padding(
                          padding: const EdgeInsets.only(right: 12),
                          child: SizedBox(
                            width: MediaQuery.sizeOf(context).width < 360
                                ? 128
                                : 144,
                            child: _artistCard(artist),
                          ),
                        ),
                    ],
                  ),
                ),
                Wrap(
                  alignment: WrapAlignment.end,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    IconButton(
                      tooltip: 'Предыдущие исполнители',
                      onPressed: () => _scroll(_artists, -1),
                      icon: const Icon(Icons.chevron_left),
                    ),
                    IconButton(
                      tooltip: 'Следующие исполнители',
                      onPressed: () => _scroll(_artists, 1),
                      icon: const Icon(Icons.chevron_right),
                    ),
                    if (c.nextPage != null)
                      TextButton(
                        onPressed: c.catalogLoading ? null : c.loadCatalog,
                        child: const Text('Ещё исполнители'),
                      ),
                  ],
                ),
                if (c.catalogLoading) const LinearProgressIndicator(),
                if (c.catalogFailure != null)
                  SettingsFailure(
                    c.catalogFailure!.message,
                    retry: c.loadCatalog,
                  ),
                if (!c.catalogLoading &&
                    c.catalogFailure == null &&
                    c.catalog.isEmpty)
                  const Text(
                    'Каталог этого жанра пока пуст. Попробуйте поиск или другой жанр.',
                  ),
              ],
              if (c.artists.isNotEmpty) ...[
                const SizedBox(height: 16),
                Text(
                  'Ваш выбор',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                const SizedBox(height: 8),
                for (final artist in c.artists)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    title: Text(artist),
                    trailing: IconButton(
                      tooltip: 'Убрать $artist',
                      onPressed: c.canEdit
                          ? () => c.toggle(artist, artist: true)
                          : null,
                      icon: const Icon(Icons.close),
                    ),
                  ),
              ],
            ],
            const SizedBox(height: 24),
          ],
        ),
      ),
    ),
  );
  Widget _artistCard(String artist) {
    final selected = c.artists.any(
      (name) => name.toLowerCase() == artist.toLowerCase(),
    );
    return Semantics(
      selected: selected,
      child: Card(
        color: selected ? Theme.of(context).colorScheme.primaryContainer : null,
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: c.canEdit ? () => c.toggle(artist, artist: true) : null,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              children: [
                CircleAvatar(
                  radius: 32,
                  child: selected
                      ? const Icon(Icons.check, size: 28)
                      : Text(
                          artist.characters.take(1).toString().toUpperCase(),
                          style: Theme.of(context).textTheme.headlineSmall,
                        ),
                ),
                const SizedBox(height: 12),
                Text(artist, textAlign: TextAlign.center),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _searchRow(String artist) => ListTile(
    contentPadding: EdgeInsets.zero,
    title: Text(artist),
    trailing: Icon(
      c.artists.contains(artist)
          ? Icons.check_circle
          : Icons.add_circle_outline,
    ),
    onTap: c.canEdit ? () => c.toggle(artist, artist: true) : null,
  );
  Widget _progressButton(BuildContext context) => Semantics(
    label: 'Сохранить вкусы',
    value: 'Выбрано ${c.count}',
    child: ClipRRect(
      borderRadius: BorderRadius.circular(28),
      child: Stack(
        children: [
          Positioned.fill(
            child: ColoredBox(
              color: Theme.of(context).colorScheme.surfaceContainerHigh,
            ),
          ),
          Positioned.fill(
            child: Align(
              alignment: Alignment.centerLeft,
              child: FractionallySizedBox(
                key: const ValueKey('taste-progress'),
                widthFactor: c.progress,
                child: ColoredBox(
                  color: Theme.of(context).colorScheme.primaryContainer,
                ),
              ),
            ),
          ),
          SizedBox(
            width: double.infinity,
            child: OutlinedButton(
              onPressed: c.canEdit ? () => _save() : null,
              child: Text(
                c.saving
                    ? 'Сохраняем…'
                    : c.count == 0
                    ? 'Настроить под меня'
                    : 'Применить выбор',
              ),
            ),
          ),
        ],
      ),
    ),
  );
  Future<void> _allGenres() => showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (context) => DraggableScrollableSheet(
      expand: false,
      initialChildSize: .7,
      minChildSize: .3,
      maxChildSize: .95,
      builder: (context, scroll) => ListenableBuilder(
        listenable: c,
        builder: (context, _) => ListView(
          controller: scroll,
          padding: const EdgeInsets.all(20),
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    'Все жанры',
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                ),
                IconButton(
                  tooltip: 'Закрыть жанры',
                  onPressed: () => Navigator.pop(context),
                  icon: const Icon(Icons.close),
                ),
              ],
            ),
            for (final genre in tasteGenres)
              CheckboxListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(genre),
                value: c.genres.contains(genre),
                onChanged: c.canEdit
                    ? (_) => c.toggle(genre, artist: false)
                    : null,
              ),
          ],
        ),
      ),
    ),
  );
}
