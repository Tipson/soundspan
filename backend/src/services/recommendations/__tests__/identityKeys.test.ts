import {
    buildRecommendationAlbumKey,
    normalizeRecommendationArtistKey,
} from "../identityKeys";

describe("recommendation identity normalization", () => {
    it("bounds oldest-entry scans when the cache sees continuous new inputs", () => {
        jest.isolateModules(() => {
            const normalize = (
                require("../identityKeys") as typeof import("../identityKeys")
            ).normalizeRecommendationArtistKey;
            for (let i = 0; i < 4096; i += 1) normalize(`Artist ${i}`);
            const keys = jest.spyOn(Map.prototype, "keys");
            let scans = 0;
            try {
                for (let i = 4096; i < 5000; i += 1) normalize(`Artist ${i}`);
                scans = keys.mock.calls.length;
            } finally {
                keys.mockRestore();
            }
            expect(scans).toBeLessThanOrEqual(2);
        });
    });

    it.each([
        ["  ARTIST\t NAME  ", "artist name"],
        ["", ""],
        ["  ", ""],
        ["ЁЛКА", "ёлка"],
        ["İ I ı i", "i\u0307 i ı i"],
        ["ΟΣ ΟΣΑ", "ος οσα"],
        ["I\u0307\u0301", "i\u0307\u0301"],
        ["Ｆｕｌｌｗｉｄｔｈ", "fullwidth"],
        ["Straße ẞ", "straße ß"],
        ["𐐀 𝔄", "𐐨 a"],
        ["e\u0301 É", "é é"],
        ["\ud800artist\udfff", "\ud800artist\udfff"],
        ["a\u0000b", "a\u0000b"],
        ["artist\u200bname", "artist\u200bname"],
        ["x".repeat(513), "x".repeat(513)],
    ])("preserves the existing Unicode key for %p", (value, expected) => {
        expect(normalizeRecommendationArtistKey(value)).toBe(expected);
        expect(normalizeRecommendationArtistKey(value)).toBe(expected);
    });

    it("reuses identical short inputs, including results that normalize to empty", () => {
        jest.isolateModules(() => {
            const normalize = (
                require("../identityKeys") as typeof import("../identityKeys")
            ).normalizeRecommendationArtistKey;
            const lower = jest.spyOn(String.prototype, "toLocaleLowerCase");
            try {
                expect(normalize(" Artist ")).toBe("artist");
                expect(normalize(" Artist ")).toBe("artist");
                expect(normalize("   ")).toBe("");
                expect(normalize("   ")).toBe("");
                expect(lower).toHaveBeenCalledTimes(2);
                expect(normalize(" Changed Artist ")).toBe("changed artist");
                expect(lower).toHaveBeenCalledTimes(3);
            } finally {
                lower.mockRestore();
            }
        });
    });

    it("evicts the least recently used input after 4096 entries", () => {
        jest.isolateModules(() => {
            const normalize = (
                require("../identityKeys") as typeof import("../identityKeys")
            ).normalizeRecommendationArtistKey;
            for (let i = 0; i < 4096; i += 1) normalize(`Artist ${i}`);
            normalize("Artist 0");
            normalize("Artist 4096");
            const lower = jest.spyOn(String.prototype, "toLocaleLowerCase");
            try {
                expect(normalize("Artist 0")).toBe("artist 0");
                expect(lower).not.toHaveBeenCalled();
                expect(normalize("Artist 1")).toBe("artist 1");
                expect(lower).toHaveBeenCalledTimes(1);
            } finally {
                lower.mockRestore();
            }
        });
    });

    it.each([
        ["X".repeat(513), "x".repeat(513)],
        ["\ufdfa".repeat(32), "صلى الله عليه وسلم".repeat(32)],
    ])(
        "does not retain oversized input or normalized output",
        (value, expected) => {
            const lower = jest.spyOn(String.prototype, "toLocaleLowerCase");
            try {
                expect(normalizeRecommendationArtistKey(value)).toBe(expected);
                expect(normalizeRecommendationArtistKey(value)).toBe(expected);
                expect(lower).toHaveBeenCalledTimes(2);
            } finally {
                lower.mockRestore();
            }
        },
    );

    it("preserves album tuple boundaries and unknown-release handling", () => {
        expect(buildRecommendationAlbumKey("Artist", " Album ")).toBe(
            '["artist","album"]',
        );
        expect(
            buildRecommendationAlbumKey("Artist", "Unknown Album"),
        ).toBeNull();
        expect(buildRecommendationAlbumKey("a:b", "c")).not.toBe(
            buildRecommendationAlbumKey("a", "b:c"),
        );
    });
});
