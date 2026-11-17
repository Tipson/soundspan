import { buildTimeOfDayMix } from "../timeOfDayMix";
import type {
    PersonalizedHomeFeed,
    PersonalizedNativeTrack,
    PersonalizedTrack,
} from "../../personalizedCatalog";

function track(id: string, artist = `Artist ${id}`): PersonalizedTrack {
    return {
        id: `yt:${id}`,
        title: id,
        duration: 180,
        trackNo: null,
        artist: { id: null, name: artist },
        album: {
            id: null,
            title: "Album",
            coverArt: "",
            artist: { id: null, name: artist },
        },
        source: "youtube",
        streamSource: "youtube",
        youtubeVideoId: id,
        provider: { youtubeVideoId: id, tidalTrackId: null },
    };
}
function input(
    overrides: Partial<Parameters<typeof buildTimeOfDayMix>[0]> = {},
) {
    return {
        shelves: {
            listenAgain: [],
            quickPicks: [],
            discovery: [],
        } as PersonalizedHomeFeed["shelves"],
        checkedAt: new Date("2026-11-17T00:29:30.000Z"),
        localHour: 5,
        timezoneOffsetMinutes: 330,
        providerDegraded: false,
        ...overrides,
    };
}

describe("authoritative finite time-of-day view", () => {
    it("uses the same east-positive offset contract as both production clients and the existing catalog", () => {
        const mix = buildTimeOfDayMix(
            input({
                checkedAt: new Date("2026-11-17T04:55:00Z"),
                localHour: 5,
                timezoneOffsetMinutes: 60,
            }),
        );
        expect(mix.snapshot.refreshAfter).toBe("2026-11-17T05:00:00.000Z");
        const fractional = buildTimeOfDayMix(
            input({
                checkedAt: new Date("2026-11-17T00:29:30Z"),
                localHour: 5,
                timezoneOffsetMinutes: 330,
            }),
        );
        expect(fractional.snapshot.refreshAfter).toBe(
            "2026-11-17T00:30:00.000Z",
        );
    });

    it("keeps exact native and YouTube identities distinct while deduplicating repeated native occurrences", () => {
        const native: PersonalizedNativeTrack = {
            id: "vk:-1_2",
            title: "Native",
            duration: 180,
            trackNo: null,
            artist: { id: null, name: "Native artist" },
            album: {
                id: null,
                title: "Native album",
                coverArt: "",
                artist: { id: null, name: "Native artist" },
            },
            source: "vk",
            streamSource: "vk",
            provider: {
                source: "vk",
                providerTrackId: "-1_2",
                youtubeVideoId: null,
                tidalTrackId: null,
            },
            musicSourceRecording: {
                provider: "vk",
                id: "-1_2",
                title: "Native",
                artists: ["Native artist"],
                duration: 180,
                preview: false,
                contentVersion: "unknown",
            },
        };
        const mix = buildTimeOfDayMix(
            input({
                shelves: {
                    discovery: [track("-1_2"), native],
                    quickPicks: [native],
                    listenAgain: [],
                },
            }),
        );
        expect(mix.tracks.map((row) => row.id)).toEqual(["yt:-1_2", "vk:-1_2"]);
    });

    it("keeps the existing Web recipe and returns forty when the admitted pool permits", () => {
        const shelves = {
            discovery: Array.from({ length: 25 }, (_, i) => track(`d${i}`)),
            quickPicks: Array.from({ length: 25 }, (_, i) => track(`q${i}`)),
            listenAgain: Array.from({ length: 25 }, (_, i) => track(`l${i}`)),
        };
        const before = JSON.stringify(shelves);
        const mix = buildTimeOfDayMix(input({ shelves }));
        expect(mix.tracks.map((t) => t.id)).toEqual(
            [...shelves.discovery, ...shelves.quickPicks.slice(0, 15)].map(
                (t) => t.id,
            ),
        );
        expect(mix.snapshot).toMatchObject({
            requestedCount: 40,
            snapshotCount: 40,
            availableCount: 40,
            reasons: [],
        });
        expect(JSON.stringify(shelves)).toBe(before);
    });

    it("deduplicates provider occurrences and caps credited artists without inventing identities for unknown artists", () => {
        const duplicate = track("same", " A ");
        const mix = buildTimeOfDayMix(
            input({
                shelves: {
                    discovery: [
                        duplicate,
                        track("a2", "a"),
                        track("a3", "A"),
                        ...Array.from({ length: 3 }, (_, i) =>
                            track(`u${i}`, "unknown artist"),
                        ),
                    ],
                    quickPicks: [duplicate, track("b", "B")],
                    listenAgain: [],
                },
            }),
        );
        expect(mix.tracks.map((t) => t.id)).toEqual([
            "yt:same",
            "yt:a2",
            "yt:u0",
            "yt:u1",
            "yt:u2",
            "yt:b",
        ]);
        expect(mix.snapshot).toMatchObject({
            availableCount: 6,
            reasons: ["pool_limited"],
        });
    });

    it("keeps an empty authoritative result and reports observed provider scarcity without generating filler", () => {
        const mix = buildTimeOfDayMix(input({ providerDegraded: true }));
        expect(mix.tracks).toEqual([]);
        expect(mix.snapshot).toMatchObject({
            requestedCount: 40,
            snapshotCount: 0,
            availableCount: 0,
            reasons: ["provider_degraded", "pool_limited"],
        });
    });

    it("records a check rather than inventing an original composition date, with stable exact membership lineage", () => {
        const shelves = {
            discovery: [track("one"), track("two")],
            quickPicks: [],
            listenAgain: [],
        };
        const first = buildTimeOfDayMix(input({ shelves }));
        const reread = buildTimeOfDayMix(
            input({
                shelves,
                checkedAt: new Date("2026-11-18T12:00:00Z"),
                localHour: 12,
                timezoneOffsetMinutes: 0,
            }),
        );
        const reordered = buildTimeOfDayMix(
            input({
                shelves: {
                    ...shelves,
                    discovery: [...shelves.discovery].reverse(),
                },
            }),
        );
        expect(first.snapshot).not.toHaveProperty("generatedAt");
        expect(first.snapshot.checkedAt).toBe("2026-11-17T00:29:30.000Z");
        expect(first.snapshot.compositionKey).toMatch(
            /^daypart-v1:[a-f0-9]{64}$/,
        );
        expect(first.snapshot.compositionKey).toBe(
            reread.snapshot.compositionKey,
        );
        expect(first.snapshot.compositionKey).not.toBe(
            reordered.snapshot.compositionKey,
        );
    });

    it.each([
        ["2026-11-16T23:59:30Z", 5, 330, "2026-11-17T00:00:00.000Z"],
        ["2026-11-17T00:29:30Z", 5, 330, "2026-11-17T00:30:00.000Z"],
        ["2026-11-17T00:30:00Z", 6, 330, "2026-11-17T00:40:00.000Z"],
        ["2026-11-17T09:29:30Z", 5, -210, "2026-11-17T09:30:00.000Z"],
        ["2026-03-29T00:55:00Z", 1, 60, "2026-03-29T01:05:00.000Z"],
        ["2026-03-29T01:05:00Z", 3, 120, "2026-03-29T01:15:00.000Z"],
        ["2026-10-25T00:59:00Z", 2, 120, "2026-10-25T01:09:00.000Z"],
        ["2026-10-25T01:01:00Z", 2, 60, "2026-10-25T01:11:00.000Z"],
    ])(
        "bounds refresh against the supplied offset and real UTC instant %s",
        (now, hour, offset, expected) => {
            expect(
                buildTimeOfDayMix(
                    input({
                        checkedAt: new Date(now),
                        localHour: hour,
                        timezoneOffsetMinutes: offset,
                    }),
                ).snapshot.refreshAfter,
            ).toBe(expected);
        },
    );

    it("does not advertise freshness when the supplied period disagrees with the server instant", () => {
        const now = new Date("2026-11-17T15:00:00Z");
        expect(
            buildTimeOfDayMix(
                input({
                    checkedAt: now,
                    localHour: 1,
                    timezoneOffsetMinutes: 0,
                }),
            ).snapshot.refreshAfter,
        ).toBe(now.toISOString());
    });
});
