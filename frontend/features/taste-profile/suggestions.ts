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
    "Русская поп-музыка",
    "Русский рок",
    "Русский рэп",
    "R&B",
    "Соул",
    "K-pop",
    "J-pop",
    "Панк",
    "Постпанк",
    "Танцевальная",
    "Хаус",
    "Техно",
    "Drum and bass",
    "Трип-хоп",
    "Эмбиент",
    "Блюз",
    "Фанк",
    "Неоклассика",
    "Фолк",
    "Кантри",
    "Регги",
    "Латино",
    "Шансон",
    "Авторская песня",
] as const;

/** Browsable groups, not extra taste signals or an imported provider taxonomy. */
export const GENRE_GROUPS = [
    {
        label: "Поп и соул",
        genres: ["Поп", "Русская поп-музыка", "R&B", "Соул", "K-pop", "J-pop"],
    },
    {
        label: "Рок и гитары",
        genres: [
            "Рок",
            "Русский рок",
            "Альтернативный рок",
            "Метал",
            "Инди",
            "Панк",
            "Постпанк",
        ],
    },
    { label: "Хип-хоп и рэп", genres: ["Хип-хоп", "Русский рэп"] },
    {
        label: "Электроника и танцы",
        genres: [
            "Электроника",
            "Танцевальная",
            "Хаус",
            "Техно",
            "Drum and bass",
            "Трип-хоп",
            "Эмбиент",
        ],
    },
    {
        label: "Джаз, классика и кино",
        genres: [
            "Джаз",
            "Блюз",
            "Фанк",
            "Классика",
            "Неоклассика",
            "Саундтреки",
        ],
    },
    {
        label: "Фолк и другие направления",
        genres: [
            "Фолк",
            "Кантри",
            "Регги",
            "Латино",
            "Шансон",
            "Авторская песня",
        ],
    },
] as const;

type SuggestedGenre = (typeof SUGGESTED_GENRES)[number];

const ARTISTS_BY_GENRE: Record<SuggestedGenre, readonly string[]> = {
    "Русская поп-музыка": [
        "Zivert",
        "Моя Мишель",
        "Дима Билан",
        "Полина Гагарина",
        "Ёлка",
        "Винтаж",
    ],
    "Русский рок": [
        "Кино",
        "ДДТ",
        "Земфира",
        "Сплин",
        "Би-2",
        "Наутилус Помпилиус",
    ],
    "Русский рэп": [
        "Баста",
        "Noize MC",
        "Oxxxymiron",
        "Каста",
        "ATL",
        "Скриптонит",
    ],
    "R&B": [
        "SZA",
        "Frank Ocean",
        "Alicia Keys",
        "Usher",
        "H.E.R.",
        "The Weeknd",
    ],
    Соул: [
        "Aretha Franklin",
        "Marvin Gaye",
        "Otis Redding",
        "Stevie Wonder",
        "Erykah Badu",
    ],
    "K-pop": ["BTS", "BLACKPINK", "TWICE", "Stray Kids", "SEVENTEEN", "aespa"],
    "J-pop": [
        "YOASOBI",
        "Ado",
        "Hikaru Utada",
        "Kenshi Yonezu",
        "Official HIGE DANdism",
    ],
    Панк: [
        "Green Day",
        "The Offspring",
        "Ramones",
        "Sex Pistols",
        "Король и Шут",
    ],
    Постпанк: [
        "Joy Division",
        "Молчат Дома",
        "The Cure",
        "Дурной Вкус",
        "Буерак",
    ],
    Танцевальная: [
        "Avicii",
        "Calvin Harris",
        "David Guetta",
        "Martin Garrix",
        "Swedish House Mafia",
    ],
    Хаус: [
        "Disclosure",
        "Daft Punk",
        "Frankie Knuckles",
        "Kerri Chandler",
        "Duke Dumont",
    ],
    Техно: [
        "Jeff Mills",
        "Carl Cox",
        "Charlotte de Witte",
        "Amelie Lens",
        "Richie Hawtin",
    ],
    "Drum and bass": [
        "Pendulum",
        "Chase & Status",
        "Sub Focus",
        "Netsky",
        "Noisia",
    ],
    "Трип-хоп": [
        "Massive Attack",
        "Portishead",
        "Tricky",
        "Morcheeba",
        "Sneaker Pimps",
    ],
    Эмбиент: [
        "Brian Eno",
        "Stars of the Lid",
        "Hammock",
        "Loscil",
        "Biosphere",
    ],
    Блюз: [
        "B.B. King",
        "Muddy Waters",
        "Howlin' Wolf",
        "John Lee Hooker",
        "Stevie Ray Vaughan",
    ],
    Фанк: ["James Brown", "Parliament", "Funkadelic", "Vulfpeck", "The Meters"],
    Неоклассика: [
        "Ludovico Einaudi",
        "Max Richter",
        "Ólafur Arnalds",
        "Nils Frahm",
        "Dustin O'Halloran",
    ],
    Фолк: ["Мельница", "Wardruna", "Fleet Foxes", "Пелагея", "The Dubliners"],
    Кантри: [
        "Johnny Cash",
        "Dolly Parton",
        "Willie Nelson",
        "Chris Stapleton",
        "Kacey Musgraves",
    ],
    Регги: [
        "Bob Marley & The Wailers",
        "Peter Tosh",
        "Jimmy Cliff",
        "Toots & The Maytals",
        "Steel Pulse",
    ],
    Латино: ["Shakira", "Bad Bunny", "J Balvin", "Juanes", "Celia Cruz"],
    Шансон: [
        "Михаил Круг",
        "Любовь Успенская",
        "Михаил Шуфутинский",
        "Вилли Токарев",
        "Александр Розенбаум",
    ],
    "Авторская песня": [
        "Булат Окуджава",
        "Владимир Высоцкий",
        "Олег Митяев",
        "Юрий Визбор",
        "Сергей Никитин",
    ],
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
        "Johann Sebastian Bach",
        "Wolfgang Amadeus Mozart",
        "Ludwig van Beethoven",
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
    const groups = (genres.length > 0 ? genres : SUGGESTED_GENRES)
        .map((genre) =>
            ARTISTS_BY_GENRE_KEY.get(genre.trim().toLocaleLowerCase("ru-RU")),
        )
        .filter((artists): artists is readonly string[] => Boolean(artists));
    if (groups.length === 0) return [];

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

/** Mixed, balanced discovery shelf when no genre filter is selected. */
export const SUGGESTED_ARTISTS = suggestArtistsForGenres([], 36);
