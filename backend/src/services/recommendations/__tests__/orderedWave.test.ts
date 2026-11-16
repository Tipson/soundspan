import { orderWaveRecommendations } from "../orderedWave";

function row(id: string, artist: string) {
    return { id, score: 100 - id.length, track: { artist: { name: artist } } };
}

describe("final ordered Wave artist spacing", () => {
    it("spreads the approved A,A,D,B,E,C fixture without changing admitted rows or scores", () => {
        const input = [
            row("a1", "A"),
            row("a2", "A"),
            row("d", "D"),
            row("b", "B"),
            row("e", "E"),
            row("c", "C"),
        ];
        const original = [...input];
        const result = orderWaveRecommendations(input);
        expect(result.map((item) => item.id)).toEqual([
            "a1",
            "d",
            "b",
            "a2",
            "e",
            "c",
        ]);
        expect(input).toEqual(original);
        expect(result).toHaveLength(input.length);
        for (const item of result)
            expect(original.find((old) => old.id === item.id)).toBe(item);
    });

    it("keeps the two verified previous positions across a page boundary", () => {
        const result = orderWaveRecommendations(
            [row("a", "A"), row("c", "C"), row("b", "B"), row("d", "D")],
            ["A", "B"],
        );
        expect(result.map((item) => item.id)).toEqual(["c", "a", "b", "d"]);
    });

    it("relaxes the target distance before scarcity creates avoidable adjacent pairs", () => {
        const input = [
            row("a1", "A"),
            row("a2", "A"),
            row("a3", "A"),
            row("a4", "A"),
            row("b", "B"),
            row("c", "C"),
        ];
        const result = orderWaveRecommendations(input);
        expect(result.map((item) => item.id)).toEqual([
            "a1",
            "b",
            "a2",
            "c",
            "a3",
            "a4",
        ]);
    });

    it("never creates adjacent known artists while another remaining artist is available", () => {
        const input = [
            row("a1", "A"),
            row("a2", "A"),
            row("b1", "B"),
            row("b2", "B"),
            row("b3", "B"),
            row("c", "C"),
        ];
        const remaining = [...input];
        let previous: string | null = null;
        for (const item of orderWaveRecommendations(input)) {
            if (item.track.artist.name === previous)
                expect(
                    remaining.every(
                        (other) => other.track.artist.name === previous,
                    ),
                ).toBe(true);
            remaining.splice(remaining.indexOf(item), 1);
            previous = item.track.artist.name;
        }
    });

    it("treats absent and placeholder artists as neutral rather than one artificial artist", () => {
        const input = [
            row("missing", ""),
            row("unknown1", "Unknown"),
            row("unknown2", "UNKNOWN ARTIST"),
            row("real", "A"),
        ];
        expect(orderWaveRecommendations(input).map((item) => item.id)).toEqual(
            input.map((item) => item.id),
        );
    });

    it("shares Unicode and whitespace artist normalization with recommendation feedback", () => {
        const input = [
            row("a1", " Ａrtist　Ａ "),
            row("a2", "artist a"),
            row("b", "Б"),
            row("c", "В"),
        ];
        expect(orderWaveRecommendations(input).map((item) => item.id)).toEqual([
            "a1",
            "b",
            "c",
            "a2",
        ]);
    });

    it("retains sparse single-artist tracks and occurrence order instead of shortening the page", () => {
        const input = [row("a1", "A"), row("a2", "A"), row("a3", "A")];
        expect(orderWaveRecommendations(input)).toEqual(input);
        expect(orderWaveRecommendations([])).toEqual([]);
    });

    it("honors the caller deadline before and during ordering without changing the input", () => {
        const input = [row("a1", "A"), row("a2", "A"), row("b", "B")];
        let checks = 0;
        expect(() =>
            orderWaveRecommendations(input, [], () => {
                if (++checks === 2) throw new Error("radio deadline");
            }),
        ).toThrow("radio deadline");
        expect(input.map((item) => item.id)).toEqual(["a1", "a2", "b"]);
    });
});
