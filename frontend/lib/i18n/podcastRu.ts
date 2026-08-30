import { pluralRu } from "./ru";

export const podcastRu = {
    main: {
        title: "Подкасты",
        subtitle: "Подписывайтесь на любимые шоу и слушайте их выпуски.",
        quickAdd: "Найти и добавить…",
        fallbackAlt: "Подкаст",
        rssPlaceholder: "Добавить по RSS-ссылке…",
        rssAdding: "Добавляем…",
        addRss: "Добавить RSS",
        example: "Пример:",
        myPodcasts: "Мои подкасты",
        sortTitle: "По названию (А–Я)",
        sortAuthor: "По автору (А–Я)",
        sortEpisodes: "Больше выпусков",
        firstPage: "В начало",
        previousPage: "Назад",
        nextPage: "Вперёд",
        lastPage: "В конец",
        topPodcasts: "Популярные подкасты",
        loadingDiscovery: "Загружаем рекомендации",
        viewMore: "Показать ещё",
        emptyTitle: "Найдите подкасты",
        emptyDescription:
            "Найдите подкаст выше, подпишитесь и начните слушать.",
        peerPodcasts: "С других серверов",
        subscribed: "Вы подписаны",
        subscribe: "Подписаться",
        genres: {
            comedy: "Комедии",
            society: "Общество и культура",
            news: "Новости",
            trueCrime: "Настоящие преступления",
            business: "Бизнес",
            sports: "Спорт",
            leisure: "Досуг",
        },
    },
    detail: {
        notFound: "Подкаст не найден",
        type: "Подкаст",
        subscribing: "Подписываемся…",
        subscribe: "Подписаться",
        rssFeed: "RSS-лента",
        remove: "Удалить",
        removeQuestion: "Удалить подкаст?",
        confirm: "Подтвердить",
        cancel: "Отмена",
        continueListening: "Продолжить слушать",
        previousEpisode: "Предыдущий выпуск",
        nextEpisode: "Следующий выпуск",
        allEpisodes: "Все выпуски",
        newestFirst: "Сначала новые",
        oldestFirst: "Сначала старые",
        finished: "Прослушано",
        markComplete: "Отметить прослушанным",
        episodeActions: "Действия с выпуском",
        playNext: "Воспроизвести следующим",
        addToQueue: "Добавить в очередь",
        latestEpisodes: "Последние выпуски",
        unlockEpisodes: "Подписаться и открыть все выпуски",
        previewEmpty: "Нет выпусков для предпросмотра.",
        about: "О подкасте",
        similar: "Похожее слушают",
    },
    errors: {
        rssRequired: "Введите ссылку на RSS-ленту",
        rssProtocol: "RSS-ссылка должна начинаться с http:// или https://",
        rssInvalid: "Введите корректную ссылку на RSS-ленту",
        rssSubscribeFailed: "Не удалось подписаться по RSS-ленте",
        subscribeFailed: "Не удалось подписаться на подкаст",
    },
    success: {
        subscribed: "Вы подписались на подкаст",
    },
} as const;

function countRu(
    count: number,
    forms: readonly [one: string, few: string, many: string],
): string {
    return `${count} ${pluralRu(count, forms)}`;
}

export function formatPodcastCountRu(count: number): string {
    return countRu(count, ["подкаст", "подкаста", "подкастов"]);
}

export function formatEpisodeCountRu(count: number): string {
    return countRu(count, ["выпуск", "выпуска", "выпусков"]);
}

export function formatInProgressRu(count: number): string {
    return `${count} в процессе`;
}

export function formatPodcastDurationRu(seconds: number): string {
    if (Number.isNaN(seconds) || !Number.isFinite(seconds) || seconds < 0) {
        return "0 мин";
    }
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0 && minutes > 0) return `${hours} ч ${minutes} мин`;
    if (hours > 0) return `${hours} ч`;
    return `${minutes} мин`;
}

export function formatPodcastDateRu(dateInput: string | number | Date): string {
    const date = new Date(dateInput);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString("ru-RU", {
        year: "numeric",
        month: "short",
        day: "numeric",
    });
}

export function formatPageRu(current: number, total: number): string {
    return `Страница ${current} из ${total}`;
}

export function formatPerPageRu(count: number): string {
    return `${count} на странице`;
}

export function formatPodcastSearchEmptyRu(query: string): string {
    return `По запросу «${query}» подкасты не найдены`;
}

export function formatPodcastSubscribedRu(title: string): string {
    return `Вы подписались на «${title}»`;
}

export function formatSeasonRu(season: number): string {
    return `Сезон ${season}`;
}

export function formatEpisodeNumberRu(episode: number): string {
    return `Выпуск ${episode}`;
}
