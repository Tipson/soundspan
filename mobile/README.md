# Soundspan Mobile

Музыкальный клиент на Flutter с общей основой интерфейса и логики для Android и iOS. Целевая платформа APK — Android 7.0 и новее. Проект iOS требует отдельной сборки и проверки на macOS; успешная Android-сборка не подтверждает готовность iPhone.

В приложении есть Главная, Волна, персональные миксы, поиск, исполнители и альбомы, Любимое, плейлисты и импорт, очередь, текст песни, радио, загрузки устройства и настройки аккаунта. Книги, подкасты, совместное прослушивание и управление другим устройством не входят в мобильный клиент. Доступность музыки и серверных возможностей зависит от подключённого сервера.

После первого открытия Soundspan удерживайте его значок в совместимом лаунчере Android 7.1 или новее. «Включить мою волну» сразу запускает Волну или продолжает уже начатую. «Продолжить слушать» возобновляет текущую очередь с сохранённой позиции. «Загрузки» открывают раздел скачанных треков.

При сетевом воспроизведении трека с опубликованной полной версией приложение выбирает её по умолчанию. В меню полного плеера можно выбрать «Стандартная версия» или «Без цензуры». Переключение начинает текущий трек с начала, сохраняя очередь. Выбор относится к текущей записи в очереди. Загрузки сохраняют стандартные копии.

Администратор может открыть «Заменить аудио» в меню трека в каталоге или полном плеере. Приложение принимает MP3 до 16 МиБ из системного выбора файлов и сохраняет его серверным черновиком. «Опубликовать для всех» применяет полную версию, а «Снять с публикации» возвращает стандартную. Прослушать черновик можно в веб-версии. Для этих действий сервер должен поддерживать API полных версий.

## Разработка

Используются Flutter 3.47.7, Dart 3.13.5 и JDK 21. Версии зависимостей закреплены в `pubspec.lock`. Android: minSdk 24, compile/target SDK 36. Настройте SDK и каталоги кэшей до запуска Flutter; локальное окружение владельца хранит изменяемые данные на D и сериализует сборки через `Invoke-MobileGate`.

`scripts/mobile/verify-mobile.ps1` из корня репозитория проверяет закреплённое окружение и последовательно выполняет из `mobile`: `flutter pub get --enforce-lockfile`, `dart format --output=none --set-exit-if-changed lib test integration_test`, `flutter analyze` и полный `flutter test`. Укажите `-ToolEnvironment` и его проверенный SHA256 в `-ToolEnvironmentSha256`; локальные пути владельца ограничены D. Форматирование проверяется без изменения файлов, первая ошибка останавливает последующие команды. Установленные Android-сценарии находятся в `integration_test`; они требуют отдельного запуска на устройстве или эмуляторе. Синтетические данные и тестовый TLS используются только соответствующими тестовыми точками входа. Обычный `lib/main.dart` открывает подключённый сервер, по умолчанию `https://music.agentik007.ru`.

Один процесс владеет плеером; экраны отправляют ему команды. Android broker координирует сеансы интерфейса и фоновых загрузок. Очередь, индекс файлов и доступ к готовой музыке ограничены исходным аккаунтом и эпохой сеанса. Файлы телефона отличаются от серверных заданий загрузки.

Android-модуль `audio_service` закреплён в `android/vendor/audio_service` с лицензией и исходными хешами. Он освобождает CPU wake lock при паузе независимо от foreground-статуса: служба сохраняет возможность возобновить музыку после временной потери аудиофокуса. `settings.gradle.kts` проверяет исходный native-хеш до подключения локального модуля. Общий pub-кэш и закреплённый Dart/iOS API не изменяются.

Подготовка источника и загрузка декодера ограничены общим сроком; отказ запуска сохраняет очередь и доступную повторную попытку. Во время воспроизведения служба прогревает только следующую запись небольшим аудиофрагментом. Второй декодер не создаётся, событие прослушивания не отправляется; пауза, смена очереди, аккаунта или сетевого режима отменяют спекулятивную работу. Проверенная загруженная запись не требует прогрева по сети.

## APK и подпись

Сценарии с отдельными broker/worker entrypoint запускайте через `flutter drive --driver=test_driver/integration_test.dart --target=integration_test/native_owner_protected_test.dart -d <device>`. `flutter test integration_test/...` создаёт обёртку главной библиотеки, поэтому поиск отдельной точки входа фонового движка по имени может не сработать; это отличается от запуска обычного APK.

`scripts/mobile/build-release.ps1` из корня репозитория выполняет проверку закреплённого окружения и чистого коммита, общий `verify-mobile.ps1`, release-сборку и проверку APK. Полный набор тестов выполняется один раз. Скрипт настроен на локальные пути владельца; параметры описаны в его `param`-блоке. `verify-apk.ps1` отдельно проверяет подпись, manifest, разрешения и библиотеки трёх Android ABI. Подпись, успешная установка и проверка воспроизведения на физическом телефоне — отдельные результаты.

Ключ и сведения подписи хранятся вне репозитория. Для обновления установленного приложения сохраняйте тот же ключ и увеличивайте номер сборки. Debug APK и тестовая точка входа не заменяют release APK.

## English

Use `flutter drive --driver=test_driver/integration_test.dart --target=integration_test/native_owner_protected_test.dart -d <device>` for scenarios with broker/worker entrypoints. The `flutter test integration_test/...` wrapper changes the root library and can prevent a background engine from finding a named entrypoint. This differs from launching the normal APK.

Source preparation and decoder loading share a deadline; a failed start retains the queue and a retry action. During playback the service warms only the upcoming recording using a bounded audio prefix. This creates neither a second decoder nor a listening-history event. Pause, queue replacement, account and network changes cancel speculative work. Verified downloaded recordings do not need network warmup.

Soundspan is a Flutter music client with shared Android/iOS UI and domain code. Android APK targets Android 7.0 or later. iOS needs a separate macOS build, platform integration and device acceptance.

Use Flutter 3.47.7, Dart 3.13.5 and JDK 21. Dependencies are pinned by `pubspec.lock`; Android compile/target SDK is 36 and minSdk is 24. From the repository root, `scripts/mobile/verify-mobile.ps1` accepts `-ToolEnvironment` and its verified digest as `-ToolEnvironmentSha256`. It validates the owner's D-only mutable paths and pinned SDK, then runs from `mobile`: `flutter pub get --enforce-lockfile`, `dart format --output=none --set-exit-if-changed lib test integration_test`, `flutter analyze` and the complete `flutter test` suite. Formatting does not write source files; the first failure stops later tools. Native device scenarios in `integration_test` run separately. Configure SDK/cache paths first; the owner's local environment serializes builds with `Invoke-MobileGate`.

The client includes Home, Wave, mixes, search, music details, likes, playlists/imports, player/queue, lyrics, radio, private device downloads and account settings. Books, podcasts, shared listening and cross-device playback control are excluded. Server capabilities determine available features. One process owns playback; persisted queue/files remain fenced to the original account/session. Test fixtures do not replace the normal server-backed application entry point.

The Android `audio_service` module is pinned in `android/vendor/audio_service` with its license and upstream hashes. It releases the CPU wake lock on pause independently of foreground status, allowing background playback to resume after a temporary audio-focus interruption. `settings.gradle.kts` checks the original native hash before selecting this local module. The shared pub cache and pinned Dart/iOS API remain unchanged.

The owner's `scripts/mobile/build-release.ps1` validates pinned inputs and a clean source commit, calls `verify-mobile.ps1` once, then builds and verifies a signed APK. `verify-apk.ps1` checks the APK separately. Keep signing materials outside Git and preserve the signing key for updates. A build, successful installation and physical-device playback acceptance are distinct checks.
