import { pluralRu } from "./ru";

/** Russian product copy for the interactive Vibe map. */
export const vibeMapRu = {
    trailModes: {
        on: "Вкл.",
        fade: "Затухание",
        off: "Выкл.",
    },
    legend: {
        about: "О карте звучания",
        descriptionStart:
            "Каждая точка — трек. Положение определяется общим звучанием: CLAP-вектор проецируется с помощью UMAP. Похожие треки собираются рядом —",
        descriptionStrong:
            "соседство имеет значение, но дальние расстояния не пропорциональны",
        descriptionEnd:
            ": половина экрана между точками не означает вдвое большую разницу, чем четверть экрана. Проценты в панелях рассчитаны относительно случайных пар из вашей коллекции.",
        moodColors: "Цвета настроений",
        linesAndGlyphs: "Линии и обозначения",
        gestures: "Жесты",
        beacon: "Маяк — сейчас играет",
        trail: "Сплошная затухающая линия — история прослушивания",
        plan: "Пунктир — будущая очередь",
    },
    gestures: {
        click: "Клик",
        travel: "Перейти",
        shiftDrag: "Shift + перетаскивание",
        sweep: "Собрать в очередь",
        ctrlClick: "Ctrl/⌘ + клик",
        alchemy: "Добавить в микс",
        wheelPinch: "Колесо / щипок",
        zoom: "Масштаб",
        back: "Назад",
    },
    controls: {
        zoomIn: "Приблизить",
        zoomOut: "Отдалить",
        resetView: "Сбросить вид",
        cluster: "Собрать: вернуться к естественному расположению точек",
        spread: "Разнести: равномерно распределить плотные скопления",
        clusterLayout: "Собрать точки",
        spreadLayout: "Разнести точки",
        brushArmed:
            "Кисть включена — проведите по точкам, чтобы собрать очередь; нажмите ещё раз, чтобы выключить",
        brush: "Кисть: проведите по точкам, чтобы собрать очередь, или удерживайте Shift при перетаскивании",
        sweepBrush: "Кисть для сбора треков",
        locate: "Найти текущий трек",
        flyToNowPlaying: "Показать текущий трек на карте",
        nowPlayingOffMap: "Текущего трека нет на карте",
        nothingPlaying: "Сейчас ничего не играет",
        startJourney: "Создать маршрут",
        planFromCurrent: "Построить маршрут от текущего трека",
        closeAlchemyFirst: "Сначала закройте микс (Esc)",
        playToStartJourney:
            "Включите трек или выберите его в режиме перехода, чтобы создать маршрут",
        showQueue: "Показать очередь",
        trailDisplay: "Отображение истории",
        trailMode: "Режим отображения истории",
        clearHistory: "Очистить историю",
        saveHistory: "Сохранить историю как плейлист",
        trailSettings: "Настройки истории сеанса",
        fullscreen: "На весь экран",
        enterFullscreen: "Перейти в полноэкранный режим",
        exitFullscreen: "Выйти из полноэкранного режима",
        exitFullscreenEsc: "Выйти из полноэкранного режима (Esc)",
    },
    filters: {
        show: "Показать фильтры",
        title: "Фильтры",
        visible: "видно",
        collapse: "Свернуть фильтры",
        toggleMood:
            "нажмите, чтобы переключить; Shift + клик — оставить только это настроение",
        showAllMoods: "Показать все настроения",
        all: "Все",
        soloHint: "Shift + клик — оставить только одно настроение",
        energy: "Энергия",
        mood: "Настроение",
        calm: "спокойно",
        intense: "интенсивно",
        sad: "грустно",
        happy: "радостно",
        minimum: "минимум",
        maximum: "максимум",
    },
    spotlight: {
        title: "Найти на карте",
        searchFailed: "Поиск не удался — попробуйте ещё раз",
        searchAsVibe: "Искать по звучанию →",
        matches: "Совпадения среди треков и исполнителей",
        placeholder: "Трек, исполнитель или описание звучания…",
        clear: "Очистить (Esc)",
        clearAria: "Очистить поиск по карте",
        warming: "Подготавливаем модель…",
    },
    queue: {
        title: "Очередь",
        close: "Закрыть очередь",
        closeEsc: "Закрыть очередь (Esc)",
        nowPlaying: "Сейчас играет",
        drag: "Перетащить для изменения порядка",
        remove: "Удалить из очереди",
        empty: "Очередь пуста — проведите по точкам или создайте маршрут.",
    },
    journey: {
        title: "Маршрут",
        exit: "Выйти из маршрута (Esc)",
        from: "От",
        destination: "Цель",
        chooseOnMap: "Выберите цель на карте",
        clickDestination: "Нажмите на точку, чтобы выбрать цель…",
        destinationPrefix: "Цель",
        notEnoughMoodTracks:
            "Недостаточно проанализированных треков с таким настроением",
        noEmbedding: "Этот трек ещё не проанализирован",
        buildFailed: "Не удалось построить маршрут",
        steps: "Шаги",
        stepsAria: "Количество шагов маршрута",
        build: "Построить маршрут",
        play: "Включить маршрут",
        save: "Сохранить",
        saveTitle: "Сохранить маршрут как плейлист",
        route: "Маршрут",
        routeTo: "Маршрут к",
        drift: "Двигаться к…",
    },
    travel: {
        title: "Переход",
        exit: "Выйти из перехода (Esc)",
        from: "От",
        directionAria: "Направление перехода",
        any: "Любое",
        happier: "Радостнее",
        sadder: "Грустнее",
        calmer: "Спокойнее",
        energetic: "Энергичнее",
        energy: "Энергия",
        mood: "Настроение",
        groove: "Ритмичность",
        intensity: "Интенсивность",
        match: "совпадение",
        closerThan: "Ближе, чем",
        ofLibrary: "треков в вашей коллекции",
        showWhy: "Показать, почему подходит",
        hideWhy: "Скрыть объяснение совпадения",
        why: "Почему этот трек?",
        onMapHint: "Нажмите, чтобы перейти; Shift + клик — добавить в очередь",
        offMapHint:
            "Трека нет на карте — нажмите для воспроизведения; Shift + клик — добавить в очередь",
        loading: "Ищем близкое звучание…",
        empty: "В этом направлении ничего нет — выберите «Любое».",
        loadFailed: "Не удалось загрузить похожие треки",
    },
    hints: {
        hide: "Скрыть подсказки",
        hideSession: "Скрыть подсказки до конца сеанса",
        brush: "Кисть включена — проведите по точкам, чтобы собрать очередь",
        travel: "Нажмите на светящийся контур, чтобы перейти · Shift + клик — в очередь · Esc — выйти",
        journeyPick: "Нажмите на любую точку, чтобы выбрать цель маршрута",
        journey: "Выберите трек или настроение, затем запустите маршрут",
        alchemy:
            "Нажимайте на точки, чтобы добавить ингредиенты · смешайте от 2 до 10 треков",
        explore:
            "Нажмите на точку для воспроизведения · Shift + клик — в очередь · Ctrl + клик — смешать",
    },
    sweep: {
        play: "Воспроизвести",
        queue: "В очередь",
        save: "Сохранить",
        saveTitle: "Сохранить как плейлист",
        dismiss: "Закрыть подборку",
        dismissEsc: "Закрыть (Esc)",
        max: "максимум",
    },
    alchemy: {
        title: "Микс",
        clearEsc: "Очистить микс (Esc)",
        hint: "Добавляйте треки через Ctrl/⌘ + клик, затем смешайте их.",
        weight: "Вес в миксе",
        remove: "Удалить",
        blend: "Смешать",
        clear: "Очистить",
        results: "Результаты микса",
        play: "Включить микс",
        blendFailed: "Не удалось смешать эти треки",
    },
    save: {
        journey: "Маршрут к",
        sweep: "Подборка на карте",
        history: "История на карте",
        failed: "Не удалось сохранить плейлист",
        trailCleared: "История очищена",
        closeJourneyFirst:
            "Сначала закройте маршрут (Esc), затем создайте микс",
        queued: "Добавлено в очередь",
    },
    map: {
        explore: "Волна",
        map: "Карта",
        currentView: "Текущий режим: карта",
        building:
            "Строим карту звучания — первая загрузка после изменения коллекции может занять несколько минут",
        buildingRetry:
            "Карта ещё строится — попробуйте снова через несколько минут",
        loadFailed: "Не удалось загрузить карту звучания",
        empty: "На карте пока нет проанализированных треков",
        role: "Карта звучания",
        keyboardHint:
            "Используйте стрелки для перехода между треками и Enter для выбора.",
        focused: "Выбран трек",
        notOnMap: "нет на карте",
        findOnMap: "Найти на карте",
        playbackProgress: "Прогресс воспроизведения",
    },
} as const;

const MOOD_LABELS: Readonly<Record<string, string>> = {
    moodHappy: "Радостное",
    moodSad: "Грустное",
    moodRelaxed: "Спокойное",
    moodAggressive: "Агрессивное",
    moodParty: "Для вечеринки",
    moodAcoustic: "Акустическое",
    moodElectronic: "Электронное",
    neutral: "Нейтральное",
};

export function vibeMoodLabel(mood: string): string {
    return MOOD_LABELS[mood] ?? mood.replace(/^mood/, "");
}

export function vibeTrackCount(count: number): string {
    return `${count} ${pluralRu(count, ["трек", "трека", "треков"])}`;
}

export function vibeMapSummary(total: number, shown: number): string {
    return `${vibeMapRu.map.role}: ${vibeTrackCount(total)}, показано ${shown}. ${vibeMapRu.map.keyboardHint}`;
}

export function sweptTracksLabel(count: number, capped: boolean): string {
    return `${vibeTrackCount(count)} выбрано${capped ? ` (${vibeMapRu.sweep.max})` : ""}`;
}

export function savedTracksMessage(
    playlistName: string,
    added: number,
): string {
    const saved = pluralRu(added, ["сохранён", "сохранено", "сохранено"]);
    return `${vibeTrackCount(added)} ${saved} в плейлист «${playlistName}»`;
}

export function partiallySavedTracksMessage(
    playlistName: string,
    added: number,
    failed: number,
): string {
    const total = added + failed;
    return `В плейлист «${playlistName}» сохранено ${added} из ${total} ${pluralRu(total, ["трека", "треков", "треков"])}. Не удалось добавить: ${failed}.`;
}

export function calibratedMatchLabel(percent: number): string {
    if (percent >= 97) return "почти одинаковое звучание";
    if (percent >= 90) return "одно настроение";
    if (percent >= 75) return "очень близкое звучание";
    if (percent >= 50) return "похожее звучание";
    if (percent >= 25) return "есть общие черты";
    return "совсем разное звучание";
}
