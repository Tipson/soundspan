import assert from "node:assert/strict";
import { after, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import React from "react";
import { api } from "../../lib/api";
import type { Track } from "../../lib/audio-state-context";
import type { QueueItem } from "../../lib/queue-item";
import {
    useRecommendationQueueFeedback,
    type RecommendationQueueFeedbackAccess,
} from "../../lib/audio/useRecommendationQueueFeedback";
import {
    captureRecommendationFeedback,
    captureRecommendationPreferenceMutation,
} from "../../lib/audio/recommendationFeedbackBridge";
import type {
    FiniteQueueAdmissionReference,
    RecommendationQueueAdmissionResult,
} from "../../lib/audio/recommendationQueueAdmission";
import { recordQueueContextChange } from "../../lib/audio-engine/playbackAdvanceOrigin";
GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
after(() => GlobalRegistrator.unregister());
function song(id: string, recommended = true): Track {
    return {
        id: "yt:" + id,
        youtubeVideoId: id,
        streamSource: "youtube",
        title: id,
        duration: 180,
        artist: { name: "Display name" },
        album: { title: "Album" },
        ...(recommended
            ? {
                  recommendationSessionId: "wave-owner",
                  recommendationGenerationId: "generation",
              }
            : {}),
    };
}
const alias = "abcdefghijk",
    current = "lmnopqrstuv",
    exact = "0123456789_";
async function mount() {
    localStorage.clear();
    const original = api.readmitRecommendationQueue;
    const calls: {
        references: readonly FiniteQueueAdmissionReference[];
        release: (value: RecommendationQueueAdmissionResult) => void;
    }[] = [];
    api.readmitRecommendationQueue = (references) =>
        new Promise((release) => {
            calls.push({ references, release });
        });
    const { createRoot } = await import("react-dom/client");
    const node = document.createElement("div");
    document.body.appendChild(node);
    const root = createRoot(node);
    const environment = { current: true };
    const isCurrent = () => environment.current;
    const isCollaborative = () => false;
    let live!: {
        queue: QueueItem[];
        index: number;
        feedback: RecommendationQueueFeedbackAccess;
        replace: () => void;
    };
    function Harness() {
        const [queue, setQueue] = React.useState<QueueItem[]>([
            song(alias),
            song(current),
            song(alias),
            song(exact),
            song(alias, false),
        ]);
        const [index, setIndex] = React.useState(1);
        const publish = React.useCallback(
            (next: { queue: QueueItem[]; currentIndex: number }) => {
                setQueue(next.queue);
                setIndex(next.currentIndex);
            },
            [],
        );
        const feedback = useRecommendationQueueFeedback({
            queue,
            currentIndex: index,
            isShuffle: false,
            shuffleIndices: [],
            currentTrack: queue[index] as Track,
            publish,
            isCurrent,
            isCollaborative,
        });
        React.useLayoutEffect(() => {
            live = {
                queue,
                index,
                feedback,
                replace() {
                    recordQueueContextChange();
                    feedback.reset();
                    setQueue([song(current, false), song(alias, false)]);
                    setIndex(0);
                },
            };
        });
        return React.createElement(
            "output",
            { "data-current": queue[index]?.id },
            queue.map((item) => item.id).join(","),
        );
    }
    await React.act(async () => {
        root.render(React.createElement(Harness));
    });
    return {
        calls,
        node,
        environment,
        current: () => live,
        async release(state: "allowed" | "denied" | "unavailable") {
            await React.act(async () => {
                for (const call of calls)
                    call.release({
                        status: "ready",
                        response: {
                            version: 1,
                            appliesTo: "recommended_future",
                            decisions: call.references.map(
                                ({ source, id }) => ({
                                    source,
                                    id,
                                    state: id === alias ? state : "allowed",
                                }),
                            ),
                        },
                    });
                for (let i = 0; i < 12; i++) await Promise.resolve();
            });
        },
        async close() {
            await React.act(async () => {
                root.unmount();
            });
            api.readmitRecommendationQueue = original;
            node.remove();
        },
    };
}

test("settled feedback readmits verified aliases without moving current, history or manual rows", async () => {
    const app = await mount();
    try {
        let mutation: ReturnType<
            typeof captureRecommendationPreferenceMutation
        >;
        await React.act(async () => {
            mutation = captureRecommendationPreferenceMutation();
            captureRecommendationFeedback("yt:" + exact, "thumbs_down");
        });
        assert.equal(app.calls.length, 0);
        await React.act(async () => {
            mutation?.finish();
            for (let i = 0; i < 8; i++) await Promise.resolve();
        });
        assert.equal(
            app.calls.length,
            1,
            "the mounted player must recheck the remaining queue after the actual write",
        );
        await app.release("denied");
        assert.deepEqual(
            app.current().queue.map((item) => item.id),
            ["yt:" + alias, "yt:" + current, "yt:" + alias],
        );
        assert.equal(app.current().index, 1);
        assert.equal(
            app.node.querySelector("output")?.getAttribute("data-current"),
            "yt:" + current,
        );
        assert.equal(app.current().feedback.allows(song(alias, false)), true);
        assert.equal(app.current().feedback.allows(song(alias)), false);
    } finally {
        await app.close();
    }
});

test("temporary unavailable preserves rows and current and cannot trigger a speculative request loop", async () => {
    const app = await mount();
    try {
        await React.act(async () => {
            const mutation = captureRecommendationPreferenceMutation();
            captureRecommendationFeedback("yt:" + exact, "thumbs_down");
            mutation?.finish();
            for (let i = 0; i < 8; i++) await Promise.resolve();
        });
        assert.equal(app.calls.length, 1);
        await app.release("unavailable");
        assert.equal(app.calls.length, 1);
        assert.equal(app.current().index, 1);
        assert.equal(app.current().queue[2].id, "yt:" + alias);
        assert.equal(app.current().feedback.allows(song(alias)), true);
        assert.equal(app.current().feedback.readyFor?.(song(alias)), false);
    } finally {
        await app.close();
    }
});

test("a late server policy cannot prune an explicitly replaced manual queue", async () => {
    const app = await mount();
    try {
        await React.act(async () => {
            const mutation = captureRecommendationPreferenceMutation();
            captureRecommendationFeedback("yt:" + exact, "thumbs_down");
            mutation?.finish();
            for (let i = 0; i < 8; i++) await Promise.resolve();
        });
        assert.equal(app.calls.length, 1);
        await React.act(async () => {
            app.current().replace();
        });
        await app.release("denied");
        assert.deepEqual(
            app.current().queue.map((item) => item.id),
            ["yt:" + current, "yt:" + alias],
        );
        assert.equal(app.current().index, 0);
        assert.equal(app.current().feedback.allows(song(alias, false)), true);
    } finally {
        await app.close();
    }
});
