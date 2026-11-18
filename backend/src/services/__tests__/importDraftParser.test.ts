import {
    parseImportDraftUpload,
    ImportDraftError,
    IMPORT_DRAFT_MAX_BYTES,
} from "../importDraftParser";

describe("bounded import draft normalization", () => {
    it("preserves ordered duplicate text occurrences and unresolved metadata", () => {
        const parsed = parseImportDraftUpload({
            format: "text",
            content: "Artist - First\nArtist - First\nUnknown title",
            name: "One playlist",
        });
        expect(parsed.entries.map((e) => [e.id, e.position, e.title])).toEqual([
            ["e0", 0, "First"],
            ["e1", 1, "First"],
            ["e2", 2, "Unknown title"],
        ]);
        expect(parsed.entries[2].unresolvedReason).toBe("missing_artist");
        expect(parsed.groups).toEqual([{ id: "p0", name: "One playlist" }]);
        expect(parsed.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it("normalizes each Spotify export category separately without raw profile data", () => {
        const content = JSON.stringify({
            email: "private@example.invalid",
            playlists: [
                {
                    name: "A",
                    items: [
                        {
                            track: {
                                artistName: "Artist",
                                trackName: "Song",
                                albumName: "Album",
                                trackUri: "spotify:track:abc123",
                            },
                        },
                        {
                            track: {
                                artistName: "Artist",
                                trackName: "Song",
                                trackUri: "spotify:track:abc123",
                            },
                        },
                    ],
                },
            ],
            tracks: [
                {
                    artist: "Singer",
                    track: "Liked",
                    uri: "spotify:track:like123",
                },
            ],
            albums: [
                {
                    artist: "Singer",
                    album: "Saved album",
                    uri: "spotify:album:album123",
                },
            ],
            artists: [{ name: "Singer", uri: "spotify:artist:artist123" }],
            bannedTracks: [
                {
                    artist: "Singer",
                    track: "Negative",
                    uri: "spotify:track:ban123",
                },
            ],
        });
        const parsed = parseImportDraftUpload({
            format: "spotify-json",
            content,
        });
        expect(parsed.entries.map((e) => e.category)).toEqual([
            "playlists",
            "playlists",
            "likes",
            "albums",
            "artists",
            "dislikes",
        ]);
        expect(parsed.entries[0].sourceRef).toEqual({
            source: "spotify",
            type: "track",
            entityId: "abc123",
        });
        expect(parsed.entries[0].position).toBe(0);
        expect(parsed.entries[1].position).toBe(1);
        expect(JSON.stringify(parsed)).not.toContain("private@example.invalid");
    });

    it("retains metadata-only album/artist entries as unresolved instead of inventing identities", () => {
        const parsed = parseImportDraftUpload({
            format: "spotify-json",
            content: JSON.stringify({
                albums: [{ artist: "A", album: "B" }],
                artists: [{ name: "A" }],
            }),
        });
        expect(parsed.entries.map((e) => e.unresolvedReason)).toEqual([
            "missing_source_identity",
            "missing_source_identity",
        ]);
        expect(parsed.entries.every((e) => e.sourceRef === null)).toBe(true);
    });

    it("allows explicit supported text references without fuzzy identity promotion", () => {
        const parsed = parseImportDraftUpload({
            format: "text",
            textCategory: "dislikes",
            content:
                "yt:video_123\tArtist\tTrack\nlibrary:local-123\tOther\tTrack",
        });
        expect(parsed.entries.map((e) => e.category)).toEqual([
            "dislikes",
            "dislikes",
        ]);
        expect(parsed.entries.map((e) => e.sourceRef)).toEqual([
            { source: "youtube", type: "track", entityId: "video_123" },
            { source: "library", type: "track", entityId: "local-123" },
        ]);
    });

    it.each([
        { format: "spotify-json", content: "{broken" },
        {
            format: "spotify-json",
            content: JSON.stringify({ tracks: "not-an-array" }),
        },
        {
            format: "spotify-json",
            content: JSON.stringify({
                playlists: [{ name: "A", items: [null] }],
            }),
        },
        { format: "text", content: "" },
        { format: "text", content: "x".repeat(IMPORT_DRAFT_MAX_BYTES + 1) },
        { format: "text", content: Array(1001).fill("A - B").join("\n") },
        { format: "text", content: "A - B\u0000C" },
    ])("rejects malformed or excessive input explicitly", (input) => {
        expect(() => parseImportDraftUpload(input)).toThrow(ImportDraftError);
    });
});
