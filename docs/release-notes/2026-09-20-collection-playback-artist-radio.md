# Collection playback and artist radio verification

Production services are healthy with zero restarts. The backend-only follow-up preserved all 13 neighboring containers; the 48,700,146-byte PostgreSQL backup passed pg_restore listing. Existing worker startup warnings (Redis XGROUP and listener count), plus transient MusicBrainz HTTP 503 responses, remain outside this release scope and are tracked in Obsidian.

verify: frontend `e1232da3`, API/worker `f67b6a86` выпущены с резервной копией и откатом. Круглые фиолетовые Play/Pause без видимого текста возвращены на страницы музыкальных коллекций; доступны названия для скринридера и состояния загрузки. Пауза/возобновление сохраняют позицию активной коллекции, чужая очередь заменяется явно. Перемешивание и «Ещё» сохранены.

Радио исполнителя использует внешний каталог при отсутствии локальных аудиофайлов. Исправлены маршрутизация внешних артистов, отмена устаревших запросов и подтверждение совместного прослушивания. Найдена дополнительная причина пустого радио 2CELLOS: 28 карточек CATALOG без файлов ошибочно считались локальной музыкой. Фильтр обоих локальных пулов исправлен.

verify: 8 773 backend-теста, 1 747 frontend unit-тестов, 1 417 component-тестов, 34 strict coverage-теста; сборки, typecheck, lint и repository gates пройдены, adversarial review CLEAN. На публичном API оба исполнителя (2CELLOS и Папин Олимпос) проверены по имени и ID: четыре непустые уникальные подборки по 12 треков; аудио Range — 206. В браузере production проверены desktop и 390×844: кнопка 56×56 без текста, горизонтального переполнения нет. Физические телефоны в этом этапе не тестировались.

Ограничения: принадлежность коллекции сохраняется при клиентской навигации, но не после полной перезагрузки браузера; после неё кнопка явно запускает коллекцию. Синхронизация устройств, радио самостоятельных VK/Яндекс-записей и аудит отказов источников остаются будущими задачами. Транспорт воспроизведения и офлайн-хранилище не менялись. Git push не выполнялся.

Откат API/worker: `/srv/music/soundspan-releases/artist-radio-f67b6a86/rollback.sh`; предыдущего полного выпуска: `/srv/music/soundspan-releases/icons-radio-e1232da3/rollback.sh`. Свидетельства: `C:/Users/Dartum/Documents/ChatGPT/soundspan/output/icon-radio-fix/` и `icon-radio-catalog-fix/`.
