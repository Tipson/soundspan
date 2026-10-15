# Soundspan Mobile

Музыкальный клиент на Flutter с общей основой интерфейса и логики для Android и iOS. Целевая платформа APK — Android 7.0 и новее. Проект iOS требует отдельной сборки и проверки на macOS; успешная Android-сборка не подтверждает готовность iPhone.

В приложении есть Главная, Волна, персональные миксы, поиск, исполнители и альбомы, Любимое, плейлисты и импорт, очередь, текст песни, радио, загрузки устройства и настройки аккаунта. Книги, подкасты, совместное прослушивание и управление другим устройством не входят в мобильный клиент. Доступность музыки и серверных возможностей зависит от подключённого сервера.

## Разработка

Используются Flutter 3.47.7, Dart 3.13.5 и JDK 21. Версии зависимостей закреплены в `pubspec.lock`. Android: minSdk 24, compile/target SDK 36. Настройте SDK и каталоги кэшей до запуска Flutter; локальное окружение владельца хранит изменяемые данные на D и сериализует сборки через `Invoke-MobileGate`.

`scripts/mobile/verify-mobile.ps1` из корня репозитория проверяет закреплённое окружение и последовательно выполняет из `mobile`: `flutter pub get --enforce-lockfile`, `dart format --output=none --set-exit-if-changed lib test integration_test`, `flutter analyze` и полный `flutter test`. Укажите `-ToolEnvironment` и его проверенный SHA256 в `-ToolEnvironmentSha256`; локальные пути владельца ограничены D. Форматирование проверяется без изменения файлов, первая ошибка останавливает последующие команды. Установленные Android-сценарии находятся в `integration_test`; они требуют отдельного запуска на устройстве или эмуляторе. Синтетические данные и тестовый TLS используются только соответствующими тестовыми точками входа. Обычный `lib/main.dart` открывает подключённый сервер, по умолчанию `https://music.agentik007.ru`.

Один процесс владеет плеером; экраны отправляют ему команды. Android broker координирует сеансы интерфейса и фоновых загрузок. Очередь, индекс файлов и доступ к готовой музыке ограничены исходным аккаунтом и эпохой сеанса. Файлы телефона отличаются от серверных заданий загрузки.

## APK и подпись

`scripts/mobile/build-release.ps1` из корня репозитория выполняет проверку закреплённого окружения и чистого коммита, общий `verify-mobile.ps1`, release-сборку и проверку APK. Полный набор тестов выполняется один раз. Скрипт настроен на локальные пути владельца; параметры описаны в его `param`-блоке. `verify-apk.ps1` отдельно проверяет подпись, manifest, разрешения и библиотеки трёх Android ABI. Подпись, успешная установка и проверка воспроизведения на физическом телефоне — отдельные результаты.

Ключ и сведения подписи хранятся вне репозитория. Для обновления установленного приложения сохраняйте тот же ключ и увеличивайте номер сборки. Debug APK и тестовая точка входа не заменяют release APK.

## English

Soundspan is a Flutter music client with shared Android/iOS UI and domain code. Android APK targets Android 7.0 or later. iOS needs a separate macOS build, platform integration and device acceptance.

Use Flutter 3.47.7, Dart 3.13.5 and JDK 21. Dependencies are pinned by `pubspec.lock`; Android compile/target SDK is 36 and minSdk is 24. From the repository root, `scripts/mobile/verify-mobile.ps1` accepts `-ToolEnvironment` and its verified digest as `-ToolEnvironmentSha256`. It validates the owner's D-only mutable paths and pinned SDK, then runs from `mobile`: `flutter pub get --enforce-lockfile`, `dart format --output=none --set-exit-if-changed lib test integration_test`, `flutter analyze` and the complete `flutter test` suite. Formatting does not write source files; the first failure stops later tools. Native device scenarios in `integration_test` run separately. Configure SDK/cache paths first; the owner's local environment serializes builds with `Invoke-MobileGate`.

The client includes Home, Wave, mixes, search, music details, likes, playlists/imports, player/queue, lyrics, radio, private device downloads and account settings. Books, podcasts, shared listening and cross-device playback control are excluded. Server capabilities determine available features. One process owns playback; persisted queue/files remain fenced to the original account/session. Test fixtures do not replace the normal server-backed application entry point.

The owner's `scripts/mobile/build-release.ps1` validates pinned inputs and a clean source commit, calls `verify-mobile.ps1` once, then builds and verifies a signed APK. `verify-apk.ps1` checks the APK separately. Keep signing materials outside Git and preserve the signing key for updates. A build, successful installation and physical-device playback acceptance are distinct checks.
