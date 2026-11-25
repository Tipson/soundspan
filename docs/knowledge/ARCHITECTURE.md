# Карта проекта

Эта карта помогает найти владельца изменения; подробная топология и модели остаются в [основной архитектуре](../ARCHITECTURE.md) и [модели данных](../DATA_MODEL.md).

| Область          | Где читать                                                                   | Ответственность                                                 |
| ---------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Web              | [frontend/features](../../frontend/features/README.md)                       | Пользовательские сценарии и состояние экранов                   |
| API boundary web | [frontend/lib/api.ts](../../frontend/lib/api.ts)                             | Общение компонентов с сервером через общую границу              |
| HTTP API         | [backend routes](../../backend/src/routes/README.md)                         | Авторизация, валидация, API-контракты                           |
| Доменные сервисы | [backend services](../../backend/src/services/README.md)                     | Источники, identity, рекомендации, коллекция и обработка данных |
| Workers          | [backend/src/workers](../../backend/src/workers)                             | Фоновые задачи и orchestration                                  |
| Общий контракт   | [media-metadata-contract](../../packages/media-metadata-contract)            | Типы и границы общих медиа-данных                               |
| YouTube          | [ytmusic-streamer](../../services/ytmusic-streamer)                          | Каталог, extraction и поток аудио                               |
| Аудиоанализ      | [audio-analyzer](../../services/audio-analyzer/README.md)                    | Анализ доступного аудио                                         |
| Embeddings       | [vibe-provider-dclap](../../services/vibe-provider-dclap)                    | Вычисления в зафиксированном пространстве модели                |
| Flutter          | [mobile/README](../../mobile/README.md)                                      | Native lifecycle, плеер, account scope и локальные загрузки     |
| Проверки         | [TESTING](../TESTING.md), [TEST_MATRIX](../TEST_MATRIX.md)                   | Реальные команды, области и границы проверки                    |
| Развёртывание    | [DEPLOYMENT](../DEPLOYMENT.md), [env reference](../ENVIRONMENT_VARIABLES.md) | Конфигурация конкретной топологии и выпуска                     |

## Важные границы

- Web, worker и APK могут работать на разных версиях. Сквозное изменение не заканчивается исправлением одного клиента.
- Политика аккаунта и identity проверяются на сервере и в соответствующем клиенте. UI не создаёт права владения файлом или записью.
- Публичный каталог и private-account операции отличаются по области credentials и транспорта.
- Получение URL, начало аудио, полное скачивание, запись прослушивания и доставка внешнего scrobble — отдельные операции. Не переносить гарантию одного шага на всю цепочку.
- Файлы устройства отличаются от серверных download jobs. Чистая очередь и выход из аккаунта не дают права удалять общие данные вне соответствующего owner scope.
- Machine-specific SDK, runtime caches, секреты и production profiles не являются частью общей базы знаний.

При расхождении этой карты с кодом сначала прочитать фактический модуль и его callers, затем исправить карту в PR вместе с изменением.
