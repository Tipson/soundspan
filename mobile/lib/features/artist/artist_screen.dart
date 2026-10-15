import '../search/catalog_detail_screen.dart';

/// Artist composition supplies one owner controller and exact entity reference.
class ArtistScreen extends CatalogDetailScreen {
  const ArtistScreen({
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
