import {
    classifyRecordingLanguage,
    languageCacheKey,
    matchesWaveLanguage,
    parseLanguageCache,
} from "../recordingLanguage";

const russian =
    "Это история о человеке, который каждый день возвращается домой. Он смотрит на звёзды и вспоминает своё детство, друзей и родной город. Сегодня он снова пишет письмо о любви, надежде и долгой дороге.";
const english =
    "This is a story about a person who returns home every evening. He looks at the stars and remembers his childhood and his friends. Today he writes another letter about love, hope and the long road ahead.";
const ukrainian =
    "Це історія про людину, яка щодня повертається додому. Вона дивиться на зорі та згадує своє дитинство, друзів і рідне місто. Сьогодні вона знову пише листа про любов, надію та довгу дорогу.";

describe("recording language evidence", () => {
    it("uses lyrics, not artist nationality or title spelling", () => {
        expect(
            classifyRecordingLanguage({
                plainLyrics: russian,
                instrumental: false,
            }),
        ).toBe("ru");
        expect(
            classifyRecordingLanguage({
                plainLyrics: english,
                instrumental: false,
            }),
        ).toBe("foreign");
        expect(
            classifyRecordingLanguage({
                plainLyrics: ukrainian,
                instrumental: false,
            }),
        ).toBe("foreign");
    });
    it("does not invent a language for silence, short text or instrumental recordings", () => {
        expect(
            classifyRecordingLanguage({
                plainLyrics: null,
                instrumental: false,
            }),
        ).toBe("unknown");
        expect(
            classifyRecordingLanguage({
                plainLyrics: "La la la hey hey",
                instrumental: false,
            }),
        ).toBe("unknown");
        expect(
            classifyRecordingLanguage({
                plainLyrics: null,
                instrumental: true,
            }),
        ).toBe("instrumental");
        expect(
            classifyRecordingLanguage({
                plainLyrics: english,
                instrumental: true,
            }),
        ).toBe("unknown");
    });
    it("leaves mixed Russian and foreign verses unclassified", () => {
        expect(
            classifyRecordingLanguage({
                plainLyrics: `${russian}\n${english}`,
                instrumental: false,
            }),
        ).toBe("unknown");
    });
    it("does not let LRC timestamps and section headings determine language", () => {
        expect(
            classifyRecordingLanguage({
                syncedLyrics: `[00:01.20][Verse 1]\n[00:02.10]${russian}`,
                instrumental: false,
            }),
        ).toBe("ru");
    });
    it("keeps unknown and instrumental candidates in Any only", () => {
        for (const state of ["unknown", "instrumental"] as const) {
            expect(matchesWaveLanguage(state, "any")).toBe(true);
            expect(matchesWaveLanguage(state, "ru")).toBe(false);
            expect(matchesWaveLanguage(state, "foreign")).toBe(false);
        }
        expect(matchesWaveLanguage("ru", "ru")).toBe(true);
        expect(matchesWaveLanguage("ru", "foreign")).toBe(false);
        expect(matchesWaveLanguage("foreign", "foreign")).toBe(true);
    });
    it("keys exact recording metadata without Cyrillic collisions or delimiter ambiguity", () => {
        const track = {
            title: "Группа крови",
            artist: { name: "Кино" },
            album: { title: "Группа крови" },
            duration: 284,
        };
        expect(languageCacheKey(track)).not.toBe(
            languageCacheKey({ ...track, title: "Пачка сигарет" }),
        );
        expect(languageCacheKey(track)).not.toBe(
            languageCacheKey({ ...track, duration: 240 }),
        );
        expect(languageCacheKey(track)).toBe(
            languageCacheKey({ ...track, title: "ГРУППА КРОВИ" }),
        );
        expect(parseLanguageCache("ru")).toBe("ru");
        expect(parseLanguageCache('{"language":"ru"}')).toBeNull();
        expect(parseLanguageCache(null)).toBeNull();
    });
});
