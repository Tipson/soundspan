/** Real, broad genre labels used as zero-network onboarding suggestions. */
export const SUGGESTED_GENRES = [
    "Рок",
    "Альтернативный рок",
    "Метал",
    "Поп",
    "Хип-хоп",
    "Электроника",
    "Инди",
    "Классика",
    "Джаз",
    "Саундтреки",
] as const;

/** Diverse defaults shown until the listener chooses genres. */
export const SUGGESTED_ARTISTS = [
    "Linkin Park",
    "The Weeknd",
    "Kendrick Lamar",
    "Daft Punk",
    "Земфира",
    "Billie Eilish",
    "Молчат Дома",
    "Miles Davis",
    "Hans Zimmer",
    "Ludovico Einaudi",
] as const;

type SuggestedGenre = (typeof SUGGESTED_GENRES)[number];

const ARTISTS_BY_GENRE: Record<SuggestedGenre, readonly string[]> = {
    Рок: ["Linkin Park", "Muse", "Кино", "Foo Fighters", "Queen"],
    "Альтернативный рок": [
        "Radiohead",
        "Linkin Park",
        "Muse",
        "Paramore",
        "Arctic Monkeys",
    ],
    Метал: [
        "Rammstein",
        "Bring Me The Horizon",
        "Metallica",
        "Architects",
        "Spiritbox",
    ],
    Поп: ["Dua Lipa", "The Weeknd", "Billie Eilish", "Taylor Swift", "Zivert"],
    "Хип-хоп": [
        "Kendrick Lamar",
        "Travis Scott",
        "Noize MC",
        "Oxxxymiron",
        "A$AP Rocky",
    ],
    Электроника: [
        "Daft Punk",
        "The Prodigy",
        "Röyksopp",
        "Moderat",
        "Disclosure",
    ],
    Инди: [
        "Tame Impala",
        "Молчат Дома",
        "Florence + The Machine",
        "The xx",
        "Земфира",
    ],
    Классика: [
        "Ludovico Einaudi",
        "Max Richter",
        "Ólafur Arnalds",
        "Claude Debussy",
        "Pyotr Ilyich Tchaikovsky",
    ],
    Джаз: [
        "Miles Davis",
        "John Coltrane",
        "Ella Fitzgerald",
        "Chet Baker",
        "Nina Simone",
    ],
    Саундтреки: [
        "Hans Zimmer",
        "Ramin Djawadi",
        "Joe Hisaishi",
        "Howard Shore",
        "Hildur Guðnadóttir",
    ],
};

const ARTISTS_BY_GENRE_KEY = new Map(
    Object.entries(ARTISTS_BY_GENRE).map(([genre, artists]) => [
        genre.toLocaleLowerCase("ru-RU"),
        artists,
    ]),
);

/**
 * Build a balanced, genre-aware artist shelf. Round-robin ordering prevents
 * the first selected genre from occupying every visible slot.
 */
export function suggestArtistsForGenres(
    genres: readonly string[],
    limit: number = 12,
): string[] {
    const safeLimit = Math.max(0, Math.floor(limit));
    if (safeLimit === 0) return [];
    const groups = genres
        .map((genre) =>
            ARTISTS_BY_GENRE_KEY.get(genre.trim().toLocaleLowerCase("ru-RU")),
        )
        .filter((artists): artists is readonly string[] => Boolean(artists));
    if (groups.length === 0) return [...SUGGESTED_ARTISTS].slice(0, safeLimit);

    const suggestions: string[] = [];
    const seen = new Set<string>();
    const groupSize = Math.max(...groups.map((artists) => artists.length));
    for (let artistIndex = 0; artistIndex < groupSize; artistIndex += 1) {
        for (const artists of groups) {
            const artist = artists[artistIndex];
            if (!artist) continue;
            const key = artist.toLocaleLowerCase("ru-RU");
            if (seen.has(key)) continue;
            seen.add(key);
            suggestions.push(artist);
            if (suggestions.length >= safeLimit) return suggestions;
        }
    }
    return suggestions;
}
