import { Worker } from "node:worker_threads";
import {
    VARIOUS_ARTISTS_CANONICAL,
    VARIOUS_ARTISTS_MBID,
    canonicalizeVariousArtists,
    isVariousArtistsById,
    hasDiacritics,
    getPreferredArtistName,
    normalizeArtistName,
    normalizeAlbumTitle,
    normalizeForExactKey,
    normalizeForFuzzyMatch,
    stripAlbumEdition,
    areArtistNamesSimilar,
    findBestArtistMatch,
    extractPrimaryArtist,
    parseArtistFromPath,
} from "../artistNormalization";

type BoundedNormalizer =
    | "canonicalizeVariousArtists"
    | "normalizeArtistName"
    | "normalizeForFuzzyMatch"
    | "normalizeForExactKey"
    | "parseArtistFromPath";

async function normalizeInWorker(
    functionName: BoundedNormalizer,
    input: string,
): Promise<string | null> {
    const worker = new Worker(
        `
            const { parentPort, workerData } = require("node:worker_threads");
            require(workerData.registerPath);
            const normalize = require(workerData.modulePath)[workerData.functionName];
            parentPort.postMessage({ type: "ready" });
            parentPort.once("message", () => {
                let value;
                for (let iteration = 0; iteration < 32; iteration += 1) {
                    value = normalize(workerData.input);
                }
                parentPort.postMessage({ type: "result", value });
            });
        `,
        {
            eval: true,
            workerData: {
                registerPath: require.resolve("tsx/cjs"),
                modulePath: require.resolve("../artistNormalization"),
                functionName,
                input,
            },
        },
    );
    let deadline: NodeJS.Timeout | undefined;
    try {
        return await new Promise<string | null>((resolve, reject) => {
            deadline = setTimeout(
                () => reject(new Error("Normalization worker did not start")),
                5_000,
            );
            worker.on(
                "message",
                (
                    message:
                        | { type: "ready" }
                        | { type: "result"; value: string | null },
                ) => {
                    if (message.type === "ready") {
                        clearTimeout(deadline);
                        // Repetition separates quadratic work from scheduling noise.
                        deadline = setTimeout(
                            () =>
                                reject(
                                    new Error(
                                        `${functionName} exceeded the normalization deadline`,
                                    ),
                                ),
                            2_000,
                        );
                        worker.postMessage("run");
                    } else {
                        resolve(message.value);
                    }
                },
            );
            worker.once("error", reject);
            worker.once("exit", (code) => {
                reject(
                    new Error(`Normalization worker exited early (${code})`),
                );
            });
        });
    } finally {
        clearTimeout(deadline);
        await worker.terminate();
    }
}

describe("artistNormalization utilities", () => {
    it("canonicalizes various-artists aliases and preserves non-matches", () => {
        expect(VARIOUS_ARTISTS_MBID).toBe(
            "89ad4ac3-39f7-470e-963a-56509c546377",
        );
        expect(canonicalizeVariousArtists("V.A.")).toBe(
            VARIOUS_ARTISTS_CANONICAL,
        );
        expect(canonicalizeVariousArtists("<Various Artists>")).toBe(
            VARIOUS_ARTISTS_CANONICAL,
        );
        expect(canonicalizeVariousArtists("Single Artist")).toBe(
            "Single Artist",
        );
    });

    it.each(["v a", "V. / A.", "v..a", "v\u00a0/\u2003a", "Various Artist"])(
        "preserves the various-artists alias %p",
        (input) => {
            expect(canonicalizeVariousArtists(input)).toBe(
                VARIOUS_ARTISTS_CANONICAL,
            );
        },
    );

    it.each(["v//a", "v a x", "  Single Artist  "])(
        "preserves a non-matching various-artists name %p",
        (input) => {
            expect(canonicalizeVariousArtists(input)).toBe(input);
        },
    );

    it("detects platform-specific various-artists ids", () => {
        expect(isVariousArtistsById("deezer", 5080)).toBe(true);
        expect(isVariousArtistsById("deezer", "5080")).toBe(true);
        expect(isVariousArtistsById("spotify", "5080")).toBe(false);
    });

    it("handles diacritics and preferred-name selection", () => {
        expect(hasDiacritics("Ólafur")).toBe(true);
        expect(hasDiacritics("Olafur")).toBe(false);
        expect(getPreferredArtistName("Olafur Arnalds", "Ólafur Arnalds")).toBe(
            "Ólafur Arnalds",
        );
        expect(getPreferredArtistName("Short", "Longer Name")).toBe(
            "Longer Name",
        );
    });

    it("normalizes artist and album names", () => {
        expect(normalizeArtistName(" Of  Mice & Men ")).toBe("of mice and men");
        expect(normalizeArtistName("Björk")).toBe("bjork");
        expect(normalizeArtistName(null as any)).toBe("");
        expect(normalizeAlbumTitle("  A Love Supreme  ")).toBe(
            "a love supreme",
        );
        expect(normalizeAlbumTitle(null as any)).toBe("");
    });

    it.each([
        ["Of Mice&Men", "of mice and men", "of mice and men", "ofmiceandmen"],
        [
            "Of Mice   &   Men",
            "of mice and men",
            "of mice and men",
            "ofmiceandmen",
        ],
        [
            "\tBjörk\u00a0&\u2003Ólafur\n",
            "bjork and olafur",
            "bjork and olafur",
            "bjorkandolafur",
        ],
        [" & ", "and", "and", "and"],
        ["A&&B", "a and and b", "a and and b", "aandandb"],
        [
            "AC/DC & Sigur Rós",
            "ac/dc and sigur ros",
            "acdc and sigur ros",
            "acdcandsigurros",
        ],
        ["Ａ & Ｂ", "ａ and ｂ", "ａ and ｂ", "ａandｂ"],
    ])(
        "preserves ampersand normalization and Unicode in %p",
        (input, artist, fuzzy, exact) => {
            expect(normalizeArtistName(input)).toBe(artist);
            expect(normalizeForFuzzyMatch(input)).toBe(fuzzy);
            expect(normalizeForExactKey(input)).toBe(exact);
        },
    );

    describe("canonical match normalization", () => {
        it.each([
            ["Beyoncé", "beyonce"],
            ["Motörhead", "motorhead"],
            ["Sigur Rós", "sigur ros"],
            ["AC/DC", "acdc"],
            ["Panic! at the Disco", "panic at the disco"],
            ["R.E.M.", "rem"],
            ["Of Mice & Men", "of mice and men"],
            ["Of Mice and Men", "of mice and men"],
            ["Beyoncé – Renaissance", "beyonce renaissance"],
            ["Beyoncé — Renaissance", "beyonce renaissance"],
            ["Beyoncé - Renaissance", "beyonce renaissance"],
            ["\u2002Sigur\u00a0\u2009Rós\n", "sigur ros"],
            ["", ""],
            ["  — !?  ", ""],
        ])("normalizes %p for fuzzy matching", (input, expected) => {
            expect(normalizeForFuzzyMatch(input)).toBe(expected);
        });

        it.each([
            ["Beyoncé", "beyonce"],
            ["Motörhead", "motorhead"],
            ["Sigur Rós", "sigurros"],
            ["AC/DC", "acdc"],
            ["Panic! at the Disco", "panicatthedisco"],
            ["R.E.M.", "rem"],
            ["Of Mice & Men", "ofmiceandmen"],
            ["Of Mice and Men", "ofmiceandmen"],
            ["Beyoncé – Renaissance", "beyoncerenaissance"],
            ["Beyoncé-Renaissance", "beyoncerenaissance"],
            ["\u2002Sigur\u00a0\u2009Rós\n", "sigurros"],
            ["", ""],
            ["  — !?  ", ""],
        ])("normalizes %p as an exact key", (input, expected) => {
            expect(normalizeForExactKey(input)).toBe(expected);
        });

        it("composes edition stripping with either match normalizer", () => {
            const title = "Beyoncé – Renaissance (Deluxe Edition)";
            const baseTitle = stripAlbumEdition(title);

            expect(normalizeForFuzzyMatch(baseTitle)).toBe(
                "beyonce renaissance",
            );
            expect(normalizeForExactKey(baseTitle)).toBe("beyoncerenaissance");
        });
    });

    it("strips album edition markers and guards oversized input", () => {
        expect(stripAlbumEdition("Abbey Road (2019 Remaster)")).toBe(
            "Abbey Road",
        );
        expect(stripAlbumEdition("In Rainbows [Deluxe Edition]")).toBe(
            "In Rainbows",
        );
        expect(stripAlbumEdition("Album Name - Expanded Edition")).toBe(
            "Album Name",
        );
        expect(stripAlbumEdition("Record (2020)")).toBe("Record");

        const huge = ` ${"x".repeat(501)} `;
        expect(stripAlbumEdition(huge)).toBe("x".repeat(501));
    });

    it("supports fuzzy artist similarity and best-match lookup", () => {
        expect(areArtistNamesSimilar("The Weeknd", "The Weekend", 70)).toBe(
            true,
        );
        expect(areArtistNamesSimilar("Miles Davis", "Metallica", 90)).toBe(
            false,
        );
        expect(areArtistNamesSimilar(null as any, "Artist", 80)).toBe(false);

        expect(
            findBestArtistMatch(
                "The Weekend",
                ["Metallica", "The Weeknd", "Boards of Canada"],
                70,
            ),
        ).toBe("The Weeknd");
        expect(
            findBestArtistMatch("No Match", ["Metallica", "Daft Punk"], 95),
        ).toBeNull();
        expect(findBestArtistMatch("Anything", [], 50)).toBeNull();
    });

    it("extracts primary artists while preserving known band-name patterns", () => {
        expect(extractPrimaryArtist("Artist feat. Someone")).toBe("Artist");
        expect(extractPrimaryArtist("Artist ft. Someone")).toBe("Artist");
        expect(extractPrimaryArtist("CHVRCHES & Robert Smith")).toBe(
            "CHVRCHES",
        );
        expect(extractPrimaryArtist("Artist, Guest Artist")).toBe("Artist");

        expect(extractPrimaryArtist("Earth, Wind & Fire")).toBe(
            "Earth, Wind & Fire",
        );
        expect(extractPrimaryArtist("The Naked and Famous")).toBe(
            "The Naked and Famous",
        );
        expect(extractPrimaryArtist("Of Mice & Men")).toBe("Of Mice & Men");
        expect(extractPrimaryArtist("")).toBe("Unknown Artist");
    });

    it("parses artist names from common folder path patterns", () => {
        expect(
            parseArtistFromPath("Artist Name - Album Name (2022) FLAC"),
        ).toBe("Artist Name");
        expect(
            parseArtistFromPath("Artist.Name-Album.Name-24BIT-FLAC-2023-GROUP"),
        ).toBe("Artist.Name");
        expect(parseArtistFromPath("FLAC-2023")).toBe("FLAC");
        expect(parseArtistFromPath("")).toBeNull();
    });

    it.each([
        ["Artist   - Album", "Artist"],
        ["Artist-  Album", "Artist"],
        ["Artist.Name-\n Album", "Artist.Name"],
        ["Artist.Name - Album\nSecond", "Artist Name"],
        ["Artist.Name-", "Artist Name"],
    ])("preserves folder artist parsing for %p", (input, expected) => {
        expect(parseArtistFromPath(input)).toBe(expected);
    });

    describe("bounded whitespace normalization", () => {
        const whitespace = " ".repeat(50_000);

        it.each<{
            functionName: BoundedNormalizer;
            input: string;
            expected: string | null;
        }>([
            {
                functionName: "canonicalizeVariousArtists",
                input: `v${whitespace}x`,
                expected: `v${whitespace}x`,
            },
            {
                functionName: "normalizeArtistName",
                input: `Artist${whitespace}Name`,
                expected: "artist name",
            },
            {
                functionName: "normalizeForFuzzyMatch",
                input: whitespace,
                expected: "",
            },
            {
                functionName: "normalizeForExactKey",
                input: `Björk${whitespace}Name`,
                expected: "bjorkname",
            },
            {
                functionName: "parseArtistFromPath",
                input: `Artist${whitespace}x`,
                expected: null,
            },
        ])(
            "runs $functionName on 50,000 spaces without blocking the test process",
            async ({ functionName, input, expected }) => {
                await expect(
                    normalizeInWorker(functionName, input),
                ).resolves.toBe(expected);
            },
            10_000,
        );

        it("checks a multiline folder suffix without blocking the test process", async () => {
            await expect(
                normalizeInWorker(
                    "parseArtistFromPath",
                    `Artist.Name-${whitespace}x\nx`,
                ),
            ).resolves.toBe("Artist Name");
        }, 10_000);
    });
});
