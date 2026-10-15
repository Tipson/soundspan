import '../search/catalog_detail_screen.dart';

/// Album composition supplies one owner controller and exact entity reference.
class AlbumScreen extends CatalogDetailScreen {
  const AlbumScreen({
    super.key,
    required super.controller,
    required super.entity,
    super.onPlay,
    super.onOpenArtist,
    super.onOpenAlbum,
    super.actions,
    super.autoLoad,
  });
}
