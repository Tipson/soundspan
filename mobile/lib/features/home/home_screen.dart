import 'dart:async';

import 'package:flutter/foundation.dart' show ValueListenable;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart'
    show RenderIndexedStack, RenderOffstage, RenderOpacity;

import '../../core/model/app_failure.dart';
import '../../design_system/design_system.dart';
import '../library/library_models.dart';
import 'home_controller.dart';
import 'home_models.dart';

/// Editorial home. Route callbacks open screens without changing playback.
class HomeScreen extends StatefulWidget {
  const HomeScreen({
    super.key,
    required this.controller,
    required this.onOpenWave,
    required this.onOpenMix,
    required this.onPlay,
    this.onOpenProfile,
    this.onOpenHistory,
    this.onOpenDownloads,
    this.onOpenTastes,
    this.onStartWave,
    this.onConfigureWave,
    this.scrollController,
    this.autoLoad = true,
    this.visibility,
  });
  final HomeController controller;
  final FutureOr<void> Function() onOpenWave;
  final FutureOr<void> Function(MusicMix mix) onOpenMix;
  final FutureOr<void> Function(CollectionPlaybackRequest request) onPlay;
  final FutureOr<void> Function()? onOpenProfile,
      onOpenHistory,
      onOpenDownloads,
      onOpenTastes,
      onStartWave,
      onConfigureWave;
  final ScrollController? scrollController;
  final bool autoLoad;

  /// Root combines active tab, route overlays and foreground lifecycle.
  final ValueListenable<bool>? visibility;
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> with WidgetsBindingObserver {
  final _viewport = GlobalKey();
  final _shelves = <String, GlobalKey<_HomeTrackShelfState>>{};
  Timer? _visibility;
  AppFailure? _actionFailure;
  AppFailure? _waveFailure;
  bool _startingWave = false;
  bool _foreground = true, _tickersEnabled = true, _routeCurrent = true;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    final lifecycle = WidgetsBinding.instance.lifecycleState;
    _foreground = lifecycle == null || lifecycle == AppLifecycleState.resumed;
    widget.visibility?.addListener(_exposureChanged);
    if (widget.autoLoad) unawaited(widget.controller.refresh());
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _tickersEnabled = TickerMode.valuesOf(context).enabled;
    _routeCurrent = ModalRoute.isCurrentOf(context) ?? true;
    _exposureChanged();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    _exposureChanged();
  }

  void _exposureChanged() {
    _visibility?.cancel();
    if (!mounted ||
        !_foreground ||
        !_tickersEnabled ||
        !_routeCurrent ||
        widget.visibility?.value == false) {
      return;
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _scheduleVisible();
    });
  }

  bool _canExpose() {
    if (!mounted ||
        !_foreground ||
        !_tickersEnabled ||
        !_routeCurrent ||
        widget.visibility?.value == false) {
      return false;
    }
    RenderObject? branch = _viewport.currentContext?.findRenderObject();
    if (branch == null || !branch.attached) return false;
    while (branch != null) {
      final parent = branch.parent;
      if (parent is RenderOffstage && parent.offstage) return false;
      if (parent is RenderOpacity && parent.opacity == 0) return false;
      if (parent is RenderIndexedStack) {
        RenderBox? painted = parent.firstChild;
        final index = parent.index;
        if (index == null) return false;
        for (var i = 0; i < index && painted != null; i++) {
          painted = parent.childAfter(painted);
        }
        if (!identical(painted, branch)) return false;
      }
      branch = parent;
    }
    return true;
  }

  @override
  void didUpdateWidget(HomeScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.visibility != widget.visibility) {
      oldWidget.visibility?.removeListener(_exposureChanged);
      widget.visibility?.addListener(_exposureChanged);
    }
    _exposureChanged();
    if (oldWidget.controller != widget.controller) {
      _visibility?.cancel();
      _shelves.clear();
      _actionFailure = null;
      _waveFailure = null;
      _startingWave = false;
      if (widget.autoLoad) unawaited(widget.controller.refresh());
    }
  }

  void _scheduleVisible() {
    _visibility?.cancel();
    if (!mounted ||
        !_foreground ||
        !_tickersEnabled ||
        !_routeCurrent ||
        widget.visibility?.value == false) {
      return;
    }
    final owner = widget.controller, feed = owner.state.feed;
    _visibility = Timer(const Duration(milliseconds: 220), () {
      if (!mounted ||
          owner != widget.controller ||
          !_canExpose() ||
          !owner.isCurrent ||
          !identical(feed, owner.state.feed)) {
        return;
      }
      for (final shelf in _shelves.values) {
        shelf.currentState?.reportVisible();
      }
    });
  }

  Future<void> _run(FutureOr<void> Function() callback) async {
    final owner = widget.controller;
    if (!owner.isCurrent) return;
    setState(() => _actionFailure = null);
    try {
      await callback();
    } catch (error) {
      if (mounted && owner == widget.controller && owner.isCurrent) {
        setState(() => _actionFailure = homeFailure(error));
      }
    }
  }

  Future<void> _startWave() async {
    final owner = widget.controller, start = widget.onStartWave;
    if (_startingWave || start == null || !owner.isCurrent) return;
    setState(() {
      _startingWave = true;
      _waveFailure = null;
    });
    try {
      await start();
    } catch (error) {
      if (mounted && owner == widget.controller && owner.isCurrent) {
        setState(() => _waveFailure = homeFailure(error));
      }
    } finally {
      if (mounted && owner == widget.controller && owner.isCurrent) {
        setState(() => _startingWave = false);
      }
    }
  }

  Widget _heading(BuildContext context, String title, {String? subtitle}) =>
      Padding(
        padding: const EdgeInsets.fromLTRB(20, 24, 20, 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Semantics(
              header: true,
              child: Text(title, style: Theme.of(context).textTheme.titleLarge),
            ),
            if (subtitle != null) ...[
              const SizedBox(height: 4),
              Text(
                subtitle,
                style: Theme.of(context).textTheme.bodySmall
                    ?.copyWith(color: MusicColors.textSecondary),
              ),
            ],
          ],
        ),
      );
  Widget _hero(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 8, 20, 0),
      child: Material(
        key: const ValueKey('home-wave-entry'),
        borderRadius: BorderRadius.circular(MusicRadius.card),
        color: MusicColors.surface1,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Ваша волна',
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                        const SizedBox(height: 4),
                        Text(
                          'Знакомое и новые открытия.',
                          style: Theme.of(context).textTheme.bodyMedium
                              ?.copyWith(color: MusicColors.textSecondary),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 12),
                  const SizedBox(width: 72, height: 52, child: WaveArtwork()),
                ],
              ),
              const SizedBox(height: 12),
              if (widget.onStartWave != null)
                MusicButton(
                  label: _startingWave
                      ? 'Запускаем волну…'
                      : _waveFailure == null
                      ? 'Слушать волну'
                      : 'Повторить запуск',
                  icon: Icons.play_arrow_rounded,
                  busy: _startingWave,
                  onPressed: _startWave,
                ),
              Row(
                children: [
                  Expanded(
                    child: widget.onStartWave == null
                        ? MusicButton(
                            label: 'Открыть волну',
                            icon: Icons.arrow_forward_rounded,
                            onPressed: () => _run(widget.onOpenWave),
                          )
                        : TextButton(
                            onPressed: () => _run(widget.onOpenWave),
                            child: const Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Flexible(child: Text('Открыть волну')),
                                SizedBox(width: 8),
                                Icon(Icons.arrow_forward_rounded, size: 18),
                              ],
                            ),
                          ),
                  ),
                  if (widget.onConfigureWave != null)
                    MusicIconButton(
                      label: 'Настроить волну',
                      icon: Icons.tune_rounded,
                      onPressed: () => _run(widget.onConfigureWave!),
                    ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _featuredMix(BuildContext context, MusicMix mix) => Padding(
    padding: const EdgeInsets.fromLTRB(20, 12, 20, 0),
    child: MusicTapTarget(
      onTap: () => _run(() => widget.onOpenMix(mix)),
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: MusicColors.surface1,
          borderRadius: BorderRadius.circular(16),
        ),
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              Artwork(uri: mix.cover, size: 80, radius: 12),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      mix.title,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    if (mix.description.isNotEmpty) ...[
                      const SizedBox(height: 4),
                      Text(
                        mix.description,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.bodySmall
                            ?.copyWith(color: MusicColors.textSecondary),
                      ),
                    ],
                    const SizedBox(height: 6),
                    Text(
                      musicQuantity(
                        mix.trackCount,
                        one: 'трек',
                        few: 'трека',
                        many: 'треков',
                      ),
                      style: Theme.of(context).textTheme.labelSmall
                          ?.copyWith(color: MusicColors.textMuted),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    ),
  );

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.controller,
    builder: (context, _) {
      final state = widget.controller.state, feed = state.feed;
      final daily = feed.mixes
          .where((m) => m.kind == MusicMixKind.daily)
          .toList();
      final legacy = feed.mixes
          .where((m) => m.kind == MusicMixKind.legacy)
          .toList();
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _scheduleVisible();
      });
      final sections = <Widget>[
        _hero(context),
        if (_waveFailure != null)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20),
            child: MusicStatus(message: _waveFailure!.message, error: true),
          ),
        if (_actionFailure != null)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20),
            child: MusicStatus(message: _actionFailure!.message, error: true),
          ),
        if (state.loading)
          const Padding(
            padding: EdgeInsets.all(20),
            child: MusicLoadingState(label: 'Собираем музыку для вас'),
          ),
        if (state.failure != null)
          MusicErrorState(
            title: 'Не удалось загрузить главную',
            message: state.failure!.message,
            onRetry: widget.controller.refresh,
          ),
        if (feed.languagePending)
          const Padding(
            padding: EdgeInsets.symmetric(horizontal: 20),
            child: MusicStatus(
              message:
                  'Уточняем язык песен. Подборки появятся после обработки.',
            ),
          ),
        if (feed.degraded)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const MusicStatus(
                  message: 'Часть музыки временно недоступна. Доступные подборки остаются ниже.',
                ),
                TextButton(
                  onPressed: widget.controller.retryFailed,
                  child: const Text('Повторить загрузку подборок'),
                ),
              ],
            ),
          ),
        if (feed.insufficientTaste && !state.loading)
          MusicEmptyState(
            title: 'Познакомимся с вашим вкусом',
            message: 'Слушайте и отмечайте любимую музыку, чтобы подборки становились точнее.',
            actionLabel: widget.onOpenTastes == null
                ? null
                : 'Выбрать музыкальные вкусы',
            onAction: widget.onOpenTastes == null
                ? null
                : () => _run(widget.onOpenTastes!),
          ),
        if (!widget.controller.online && widget.onOpenDownloads != null)
          Padding(
            padding: const EdgeInsets.all(20),
            child: MusicButton(
              label: 'Открыть загрузки',
              icon: Icons.offline_pin_outlined,
              onPressed: () => _run(widget.onOpenDownloads!),
            ),
          ),
        if (daily.isNotEmpty) ...[
          _heading(context, 'Миксы для вас'),
          _MixShelf(
            mixes: daily,
            onOpen: (mix) => _run(() => widget.onOpenMix(mix)),
          ),
        ],
        for (final mix in feed.mixes.where(
          (m) =>
              m.kind == MusicMixKind.dailyBlend ||
              m.kind == MusicMixKind.daypart,
        ))
          _featuredMix(context, mix),
        for (final mix in feed.mixes.where(
          (m) => m.kind == MusicMixKind.weekly,
        )) ...[
          _heading(context, 'Свежий взгляд на музыку'),
          _featuredMix(context, mix),
        ],
        for (final shelf in feed.shelves.where((s) => s.tracks.isNotEmpty)) ...[
          _heading(
            context,
            shelf.title,
            subtitle: musicQuantity(
              shelf.tracks.length,
              one: 'трек',
              few: 'трека',
              many: 'треков',
            ),
          ),
          _HomeTrackShelf(
            key: _shelves.putIfAbsent(
              shelf.id,
              () => GlobalKey<_HomeTrackShelfState>(),
            ),
            shelf: shelf,
            owner: widget.controller,
            rootViewport: _viewport,
            onScroll: _scheduleVisible,
            isVisible: _canExpose,
            onPlay: (index) => _run(() async {
              if (!identical(feed, widget.controller.state.feed)) return;
              final mix = MusicMix(
                id: shelf.id,
                title: shelf.title,
                description: '',
                kind: MusicMixKind.dailyBlend,
                tracks: shelf.tracks,
                generationId: shelf.generationId,
              );
              await widget.onPlay(
                widget.controller.playbackRequest(mix, index),
              );
            }),
          ),
        ],
        if (legacy.isNotEmpty) ...[
          _heading(
            context,
            'Из вашей коллекции',
            subtitle: musicQuantity(
              legacy.length,
              one: 'подборка',
              few: 'подборки',
              many: 'подборок',
            ),
          ),
          _MixShelf(
            mixes: legacy,
            onOpen: (mix) => _run(() => widget.onOpenMix(mix)),
          ),
        ],
        if (!state.loading &&
            state.failure == null &&
            feed.empty &&
            !feed.insufficientTaste &&
            !feed.degraded)
          const MusicEmptyState(
            title: 'Музыка ещё не найдена',
            message: 'Вернитесь чуть позже или откройте волну.',
          ),
        const SizedBox(height: 32),
      ];
      return Scaffold(
        appBar: AppBar(
          title: const Text('Главная'),
          actions: [
            if (widget.onOpenHistory != null)
              MusicIconButton(
                label: 'История прослушивания',
                icon: Icons.history,
                onPressed: () => _run(widget.onOpenHistory!),
              ),
            if (widget.onOpenProfile != null)
              MusicIconButton(
                label: 'Настройки',
                icon: Icons.settings_outlined,
                onPressed: () => _run(widget.onOpenProfile!),
              ),
          ],
        ),
        body: SafeArea(
          top: false,
          bottom: false,
          child: state.stale
              ? const MusicEmptyState(
                  title: 'Аккаунт изменился',
                  message: 'Откройте главную снова.',
                )
              : NotificationListener<ScrollNotification>(
                  onNotification: (_) {
                    _scheduleVisible();
                    return false;
                  },
                  child: SizedBox.expand(
                    key: _viewport,
                    child: ListView.builder(
                      key: const ValueKey('home-scroll'),
                      controller: widget.scrollController,
                      itemCount: sections.length,
                      itemBuilder: (_, i) => Align(
                        alignment: Alignment.topCenter,
                        child: ConstrainedBox(
                          constraints: const BoxConstraints(maxWidth: 960),
                          child: SizedBox(
                            width: double.infinity,
                            child: sections[i],
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
        ),
      );
    },
  );
  @override
  void dispose() {
    _visibility?.cancel();
    widget.visibility?.removeListener(_exposureChanged);
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }
}

class _MixShelf extends StatelessWidget {
  const _MixShelf({required this.mixes, required this.onOpen});
  final List<MusicMix> mixes;
  final void Function(MusicMix) onOpen;
  @override
  Widget build(BuildContext context) {
    final width = MusicShelf.cardWidth(MediaQuery.sizeOf(context).width),
        scale = MediaQuery.textScalerOf(context).scale(16) / 16;
    return SizedBox(
      height: width + 88 * scale + 4,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 20),
        itemCount: mixes.length,
        separatorBuilder: (_, _) => const SizedBox(width: 12),
        itemBuilder: (_, i) => MusicCard(
          width: width,
          title: mixes[i].title,
          subtitle: musicQuantity(
            mixes[i].trackCount,
            one: 'трек',
            few: 'трека',
            many: 'треков',
          ),
          artwork: mixes[i].cover,
          onOpen: () => onOpen(mixes[i]),
        ),
      ),
    );
  }
}

class _HomeTrackShelf extends StatefulWidget {
  const _HomeTrackShelf({
    super.key,
    required this.shelf,
    required this.owner,
    required this.rootViewport,
    required this.onScroll,
    required this.onPlay,
    required this.isVisible,
  });
  final HomeShelf shelf;
  final HomeController owner;
  final GlobalKey rootViewport;
  final VoidCallback onScroll;
  final bool Function() isVisible;
  final void Function(int) onPlay;
  @override
  State<_HomeTrackShelf> createState() => _HomeTrackShelfState();
}

class _HomeTrackShelfState extends State<_HomeTrackShelf> {
  final _viewport = GlobalKey(), _cards = <int, GlobalKey>{};
  Rect? _rect(GlobalKey key) {
    final render = key.currentContext?.findRenderObject();
    if (render is! RenderBox || !render.attached || !render.hasSize) {
      return null;
    }
    return render.localToGlobal(Offset.zero) & render.size;
  }

  void reportVisible() {
    if (!widget.isVisible()) return;
    final outer = _rect(widget.rootViewport), inner = _rect(_viewport);
    if (outer == null || inner == null) return;
    final bounds = outer.intersect(inner), visible = <int>[];
    if (bounds.isEmpty) return;
    for (final item in _cards.entries) {
      final rect = _rect(item.value);
      if (rect == null || rect.isEmpty) continue;
      final shown = rect.intersect(bounds);
      if (!shown.isEmpty &&
          shown.width * shown.height >= rect.width * rect.height * .5) {
        visible.add(item.key);
      }
    }
    unawaited(
      widget.owner.reportVisible(
        widget.shelf,
        visible,
        isVisible: widget.isVisible,
      ),
    );
  }

  @override
  void didUpdateWidget(_HomeTrackShelf oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.shelf, widget.shelf)) _cards.clear();
  }

  @override
  Widget build(BuildContext context) {
    final width = MusicShelf.cardWidth(MediaQuery.sizeOf(context).width),
        scale = MediaQuery.textScalerOf(context).scale(16) / 16;
    final textTheme = Theme.of(context).textTheme;
    double textHeight(String text, TextStyle? style, {int? maxLines}) {
      final painter = TextPainter(
        text: TextSpan(text: text, style: style),
        textDirection: Directionality.of(context),
        textScaler: MediaQuery.textScalerOf(context),
        locale: Localizations.maybeLocaleOf(context),
        maxLines: maxLines,
      )..layout(maxWidth: width);
      final height = painter.height;
      painter.dispose();
      return height;
    }

    var height = width + 88 * scale + 4;
    for (final track in widget.shelf.tracks.where((track) => !track.playable)) {
      final requiredHeight =
          width +
          8 +
          textHeight(track.title, textTheme.titleMedium, maxLines: 2) +
          4 +
          textHeight('Запись недоступна', textTheme.bodySmall);
      if (requiredHeight > height) height = requiredHeight;
    }
    return SizedBox(
      key: _viewport,
      height: height,
      child: ListView.separated(
        key: ValueKey('home-shelf-${widget.shelf.id}'),
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 20),
        itemCount: widget.shelf.tracks.length,
        separatorBuilder: (_, _) => const SizedBox(width: 12),
        itemBuilder: (_, i) {
          final track = widget.shelf.tracks[i];
          return SizedBox(
            key: _cards.putIfAbsent(i, GlobalKey.new),
            width: width,
            child: track.playable
                ? MusicCard(
                    width: width,
                    title: track.title,
                    subtitle: track.artist,
                    artwork: track.artwork,
                    onOpen: () => widget.onPlay(i),
                  )
                : Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Artwork(uri: track.artwork),
                      const SizedBox(height: 8),
                      Text(
                        track.title,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: textTheme.titleMedium,
                      ),
                      const SizedBox(height: 4),
                      Text(
                        'Запись недоступна',
                        style: textTheme.bodySmall?.copyWith(
                          color: MusicColors.textSecondary,
                        ),
                      ),
                    ],
                  ),
          );
        },
      ),
    );
  }
}
