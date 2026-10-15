import '../search/catalog_detail_controller.dart';
import 'artist_repository.dart';

final class ArtistController extends CatalogDetailController {
  ArtistController({required ArtistRepository repository})
    : super(
        repository: repository,
        loadDetail: repository.load,
        loadContinuation: repository.more,
      );
}
