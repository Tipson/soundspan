import '../search/catalog_detail_controller.dart';
import 'album_repository.dart';

final class AlbumController extends CatalogDetailController {
  AlbumController({required AlbumRepository repository})
    : super(repository: repository, loadDetail: repository.load);
}
