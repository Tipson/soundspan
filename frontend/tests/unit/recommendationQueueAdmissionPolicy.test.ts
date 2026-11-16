import assert from "node:assert/strict";
import { test } from "node:test";
import type { Track } from "../../lib/audio-state-context";
import {
    RecommendationQueueAdmissionPolicy,
    recommendationAdmissionReference,
} from "../../lib/audio/recommendationQueueAdmissionPolicy";
import type {
    FiniteQueueAdmissionReference,
    RecommendationQueueAdmissionResult,
} from "../../lib/audio/recommendationQueueAdmission";

function song(id = "abcdefghijk", recommended = true): Track {
    return {
        id: "yt:" + id,
        youtubeVideoId: id,
        streamSource: "youtube",
        title: "Metadata is not authority",
        duration: 180,
        artist: { name: "Untrusted artist" },
        album: { title: "Album" },
        ...(recommended
            ? {
                  recommendationSessionId: "wave",
                  recommendationGenerationId: "generation-a",
              }
            : {}),
    };
}
function answer(
    refs: readonly FiniteQueueAdmissionReference[],
    state: "allowed" | "denied" | "unavailable",
): RecommendationQueueAdmissionResult {
    return {
        status: "ready",
        response: {
            version: 1,
            appliesTo: "recommended_future",
            decisions: refs.map(({ source, id }) => ({ source, id, state })),
        },
    };
}

test("maps exact server references and keeps real local backing separate from fallback metadata", () => {
    assert.deepEqual(recommendationAdmissionReference(song()), {
        source: "youtube",
        id: "abcdefghijk",
        generationId: "generation-a",
    });
    const local = {
        ...song(),
        id: "database-row",
        filePath: "/music/real.flac",
    };
    assert.deepEqual(recommendationAdmissionReference(local), {
        source: "library",
        id: "database-row",
        generationId: "generation-a",
    });
    const native = {
        ...song(),
        id: "vk:-12_34",
        streamSource: "vk" as const,
        youtubeVideoId: undefined,
        provider: { source: "vk" as const, providerTrackId: "-12_34" },
    };
    assert.deepEqual(recommendationAdmissionReference(native), {
        source: "vk",
        id: "-12_34",
        generationId: "generation-a",
    });
    assert.equal(recommendationAdmissionReference(song("bad")), null);
});

test("manual rows need no server request while unverified recommendations cannot be prepared", async () => {
    let reads = 0;
    const policy = new RecommendationQueueAdmissionPolicy(async (refs) => {
        reads++;
        return answer(refs, "allowed");
    }, {});
    assert.equal(policy.readyFor(song()), false);
    assert.equal(
        policy.allows(song()),
        true,
        "unknown evidence cannot become a durable dislike",
    );
    assert.equal(await policy.prepare([song("abcdefghijk", false)]), "ready");
    assert.equal(reads, 0);
    assert.equal(policy.readyFor(song("abcdefghijk", false)), true);
});

test("server denies are scoped to automatic occurrences and never rewrite manual authority", async () => {
    const policy = new RecommendationQueueAdmissionPolicy(
        async (refs) => answer(refs, "denied"),
        {},
    );
    assert.equal(await policy.prepare([song()]), "ready");
    assert.equal(policy.allows(song()), false);
    assert.equal(policy.readyFor(song()), false);
    assert.equal(policy.allows(song("abcdefghijk", false)), true);
    assert.equal(
        policy.allows({ ...song(), recommendationSessionId: "other-wave" }),
        true,
    );
});

test("every mutation retires prepared grants, waits all writes and clear cannot resurrect removed occurrences", async () => {
    let reads = 0;
    const policy = new RecommendationQueueAdmissionPolicy(async (refs) => {
        reads++;
        return answer(refs, "allowed");
    }, {});
    await policy.prepare([song()]);
    assert.equal(policy.readyFor(song()), true);
    const first = policy.beginMutation();
    const second = policy.beginMutation();
    assert.equal(policy.readyFor(song()), false);
    const pending = policy.prepare([song()]);
    await Promise.resolve();
    assert.equal(reads, 1);
    policy.settleMutation(first);
    await Promise.resolve();
    assert.equal(reads, 1);
    policy.settleMutation(second);
    assert.equal(await pending, "ready");
    assert.equal(reads, 2);
    assert.equal(policy.readyFor(song()), true);
});

test("a late response from an earlier mutation or owner cannot add an allowed decision", async () => {
    let release!: (value: RecommendationQueueAdmissionResult) => void;
    let captured!: readonly FiniteQueueAdmissionReference[];
    const policy = new RecommendationQueueAdmissionPolicy((refs) => {
        captured = refs;
        return new Promise((resolve) => {
            release = resolve;
        });
    }, {});
    const old = policy.prepare([song()]);
    await Promise.resolve();
    const write = policy.beginMutation();
    release(answer(captured, "allowed"));
    assert.equal(await old, "superseded");
    assert.equal(policy.readyFor(song()), false);
    policy.settleMutation(write);
    policy.setOwner(null);
    assert.equal(await policy.prepare([song()]), "superseded");
});

test("same-capture prepare calls coalesce without leaking across manual queue replacement", async () => {
    let reads = 0;
    let release!: (value: RecommendationQueueAdmissionResult) => void;
    const policy = new RecommendationQueueAdmissionPolicy((refs) => {
        reads++;
        return new Promise((resolve) => {
            release = () => resolve(answer(refs, "allowed"));
        });
    }, {});
    const a = policy.prepare([song()]);
    const b = policy.prepare([song()]);
    await Promise.resolve();
    assert.equal(reads, 1);
    policy.replaceQueue();
    release({ status: "unavailable" });
    assert.equal(await a, "superseded");
    assert.equal(await b, "superseded");
    assert.equal(policy.readyFor(song()), false);
});

test("transient unavailable is never persisted as a ban and does not spin speculative retries", async () => {
    let reads = 0;
    let state: "allowed" | "unavailable" = "unavailable";
    const policy = new RecommendationQueueAdmissionPolicy(async (refs) => {
        reads++;
        return answer(refs, state);
    }, {});
    assert.equal(await policy.prepare([song()]), "unavailable");
    assert.equal(policy.allows(song()), true);
    assert.equal(policy.readyFor(song()), false);
    assert.equal(await policy.prepare([song()]), "unavailable");
    assert.equal(reads, 1);
    state = "allowed";
    assert.equal(
        await policy.prepare([song()], { refreshUnavailable: true }),
        "ready",
    );
    assert.equal(reads, 2);
    assert.equal(policy.readyFor(song()), true);
});

test("transport unavailability is retained for speculation until an explicit retry or owner change", async () => {
    let reads = 0;
    let recovered = false;
    const policy = new RecommendationQueueAdmissionPolicy(async (refs) => {
        reads++;
        return recovered ? answer(refs, "allowed") : { status: "unavailable" };
    }, {});
    assert.equal(await policy.prepare([song()]), "unavailable");
    assert.equal(await policy.prepare([song()]), "unavailable");
    assert.equal(
        reads,
        1,
        "progress ticks must not repeat a failed speculative request",
    );
    assert.equal(policy.allows(song()), true);
    assert.equal(policy.readyFor(song()), false);
    recovered = true;
    assert.equal(
        await policy.prepare([song()], { refreshUnavailable: true }),
        "ready",
    );
    assert.equal(reads, 2);
    assert.equal(policy.readyFor(song()), true);
    policy.setOwner({});
    assert.equal(await policy.prepare([song()]), "ready");
    assert.equal(
        reads,
        3,
        "an old owner's holdoff must not affect a new owner",
    );
});

test("genuine legacy404 retains exact compatibility, malformed policy cannot do so", async () => {
    const legacy = new RecommendationQueueAdmissionPolicy(
        async () => ({ status: "legacy_exact" }),
        {},
    );
    assert.equal(await legacy.prepare([song()]), "ready");
    assert.equal(legacy.readyFor(song()), true);
    const unavailable = new RecommendationQueueAdmissionPolicy(
        async () => ({ status: "unavailable" }),
        {},
    );
    assert.equal(await unavailable.prepare([song()]), "unavailable");
    assert.equal(unavailable.readyFor(song()), false);
});

test("more than100 references are checked in ordered chunks without discarding later allowed candidates", async () => {
    const counts: number[] = [];
    const policy = new RecommendationQueueAdmissionPolicy(async (refs) => {
        counts.push(refs.length);
        return answer(refs, counts.length === 3 ? "allowed" : "denied");
    }, {});
    const items = Array.from({ length: 202 }, (_, i) =>
        song(String(i).padStart(11, "0")),
    );
    assert.equal(await policy.prepare(items, { untilAllowed: true }), "ready");
    assert.deepEqual(counts, [100, 100, 2]);
    assert.equal(policy.readyFor(items[201]), true);
    assert.equal(policy.allows(items[0]), false);
});

test("all chunks share one17second deadline and a late second batch cannot install permission", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const releases: (() => void)[] = [];
    const signals: AbortSignal[] = [];
    const policy = new RecommendationQueueAdmissionPolicy((refs, signal) => {
        signals.push(signal);
        return new Promise((resolve) => {
            releases.push(() =>
                resolve(
                    answer(refs, signals.length === 1 ? "denied" : "allowed"),
                ),
            );
        });
    }, {});
    const items = Array.from({ length: 101 }, (_, i) =>
        song(String(i).padStart(11, "0")),
    );
    const pending = policy.prepare(items, { untilAllowed: true });
    await Promise.resolve();
    context.mock.timers.tick(10_000);
    releases[0]();
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.equal(signals.length, 2);
    context.mock.timers.tick(7_000);
    assert.equal(await pending, "unavailable");
    assert.equal(signals[1].aborted, true);
    releases[1]();
    await Promise.resolve();
    assert.equal(policy.readyFor(items[100]), false);
});
