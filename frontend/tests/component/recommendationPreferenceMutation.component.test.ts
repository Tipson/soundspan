import assert from "node:assert/strict";
import { after, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
    api,
    type TrackPreferenceResponse,
    type TrackPreferenceSignal,
} from "../../lib/api";
import { useTrackPreference } from "../../hooks/useTrackPreference";
import { RecommendationQueueAdmission } from "../../lib/audio/recommendationQueueAdmission";
import { RecommendationQueueFeedback } from "../../lib/audio/recommendationQueueFeedback";
import { registerRecommendationFeedbackOwner } from "../../lib/audio/recommendationFeedbackBridge";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
after(() => GlobalRegistrator.unregister());

function preference(
    trackId: string,
    signal: TrackPreferenceSignal,
): TrackPreferenceResponse {
    return {
        trackId,
        signal,
        state:
            signal === "clear"
                ? "neutral"
                : signal === "thumbs_up"
                  ? "liked"
                  : "disliked",
        score: signal === "clear" ? 0 : signal === "thumbs_up" ? 1 : -1,
        likedAt: null,
        dislikedAt: null,
        updatedAt: null,
    };
}

async function mount() {
    const { createRoot } = await import("react-dom/client");
    const original = {
        get: api.getTrackPreference,
        set: api.setTrackPreference,
        generation: api.getSessionGeneration,
    };
    let generation = 1;
    api.getSessionGeneration = () => generation;
    api.getTrackPreference = async (id) => preference(id, "clear");
    const writes: {
        id: string;
        signal: TrackPreferenceSignal;
        resolve: (value: TrackPreferenceResponse) => void;
        reject: (error: Error) => void;
    }[] = [];
    api.setTrackPreference = (id, signal) =>
        new Promise((resolve, reject) => {
            writes.push({ id, signal, resolve, reject });
        });
    const reads: unknown[] = [];
    const admission = new RecommendationQueueAdmission(async (references) => {
        reads.push(references);
        return {
            status: "ready",
            response: {
                version: 1,
                appliesTo: "recommended_future",
                decisions: references.map(({ source, id }) => ({
                    source,
                    id,
                    state: "allowed",
                })),
            },
        };
    }, {});
    const guard = new RecommendationQueueFeedback();
    const owner = {
        begin: (trackId: string, signal: TrackPreferenceSignal) =>
            guard.begin({ trackId, signal, scope: "session:wave" }),
        reconcile: guard.reconcile.bind(guard),
        beginMutation: () => admission.beginPreferenceMutation(),
        settleMutation: admission.settlePreferenceMutation.bind(admission),
        reportFailure() {
            throw new Error("Unexpected queue bridge failure");
        },
    };
    const unregister = registerRecommendationFeedbackOwner(owner);
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false, gcTime: Infinity },
            mutations: { retry: false, gcTime: Infinity },
        },
    });
    let first!: ReturnType<typeof useTrackPreference>;
    let second!: ReturnType<typeof useTrackPreference>;
    function Harness() {
        first = useTrackPreference("yt:abcdefghijk");
        second = useTrackPreference("yt:lmnopqrstuv");
        return null;
    }
    const node = document.createElement("div");
    document.body.appendChild(node);
    const root = createRoot(node);
    await React.act(async () => {
        root.render(
            React.createElement(
                QueryClientProvider,
                { client: queryClient },
                React.createElement(Harness),
            ),
        );
    });
    const active: Promise<unknown>[] = [];
    return {
        admission,
        reads,
        writes,
        queryClient,
        setGeneration(value: number) {
            generation = value;
        },
        async write(signal: TrackPreferenceSignal, index = 0) {
            let action!: Promise<TrackPreferenceResponse | null | undefined>;
            await React.act(async () => {
                action = (index ? second : first).setSignal(signal);
                active.push(action.catch(() => undefined));
            });
            return { action };
        },
        async cleanup() {
            for (const write of writes)
                write.resolve(preference(write.id, write.signal));
            await React.act(async () => {
                await Promise.allSettled(active);
                root.unmount();
            });
            unregister();
            admission.setOwner(null);
            queryClient.clear();
            node.remove();
            api.getTrackPreference = original.get;
            api.setTrackPreference = original.set;
            api.getSessionGeneration = original.generation;
        },
    };
}
const refs = [{ source: "youtube" as const, id: "0123456789_" }];

test("a clear write without an exact-mask change blocks server readmission until its actual finally", async () => {
    const h = await mount();
    try {
        const { action } = await h.write("clear");
        assert.equal(h.writes.length, 1);
        const check = h.admission.readmit(refs);
        await Promise.resolve();
        assert.equal(
            h.reads.length,
            0,
            "server policy must wait for the pending clear",
        );
        await React.act(async () => {
            h.writes[0].resolve(preference(h.writes[0].id, "clear"));
            await action;
        });
        assert.equal((await check).status, "ready");
        assert.equal(h.reads.length, 1);
    } finally {
        await h.cleanup();
    }
});

test("two different track mutations keep readmission pending until both settle", async () => {
    const h = await mount();
    try {
        const first = await h.write("thumbs_down");
        const second = await h.write("thumbs_down", 1);
        assert.equal(h.writes.length, 2);
        const check = h.admission.readmit(refs);
        await Promise.resolve();
        assert.equal(h.reads.length, 0);
        await React.act(async () => {
            h.writes[0].resolve(preference(h.writes[0].id, "thumbs_down"));
            await first.action;
        });
        assert.equal(
            h.reads.length,
            0,
            "another recording is still being saved",
        );
        await React.act(async () => {
            h.writes[1].resolve(preference(h.writes[1].id, "thumbs_down"));
            await second.action;
        });
        assert.equal((await check).status, "ready");
        assert.equal(h.reads.length, 1);
    } finally {
        await h.cleanup();
    }
});

test("a failed preference request always releases its pending readmission barrier", async () => {
    const h = await mount();
    try {
        const { action } = await h.write("thumbs_up");
        const rejected = assert.rejects(action, /ambiguous connection/);
        const check = h.admission.readmit(refs);
        await Promise.resolve();
        assert.equal(h.reads.length, 0);
        await React.act(async () => {
            h.writes[0].reject(new Error("ambiguous connection"));
            await rejected;
        });
        assert.equal((await check).status, "ready");
        assert.equal(h.reads.length, 1);
    } finally {
        await h.cleanup();
    }
});

test("an unsupported successful ACK still settles the write without fabricating queue permission", async () => {
    const h = await mount();
    try {
        const { action } = await h.write("thumbs_down");
        const check = h.admission.readmit(refs);
        await Promise.resolve();
        assert.equal(h.reads.length, 0);
        await React.act(async () => {
            h.writes[0].resolve({
                ...preference(h.writes[0].id, "thumbs_down"),
                queuePolicy: { version: 2, scope: "artist" },
            } as unknown as TrackPreferenceResponse);
            await action;
        });
        assert.equal((await check).status, "ready");
        assert.equal(h.reads.length, 1);
    } finally {
        await h.cleanup();
    }
});
