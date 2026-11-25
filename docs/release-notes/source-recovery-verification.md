# Проверка источников и доверия прокси

## Выпуск 24 ноября 2026

Source: `0ef3b2e57ec575d8ee1935f8def598e3c896bdad`, merge [PR 7](https://github.com/Tipson/soundspan/pull/7); исходный проверенный коммит `2bb05776143d43967bd88f390df4595b0ac08dea`. Это историческая запись проверки конкретного пакета, не текущий health endpoint.

Обновлены полные CI-образы API и worker, ytmusic пересоздан с изменённым окружением. Frontend, analyzer и DCLAP сохранили свои контейнеры и образы. Prisma tree из 136 файлов совпал; схема не менялась. Сети, mounts, env и host limits проверены. Другие контейнеры и общий VPN не менялись.

## Изменения

- Для проблемных GoogleVideo CDN вместо неработавшего прямого HTTP/3 media path выбран проверенный отдельный маршрут Soundspan. URL extraction и IP-bound media используют один egress. `YTMUSIC_CDN_HTTP3=0`, публичный каталог сохраняет `YTMUSIC_METADATA_HTTP3=1`.
- Runtime Express использует proxy-addr 2.0.8. Missing/invalid hop config не включает trust-all. Для проверенной публичной цепочки выбран `TRUST_PROXY_HOPS=1`: frontend/httpxy сохраняет существующий XFF. Настройка 2 отвергнута actual-proxy проверкой. Изменение левого подложного префикса сохранило IP/bucket и получило 429.
- MusicBrainz ECONNRESET включает общий Redis cooldown API/worker; поддерживаются seconds/date Retry-After. Сам общий outer limiter не получил сквозного lookup deadline.

## verify

- Linux CI: 10481 passed, 9 skipped, 0 failed; 714 suites. Coverage lines 94.35%, branches 84.11%, functions 93.11%, statements 93.09%. Quality, Core Journeys, Security, CodeQL и image build успешны.
- Локальный Windows full coverage имел 122 failures, включая POSIX-пути, OpenSSL tooling и timeout. Этот прогон не заявляется зелёным; поддерживаемый Linux CI приведён отдельно.
- Настоящий сайт, свой QA, muted Chrome, без HTTP interception: ранее недоступный `PI-T-aFHwrs` заиграл. От клика до наблюдения прогресса прошло 5.428 с. Настоящее ended переключило на `sbygyYTKzVE`, который играл до 15.006 с, paused=false, readyState 4. Временный private playlist удалён.
- Полный файл через production audio endpoint: HTTP 200, 3657531 байт, FFmpeg decode 0; SHA256 `b919ae4d33a5c12bf2466f273ca34462344018044d39ae74bc6a0c336229e0fe`. Замер 0.293 с использовал подготовленный файл и не считается холодным запуском.
- Волна: HTTP 200, 12 треков за 2.191 с. Публичное radio: 25 треков за 1.632 с. MusicBrainz: HTTP 200 с правильной identity. Runtime dependency/hops подтверждены.
- Все 6 сервисов healthy/restart 0. В коротком финальном наблюдении трёх обновлённых сервисов не найдено прежних HTTP3 media timeout/ECONNRESET markers. Длительная стабильность не заявляется.

## Ограничения

Телефоны, Bluetooth, многосуточный фон и новая APK этим пакетом не принимались. Полный audio-file не равен приёмке всей download queue или PWA cold offline. Первый postflight MusicBrainz не выполнил postcondition, последующие ответы 200 подтверждены; отдельный 503 наблюдался в предварительной пробе. Первый QA-Wave ответ без треков затем сменился выдачей 12 треков; точная причина не устанавливалась.

Private LAN shortcut остаётся отдельной границей: numeric hops не заменяет ограничение ingress. Прочие dependency advisories и outer Retry-After wait этим пакетом полностью не устранялись. Приватные конфигурации, env snapshots и сырые логи не опубликованы.

Доказательства исходного пакета: `quality-ci.json`, `image-build-ci.json`, `deployment.json`, `schema-proof.json`, `site-autonext.json`, `api-and-downloads.json`, `catalog-proof.json`, `postflight.json` и `final-health.json` в архиве владельца. Здесь сохранён обезличенный результат; оригинальные приватные артефакты запрашиваются под конкретную задачу.
