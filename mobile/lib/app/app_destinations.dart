import 'package:flutter/material.dart';

enum AppTab {
  home('Главная', Icons.home_outlined, Icons.home_rounded),
  wave('Волна', Icons.graphic_eq_rounded, Icons.graphic_eq_rounded),
  search('Поиск', Icons.search_rounded, Icons.search_rounded),
  library(
    'Моя музыка',
    Icons.library_music_outlined,
    Icons.library_music_rounded,
  ),
  downloads('Загрузки', Icons.download_outlined, Icons.download_rounded);

  const AppTab(this.label, this.icon, this.selectedIcon);
  final String label;
  final IconData icon;
  final IconData selectedIcon;
}

enum AppRouteKind {
  album,
  artist,
  playlist,
  mix,
  liked,
  history,
  account,
  settings,
  taste,
  importPlaylist,
  queue,
  player,
  lyrics,
  related,
  radio,
  shares,
  inbox,
  downloads,
}

/// Typed UI destination. IDs are exact domain identities, never display titles.
@immutable
class AppDestination {
  const AppDestination(this.kind, {this.id});
  final AppRouteKind kind;
  final String? id;
}

/// Hide unsupported entry points and reject disabled deep links consistently.
@immutable
class AppCapabilities {
  const AppCapabilities({
    this.downloads = true,
    this.importPlaylist = true,
    this.account = true,
    this.lyrics = true,
    this.related = true,
  });
  final bool downloads;
  final bool importPlaylist;
  final bool account;
  final bool lyrics;
  final bool related;
  bool allowsTab(AppTab tab) => tab != AppTab.downloads || downloads;
  bool allows(AppDestination destination) => switch (destination.kind) {
    AppRouteKind.downloads => downloads,
    AppRouteKind.importPlaylist => importPlaylist,
    AppRouteKind.account ||
    AppRouteKind.settings ||
    AppRouteKind.taste => account,
    AppRouteKind.lyrics => lyrics,
    AppRouteKind.related => related,
    _ => true,
  };
}

typedef AppDestinationBuilder = Widget Function(
  BuildContext context,
  AppDestination destination,
);
