# Подключение разработчика

## Репозиторий и вход

Рабочий репозиторий — [Tipson/soundspan](https://github.com/Tipson/soundspan). Оригинальный `soundspan/soundspan` — другой проект. В командах `gh` явно указывать `--repo Tipson/soundspan`, особенно если настроен upstream.

Для работы с записью требуется принятое collaborator invitation; публичное чтение само по себе не подтверждает право push. Использовать собственный GitHub-аккаунт, свою копию репозитория и свой тестовый аккаунт приложения.

```powershell
gh auth login
gh auth status
git clone https://github.com/Tipson/soundspan.git
cd soundspan
git remote -v
git fetch origin
git switch -c codex/agentik-007-task origin/dev
```

Имя участника и задачи в ветке — пример; выбрать своё. Первую задачу и затрагиваемые файлы согласовать с владельцем. Начальный контекст — [README](README.md), [STATE](STATE.md), [DECISIONS](DECISIONS.md) и [WORKFLOW](WORKFLOW.md).

## Локальная среда

Требования и точный порядок установки находятся в [AGENTS](../../AGENTS.md), а команды локальных портов — в [TESTING](../TESTING.md). Node и Flutter versions берутся из зафиксированных manifest/README, не из скопированного SDK владельца.

```powershell
npm run setup:ci
docker compose -f docker-compose.local.yml up -d postgres-local redis-local
```

Корневой `npm install` не заменяет установку отдельных packages: сначала собирается общий контракт, затем backend/frontend. Для host-run окружения PostgreSQL доступен на порту 5433, Redis — 6380, API/Frontend обычно проверяются на 3007/3031. Они отличаются от внутренних Compose ports.

В новом клоне скопировать `.env.example` в `backend/.env`, задать собственные локальные параметры и три независимых значения `SESSION_SECRET`, `SETTINGS_ENCRYPTION_KEY`, `INTERNAL_API_SECRET`. Существующий `.env` сохранять. Указать абсолютный `MUSIC_PATH` к своей папке. На Windows при работе с локальным аудио нужен корректный `FFMPEG_PATH` к установленному ffmpeg.

Онлайн-воспроизведение требует отдельно настроенных музыкальных сервисов. Запуск только PostgreSQL/Redis не включает внешние источники. Полный вариант запуска находится в [README](../../README.md) и [DEPLOYMENT](../DEPLOYMENT.md).

## Мобильный клиент

Начать с [mobile/README](../../mobile/README.md). Lockfile и закреплённые native dependencies сохраняются; scripts release-проверок владельца используют его проверенные локальные пути и не являются универсальным установщиком SDK.

```powershell
cd mobile
flutter pub get --enforce-lockfile
dart format --output=none --set-exit-if-changed lib test integration_test
flutter analyze
flutter test
```

Останавливаться на первой ошибке. Для экспериментов проверять выбранный сервер и использовать свой тестовый аккаунт. Ключ подписи release APK и production tokens не входят в доступ к Git. Сборка iOS и реальные device scenarios выполняются отдельно.

## Передача результата

Один небольшой PR описывает проблему, изменение, проверочные команды и ограничения. Для UI нужны mobile/desktop состояния; для плеера — фактический сценарий, а не только зелёный build. Правила полноты проверки остаются в [AGENTS](../../AGENTS.md).

При сомнении в API библиотеки сверяться с текущей официальной документацией и доступным Context7. Проверка документации не требует установки всех SDK или повторного запуска приложения без изменения runtime.
