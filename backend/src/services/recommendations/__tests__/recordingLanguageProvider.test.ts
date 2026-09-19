import { classifyMatchedLyrics } from "../recordingLanguageProvider";
const track = {
    title: "Numb (Official Music Video)",
    artist: { name: "Linkin Park" },
    album: { title: "Meteora" },
    duration: 185,
};
const text =
    "This is a story about a person who returns home every evening. He looks at the stars and remembers his childhood and his friends. Today he writes another letter about love, hope and the long road ahead.";
const payload = {
    trackName: "Numb",
    artistName: "LINKIN PARK",
    duration: 186,
    instrumental: false,
    plainLyrics: text,
    syncedLyrics: null,
};
describe("matched lyrics language", () => {
    it("accepts matching artist/title and a small duration tolerance", () =>
        expect(classifyMatchedLyrics(track, payload)).toBe("foreign"));
    it.each([
        { ...payload, artistName: "Another Artist" },
        { ...payload, trackName: "Numb (Live)" },
        { ...payload, duration: 250 },
        { ...payload, plainLyrics: 42 },
        { instrumental: true },
    ])("rejects wrong recordings and malformed bodies", (body) =>
        expect(classifyMatchedLyrics(track, body)).toBe("unknown"),
    );
    it("does not infer a language from a metadata-only provider response", () =>
        expect(
            classifyMatchedLyrics(track, { ...payload, plainLyrics: null }),
        ).toBe("unknown"));
});
