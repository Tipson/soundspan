/** Russian copy for the admin cache and enrichment surface. */
export const cacheRu = {
    sectionTitle: "Кэш и автоматизация",
    background: "в фоне",
    processing: "обрабатывается",
    failed: "ошибок",
    loadingStatus: "Загружаем состояние обогащения…",
    loadStatusFailed: "Не удалось загрузить состояние обогащения",
    retry: "Повторить",
    libraryEnrichment: "Обогащение медиатеки",
    complete: "Готово",
    artistLabel: "Метаданные исполнителей",
    artistDescription:
        "Биографии, изображения и похожие исполнители из Last.fm",
    artistResetTitle:
        "Сбросить метаданные исполнителей во всей медиатеке и заново загрузить их в фоне.",
    moodLabel: "Теги настроения",
    moodDescription: "Настроения и характеристики звучания из Last.fm",
    moodResetTitle: "Удалить все теги настроения и заново загрузить их в фоне.",
    audioLabel: "Аудиоанализ",
    audioDescription:
        "BPM, тональность, энергичность и танцевальность из аудиофайлов",
    audioResetTitle:
        "Сбросить аудиоанализ всех треков и повторить его в фоне. Для большой медиатеки это может занять много времени.",
    analyzerUnavailable: "Анализатор сейчас не обнаружен",
    analyzerUnavailableHint:
        "Если сервисы только запустились, подождите около 60 секунд и обновите страницу. В облегчённом режиме это ожидаемо.",
    vibeLabel: "Vibe-эмбеддинги",
    vibeDescription: "Аудиоэмбеддинги CLAP для поиска похожей музыки",
    provider: "Провайдер",
    providerStale: "статус устарел",
    providerReachable: "доступен",
    providerUnreachable: "недоступен",
    migrationAria: "Миграция Vibe-эмбеддингов",
    migrationTitle: "Миграция эмбеддингов",
    targetSpaceFamily: "Целевое семейство пространства:",
    embedded: "готово",
    pending: "ожидает",
    migrationFailed: "ошибок:",
    awaitingCoverage: "Ожидаем данные о покрытии",
    cutoverThreshold: "Порог переключения:",
    vibeResetTitle:
        "Перестроить Vibe-эмбеддинги всех треков в фоне. Для большой медиатеки это может занять несколько часов.",
    vibeSimilarity: "Сходство Vibe",
    resetting: "Сбрасываем…",
    rerun: "Запустить заново",
    syncTitle:
        "Обогатить только новые объекты и объекты с недостающими данными. Можно запускать в любое время; обычно это выполняется быстро.",
    syncing: "Синхронизируем…",
    syncNew: "Синхронизировать новое",
    fullEnrichTitle:
        "Повторно обогатить метаданные всей медиатеки в фоне. Для большой медиатеки это может занять несколько часов.",
    starting: "Запускаем…",
    fullEnrich: "Обогатить всё заново",
    pause: "Пауза",
    resume: "Продолжить",
    stop: "Остановить",
    viewFailures: "Показать ошибки",
    moodBackfillAfterFull:
        "Заполнить группы настроения после полного обогащения",
    rebuildClap: "Перестроить CLAP-эмбеддинги",
    current: "Сейчас:",
    currentItem: "текущего объекта",
    userCacheSize: "Размер пользовательского кэша",
    userCacheDescription: "Максимальный объём офлайн-контента",
    transcodeCacheSize: "Размер кэша транскодирования",
    restartRequired: "Для применения изменений требуется перезапуск сервера",
    autoSync: "Автоматически синхронизировать медиатеку",
    autoSyncDescription: "Автоматически применять изменения медиатеки",
    autoEnrich: "Автоматически обогащать метаданные",
    autoEnrichDescription: "Автоматически дополнять метаданные нового контента",
    fetchSpeed: "Скорость загрузки метаданных",
    fetchSpeedDescription:
        "Параллельные запросы к Last.fm и MusicBrainz за биографиями и тегами настроения. Чем выше значение, тем быстрее работа, но тем вероятнее ограничение частоты запросов.",
    loading: "Загрузка…",
    conservative: "Бережно",
    moderate: "Умеренно",
    balanced: "Сбалансированно",
    fast: "Быстро",
    maximum: "Максимально",
    artistsPerMinute: "исполнителей/мин",
    workerLabel: "Процессы аудиоанализа",
    workerDescription:
        "CPU-процессы для анализа Essentia ML (BPM, тональность, настроение, энергичность). Меньшее значение снижает нагрузку на старых системах.",
    workers: "процессов",
    coresAvailable: "ядер доступно",
    clearing: "Очищаем…",
    clearAllCaches: "Очистить все кэши",
    cleaning: "Очищаем…",
    cleanupStaleJobs: "Удалить зависшие задания",
    retrying: "Повторяем…",
    retryFailedAnalysis: "Повторить неудачный анализ",
    backfilling: "Заполняем…",
    backfillMoodBuckets: "Заполнить группы настроения",
    retryResult: "Возвращено в очередь треков:",
    moodBackfillComplete: "Группы настроения заполнены:",
    processed: "обработано",
    assigned: "назначено",
    cleaned: "Удалено:",
    batches: "пакетов",
    downloads: "загрузок",
    imports: "импортов",
    queueJobs: "заданий очереди",
    noStaleJobs: "Зависших заданий не найдено",
    confirmTitle: "Обогатить всю медиатеку заново?",
    confirmMessage:
        "Метаданные каждого исполнителя и трека будут повторно обработаны в фоне. Если ниже включены соответствующие параметры, Vibe-эмбеддинги и группы настроения тоже перестроятся. Для большой медиатеки это может занять несколько часов, но воспроизведение продолжит работать.",
    syncFailed: "Не удалось запустить синхронизацию",
    fullEnrichFailed: "Не удалось запустить полное обогащение",
    moodBackfillFailed: "Не удалось заполнить группы настроения",
    artistResetFailed: "Не удалось сбросить метаданные исполнителей",
    moodResetFailed: "Не удалось сбросить теги настроения",
    audioResetFailed: "Не удалось сбросить аудиоанализ",
    vibeResetFailed: "Не удалось сбросить Vibe-эмбеддинги",
    clearCachesFailed: "Не удалось очистить кэши",
    cleanupFailed: "Не удалось удалить зависшие задания",
    retryAnalysisFailed: "Не удалось повторить анализ",
    pauseFailed: "Не удалось приостановить обогащение",
    resumeFailed: "Не удалось продолжить обогащение",
    stopFailed: "Не удалось остановить обогащение",
} as const satisfies Record<string, string>;

export function formatBackgroundAnalysisLabel(input: {
    audioBusy: boolean;
    vibeBusy: boolean;
}): string {
    if (input.audioBusy && input.vibeBusy) {
        return "Выполняются аудиоанализ и построение Vibe-эмбеддингов";
    }
    if (input.vibeBusy) return "Строятся Vibe-эмбеддинги";
    return "Выполняется аудиоанализ";
}

export function formatEnrichmentState(input: {
    status: "running" | "paused" | "stopping" | string;
    phase?: string | null;
    currentItem?: string | null;
}): string {
    if (input.status === "paused") return "Обогащение приостановлено";
    if (input.status === "stopping") {
        return `Останавливаемся после текущего объекта: ${input.currentItem || cacheRu.currentItem}`;
    }
    const phase =
        input.phase === "artists"
            ? "исполнителей"
            : input.phase === "tracks"
              ? "треков"
              : input.phase || "медиатеки";
    return `Обрабатываем ${phase}…`;
}

export function formatFetchSpeed(speed: number): string {
    if (speed === 1) return cacheRu.conservative;
    if (speed === 2) return cacheRu.moderate;
    if (speed === 3) return cacheRu.balanced;
    if (speed === 4) return cacheRu.fast;
    return cacheRu.maximum;
}
