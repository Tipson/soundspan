import {
    PersonalNativeCandidateService,
    type PersonalNativeCandidateDependencies,
} from "../personalNativeCandidates";
import { toNativeRecommendationCandidate } from "../nativeCandidates";
import { nativeArtistCreditKey } from "../nativeSourceAdmission";
import { createRadioRequestExecution } from "../radioRequestExecution";

const now = new Date("2026-10-08T10:00:00Z");
function song(provider: "vk" | "yandex", id: string, artists = [`Band ${id}`]) {
    return toNativeRecommendationCandidate(
        {
            provider,
            id,
            title: `Song ${id}`,
            artists,
            duration: 180,
            preview: false,
            contentVersion: "unknown",
        },
        "native-personal-test",
    )!;
}
const seeds = [song("vk", "-01_0002"), song("yandex", "0002")];
function ports(
    overrides: Partial<PersonalNativeCandidateDependencies> = {},
): PersonalNativeCandidateDependencies {
    return {
        loadOwnedSignals: async () => ({
            recent: [],
            liked: seeds,
            plays: [],
            knownIds: new Set(seeds.map((s) => s.id)),
        }),
        loadExactDislikes: async () => new Set(),
        loadCredits: async () => new Set(),
        loadMappings: async (candidates) => candidates.map(() => null),
        loadCanonicalDislikes: async () => new Set(),
        loadViewed: async () => new Set(),
        loadRepeats: async () => ({ ids: new Set(), hardIds: new Set() }),
        loadKnownIds: async () => new Set(),
        enrich: async (candidates) => candidates,
        getNeighbours: jest.fn(async () => ({ tracks: [], unavailable: [] })),
        ...overrides,
    };
}
describe("personal native production and admission", () => {
    it("uses only prepared owned seeds, three calls maximum and exact provider/count; strips upstream authority", async () => {
        const deps = ports({
            getNeighbours: jest.fn(async (source, id) => ({
                tracks: [
                    {
                        provider: source,
                        id: source === "vk" ? "-01_0010" : "0010",
                        title: "Neighbour",
                        artists: ["New band"],
                        duration: 180,
                        preview: false,
                        contentVersion: "unknown",
                        canonicalRecordingId: "forged",
                        audioFeatures: { arousal: 0.1 },
                        url: "https://private.example",
                    } as any,
                ],
                unavailable: [],
            })),
        });
        const service = new PersonalNativeCandidateService(deps);
        const profile = await service.prepare("owner-a", now, {});
        const result = await service.getBatch(profile, profile.seeds);
        expect(
            (deps.getNeighbours as jest.Mock).mock.calls.map(
                ([source, id, count]) => [source, id, count],
            ),
        ).toEqual([
            ["vk", "-01_0002", 100],
            ["yandex", "0002", 100],
        ]);
        expect(
            result.fresh
                .filter((candidate) => candidate.lane === "discovery")
                .map((candidate) => candidate.id),
        ).toEqual(["vk:-01_0010", "yandex:0010"]);
        for (const candidate of result.fresh) {
            expect(candidate.canonicalRecordingId).toBeNull();
            expect(candidate.audioFeatures).toBeUndefined();
            expect(candidate.musicSourceRecording).not.toHaveProperty("url");
        }
        await expect(
            service.getBatch(profile, [song("vk", "-9_9")]),
        ).rejects.toThrow("Unowned native seed");
        expect(deps.getNeighbours).toHaveBeenCalledTimes(2);
    });
    it("filters exact down, provider credit, hard24h, viewed and canonical alias before capacity; leaves enough eligible rows", async () => {
        const rows = Array.from({ length: 100 }, (_, i) =>
            song(
                "vk",
                `-1_${i + 100}`,
                i < 10 ? ["Suppressed", "Guest"] : [`Band ${i}`],
            ),
        );
        const credit = nativeArtistCreditKey(rows[0].musicSourceRecording)!;
        const deps = ports({
            loadOwnedSignals: async () => ({
                recent: [],
                liked: [seeds[0]],
                plays: [],
                knownIds: new Set([seeds[0].id]),
            }),
            loadExactDislikes: async (_u, ids) =>
                new Set(
                    ids.filter((id) =>
                        rows.slice(10, 30).some((r) => r.id === id),
                    ),
                ),
            loadCredits: async () => new Set([credit]),
            loadRepeats: async () => ({
                ids: new Set(rows.slice(30, 40).map((r) => r.id)),
                hardIds: new Set(rows.slice(30, 40).map((r) => r.id)),
            }),
            loadMappings: async (candidates) =>
                candidates.map((candidate) =>
                    rows.slice(40, 50).some((r) => r.id === candidate.id)
                        ? { id: "shared", canonicalKey: "literal:shared" }
                        : null,
                ),
            loadCanonicalDislikes: async () => new Set(["literal:shared"]),
            loadViewed: async () =>
                new Set(rows.slice(50, 55).map((r) => r.canonicalKey)),
            getNeighbours: async () => ({
                tracks: rows.map((r) => r.musicSourceRecording!),
                unavailable: [],
            }),
        });
        const service = new PersonalNativeCandidateService(deps),
            profile = await service.prepare("owner-a", now, {
                surface: "wave",
            });
        const result = await service.getBatch(profile, profile.seeds);
        expect(
            result.fresh.filter((r) => r.lane === "discovery").map((r) => r.id),
        ).toEqual(rows.slice(55).map((r) => r.id));
        expect(result.fallback).toEqual([]);
    });
    it("Home can listen again, new removes exact owned recordings, and soft repeats are a separate fallback", async () => {
        const liked = seeds[0],
            old = song("vk", "-1_20"),
            recent = song("vk", "-1_21"),
            failed = song("vk", "-1_22");
        const deps = ports({
            loadOwnedSignals: async () => ({
                recent: [recent],
                liked: [liked],
                plays: [],
                knownIds: new Set([liked.id, recent.id]),
            }),
            loadRepeats: async () => ({
                ids: new Set([old.id, recent.id]),
                hardIds: new Set([recent.id]),
            }),
            getNeighbours: async () => ({
                tracks: [old, recent, failed, liked].map(
                    (r) => r.musicSourceRecording!,
                ),
                unavailable: [],
            }),
        });
        const service = new PersonalNativeCandidateService(deps);
        const home = await service.prepare("owner-a", now, { surface: "home" });
        expect(
            (await service.getBatch(home, home.seeds)).fresh.some(
                (r) => r.id === recent.id,
            ),
        ).toBe(true);
        const wave = await service.prepare("owner-a", now, { surface: "wave" });
        const waveBatch = await service.getBatch(wave, wave.seeds);
        expect(waveBatch.fresh.some((r) => r.id === failed.id)).toBe(true);
        expect(
            waveBatch.fresh.some((r) => r.id === recent.id || r.id === old.id),
        ).toBe(false);
        expect(waveBatch.fallback.map((r) => r.id)).toEqual([old.id]);
        const fresh = await service.prepare("owner-a", now, {
            surface: "made-for-you",
            mode: "new",
        });
        const next = await service.getBatch(fresh, fresh.seeds);
        expect(next.fresh.map((r) => r.id)).toEqual([failed.id]);
        expect(next.fallback).toEqual([]);
    });
    it("current owned feedback failures fail closed before provider calls; another owner remains independent", async () => {
        const deps = ports({
            loadExactDislikes: async (userId) => {
                if (userId === "owner-a")
                    throw new Error("private SQL details");
                return new Set();
            },
        });
        const service = new PersonalNativeCandidateService(deps);
        const a = await service.prepare("owner-a", now, {});
        expect(a.seeds).toEqual([]);
        expect(a.degradedSources).toEqual(["native-personal-admission"]);
        const b = await service.prepare("owner-b", now, {});
        expect(b.seeds).toHaveLength(2);
        expect(deps.getNeighbours).not.toHaveBeenCalled();
    });
    it("explicit mood unknown cannot crowd measured eligible native candidates before quotas", async () => {
        const unmeasured = song("yandex", "0020"),
            measured = song("yandex", "0021");
        const deps = ports({
            loadOwnedSignals: async () => ({
                recent: [],
                liked: [seeds[1]],
                plays: [],
                knownIds: new Set([seeds[1].id]),
            }),
            loadMappings: async (rows) =>
                rows.map((r) =>
                    r.id === measured.id
                        ? { id: "measured", canonicalKey: "exact-measured" }
                        : null,
                ),
            enrich: async (rows) =>
                rows.map((r) =>
                    r.canonicalRecordingId === "measured"
                        ? { ...r, audioFeatures: { arousal: 0.2 } }
                        : r,
                ),
            getNeighbours: async () => ({
                tracks: [unmeasured, measured].map(
                    (r) => r.musicSourceRecording!,
                ),
                unavailable: [],
            }),
        });
        const service = new PersonalNativeCandidateService(deps),
            profile = await service.prepare("owner-a", now, {
                surface: "wave",
                mood: "calm",
            });
        const result = await service.getBatch(profile, profile.seeds);
        expect(result.fresh.map((r) => r.id)).toEqual([measured.id]);
        expect(result.fallback).toEqual([]);
    });
    it("request cancellation after held source stops later preference reads and returns no late batch", async () => {
        let release!: (value: any) => void, entered!: () => void;
        const started = new Promise<void>((resolve) => {
                entered = resolve;
            }),
            held = new Promise<any>((resolve) => {
                release = resolve;
            });
        const deps = ports({
            getNeighbours: jest.fn(async () => {
                entered();
                return held;
            }),
        });
        const service = new PersonalNativeCandidateService(deps),
            controller = new AbortController(),
            execution = createRadioRequestExecution(controller.signal);
        try {
            const profile = await service.prepare("owner-a", now, {
                execution,
                sourceSignal: controller.signal,
            });
            const promise = execution.run(() =>
                service.getBatch(profile, [profile.seeds[0]]),
            );
            const error = promise.catch((failure) => failure);
            await started;
            controller.abort();
            expect((await error).code).toBe("RADIO_REQUEST_CANCELLED");
            release({
                tracks: [song("vk", "-1_99").musicSourceRecording],
                unavailable: [],
            });
            await new Promise((resolve) => setImmediate(resolve));
        } finally {
            execution.dispose();
        }
    });
});
