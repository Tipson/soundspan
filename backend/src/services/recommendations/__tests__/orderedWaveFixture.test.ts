import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { orderWaveRecommendations } from "../orderedWave";

const fixture = JSON.parse(
    readFileSync(
        resolve(__dirname, "../../../../../fixtures/ordered-wave-v1.json"),
        "utf8",
    ),
) as {
    cases: {
        name: string;
        previousArtistKeys: (string | null)[];
        admitted: { id: string; artist: string }[];
        expectedIds: string[];
    }[];
};
describe("shared TS/Dart ordered Wave fixture", () => {
    it.each(fixture.cases)(
        "orders $name before either client consumes the same DTO",
        (entry) => {
            const admitted = entry.admitted.map(({ id, artist }) => ({
                id,
                score: 1,
                track: { artist: { name: artist } },
            }));
            const result = orderWaveRecommendations(
                admitted,
                entry.previousArtistKeys,
            );
            expect(result.map((row) => row.id)).toEqual(entry.expectedIds);
            expect(result).toHaveLength(admitted.length);
            expect(new Set(result)).toEqual(new Set(admitted));
        },
    );
});
