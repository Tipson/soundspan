import { createRadioContinuationLoader } from "../radioContinuation";
import { toNativeRecommendationCandidate } from "../nativeCandidates";
import type { PlaybackRadioOrigin } from "@soundspan/media-metadata-contract";
import type { RadioContinuationInput } from "../radioContinuation";

const candidate = (
    provider: "vk" | "yandex",
    id: string,
    artists = ["Artist", "Guest"],
) =>
    toNativeRecommendationCandidate(
        {
            provider,
            id,
            title: `Song ${id}`,
            artists,
            duration: 180,
            contentVersion: "unknown",
            preview: false,
        },
        "native-radio",
    )!;
const origin = {
    kind: "track",
    source: "vk",
    id: "-001_002",
} as PlaybackRadioOrigin;
const input = {
    userId: "alice",
    sessionId: "tab",
    radioOrigin: origin,
    cursor: 0,
    limit: 25,
    exclude: [] as string[],
};
function dependencies(tracks: unknown[]) {
    return {
        loadSeedTracks: jest.fn(async (_input: RadioContinuationInput) => ({
            tracks,
            degradedSources: [],
        })),
        loadPreferences: jest.fn(async () => ({
            ids: new Set<string>(),
            songKeys: new Set<string>(),
            suppressedArtists: new Set<string>(),
            degradedSources: [],
        })),
        loadLibraryTracks: jest.fn(async () => []),
        admitCandidates: jest.fn(
            async (_owner: string, candidates: unknown[]) => ({
                candidates,
                degradedSources: [],
            }),
        ),
    };
}
describe("native original station pre-quota loader", () => {
    it("normalizes up to100 native rows before common ranking without library fallback", async () => {
        const tracks = Array.from({ length: 100 }, (_, i) =>
                candidate("vk", `-1_${i + 1}`),
            ),
            deps = dependencies(tracks);
        const result = await createRadioContinuationLoader(deps as any)(
            input,
            new Date(),
        );
        expect(result.candidates.map((c) => c.id)).toEqual(
            tracks.map((c) => c.id),
        );
        expect(deps.loadSeedTracks.mock.calls[0][0].limit).toBe(100);
        expect(deps.loadLibraryTracks).not.toHaveBeenCalled();
    });
    it("excludes original exact VK origin and queued native IDs while preserving zeroes", async () => {
        const tracks = [
                candidate("vk", "-001_002"),
                candidate("vk", "-1_3"),
                candidate("yandex", "0007"),
                candidate("yandex", "7"),
            ],
            deps = dependencies(tracks);
        const result = await createRadioContinuationLoader(deps as any)(
            { ...input, exclude: ["yandex:0007"] },
            new Date(),
        );
        expect(result.candidates.map((c) => c.id)).toEqual([
            "vk:-1_3",
            "yandex:7",
        ]);
    });
    it("does not borrow global YouTube artist/title dislikes for a native recording", async () => {
        const track = candidate("vk", "-1_3"),
            deps = dependencies([track]);
        deps.loadPreferences.mockResolvedValue({
            ids: new Set(),
            songKeys: new Set(["artist, guest|song -1_3"]),
            suppressedArtists: new Set(["artist, guest"]),
            degradedSources: [],
        });
        expect(
            (
                await createRadioContinuationLoader(deps as any)(
                    input,
                    new Date(),
                )
            ).candidates.map((c) => c.id),
        ).toEqual([track.id]);
    });
    it("applies ordered whole-credit provider-scoped suppression before common admission", async () => {
        const tracks = [
                candidate("vk", "-1_3"),
                candidate("yandex", "7"),
                candidate("vk", "-1_4", ["Guest", "Artist"]),
                candidate("vk", "-1_5", ["Guest"]),
            ],
            deps = dependencies(tracks);
        deps.loadPreferences.mockResolvedValue({
            ...(await deps.loadPreferences()),
            suppressedNativeCredits: new Set([
                JSON.stringify(["vk", ["artist", "guest"]]),
            ]),
        } as any);
        const result = await createRadioContinuationLoader(deps as any)(
            input,
            new Date(),
        );
        expect(result.candidates.map((c) => c.id)).toEqual([
            "yandex:7",
            "vk:-1_4",
            "vk:-1_5",
        ]);
        expect(
            deps.admitCandidates.mock.calls[0][1].map((c: any) => c.id),
        ).toEqual(result.candidates.map((c) => c.id));
    });
});
