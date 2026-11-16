import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import React from "react";
import type { Track } from "../../lib/audio-state-context";
import type { QueueItem } from "../../lib/queue-item";
import type { RecommendationFeedbackQueue } from "../../lib/audio/recommendationQueueFeedback";
import {
    captureRecommendationFeedback,
    reconcileRecommendationFeedback,
} from "../../lib/audio/recommendationFeedbackBridge";
import {
    consumePlaybackAdvanceOrigin,
    recordQueueContextChange,
    writePlaybackReplacementIntent,
} from "../../lib/audio-engine/playbackAdvanceOrigin";
import {
    activateUserPlaybackStorage,
    isUserPlaybackStorageGenerationCurrent,
} from "../../lib/userPlaybackStorage";
import { useRecommendationQueueFeedback } from "../../lib/audio/useRecommendationQueueFeedback";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
after(() => GlobalRegistrator.unregister());
beforeEach(() => {
    localStorage.clear();
    consumePlaybackAdvanceOrigin();
});

function track(id: string, recommended = true): Track {
    return {
        id,
        title: id,
        duration: 180,
        artist: { name: "Same artist" },
        album: { title: "Album" },
        ...(recommended ? { recommendationSessionId: "component-wave" } : {}),
    };
}

async function mount(options: Partial<RecommendationFeedbackQueue> = {}) {
    const { createRoot } = await import("react-dom/client");
    const node = document.createElement("div");
    document.body.appendChild(node);
    const root = createRoot(node);
    const generation = activateUserPlaybackStorage("owner-a");
    const environment = { collaborative: false };
    const ownerCurrent = () =>
        isUserPlaybackStorageGenerationCurrent(generation);
    const collaborative = () => environment.collaborative;
    let live: {
        queue: QueueItem[];
        index: number;
        append: (item: QueueItem) => void;
        allows: (item: QueueItem) => boolean;
        reset: () => void;
        select: (index: number) => void;
        replace: (queue: QueueItem[]) => void;
    } | null = null;
    function Harness() {
        const [queue, setQueue] = React.useState<QueueItem[]>(
            options.queue ?? [
                track("a"),
                track("b"),
                track("a"),
                track("c"),
                track("a", false),
            ],
        );
        const [index, setIndex] = React.useState(options.currentIndex ?? 1);
        const [shuffle, setShuffle] = React.useState<number[]>(
            options.shuffleIndices ?? [],
        );
        const publish = React.useCallback(
            (next: RecommendationFeedbackQueue) => {
                setQueue(next.queue);
                setIndex(next.currentIndex);
                setShuffle(next.shuffleIndices);
            },
            [],
        );
        const feedback = useRecommendationQueueFeedback({
            queue,
            currentIndex: index,
            isShuffle: options.isShuffle ?? false,
            shuffleIndices: shuffle,
            currentTrack: queue[index] as Track,
            publish,
            isCurrent: ownerCurrent,
            isCollaborative: collaborative,
        });
        React.useLayoutEffect(() => {
            live = {
                queue,
                index,
                append: (item) => setQueue((old) => [...old, item]),
                allows: feedback.allows,
                reset: feedback.reset,
                select: setIndex,
                replace: setQueue,
            };
        });
        return React.createElement(
            "output",
            { "data-current": queue[index]?.id },
            queue.map((item) => item.id).join(","),
        );
    }
    await React.act(async () => root.render(React.createElement(Harness)));
    return {
        node,
        environment,
        current: () => {
            assert.ok(live);
            return live;
        },
        async close() {
            await React.act(async () => root.unmount());
            node.remove();
        },
    };
}

test("a manual current occurrence preserves Wave feedback authority for its recommended duplicate", async () => {
    const manual = track("d", false);
    const app = await mount({
        queue: [manual, track("d"), track("b")],
        currentIndex: 0,
    });
    try {
        await React.act(async () => {
            assert.ok(captureRecommendationFeedback("d", "thumbs_down"));
        });
        assert.deepEqual(
            app.current().queue.map((item) => item.id),
            ["d", "b"],
        );
        assert.equal(app.current().queue[app.current().index], manual);
        assert.equal(manual.recommendationSessionId, undefined);
        await React.act(async () => app.current().append(track("d")));
        assert.deepEqual(
            app.current().queue.map((item) => item.id),
            ["d", "b"],
        );
    } finally {
        await app.close();
    }
});

test("clearing a negative still works after its last recommended occurrence was pruned", async () => {
    const app = await mount({
        queue: [track("d", false), track("d")],
        currentIndex: 0,
    });
    try {
        await React.act(async () => {
            captureRecommendationFeedback("d", "thumbs_down");
        });
        assert.equal(app.node.textContent, "d");
        await React.act(async () => {
            const cleared = captureRecommendationFeedback("d", "clear");
            assert.ok(cleared);
            assert.equal(
                reconcileRecommendationFeedback(cleared, "clear"),
                true,
            );
        });
        assert.equal(app.node.textContent, "d");
        await React.act(async () => app.current().append(track("d")));
        assert.equal(app.node.textContent, "d,d");
    } finally {
        await app.close();
    }
});

test("the same queue retains recommendation scope during a manual insertion but replacement retires its ACK", async () => {
    const app = await mount({
        queue: [track("a"), track("d", false)],
        currentIndex: 0,
    });
    try {
        await React.act(async () => app.current().select(1));
        let receipt: ReturnType<typeof captureRecommendationFeedback> = null;
        await React.act(async () => {
            receipt = captureRecommendationFeedback("d", "thumbs_down");
            assert.ok(receipt);
        });
        assert.equal(app.current().allows(track("d")), false);
        recordQueueContextChange();
        await React.act(async () =>
            app.current().replace([track("x", false), track("d", false)]),
        );
        assert.equal(reconcileRecommendationFeedback(receipt, "clear"), false);
        assert.equal(captureRecommendationFeedback("d", "clear"), null);
        assert.equal(app.node.textContent, "x,d");
    } finally {
        await app.close();
    }
});

test("manual-current scope inference follows shuffled future entries and never guesses history", async () => {
    const historical = {
        ...track("history"),
        recommendationSessionId: "other",
    };
    const app = await mount({
        queue: [track("d"), track("d", false), historical],
        currentIndex: 1,
        isShuffle: true,
        shuffleIndices: [2, 1, 0],
    });
    try {
        await React.act(async () => {
            assert.ok(captureRecommendationFeedback("d", "thumbs_down"));
        });
        assert.equal(app.node.textContent, "d,history");
        assert.equal(app.current().index, 0);
        assert.equal(app.current().queue[1], historical);
    } finally {
        await app.close();
    }
    localStorage.clear();
    const unknown = await mount({
        queue: [track("d"), track("d", false), historical],
        currentIndex: 1,
        isShuffle: true,
        shuffleIndices: [0, 2],
    });
    try {
        assert.equal(captureRecommendationFeedback("d", "thumbs_down"), null);
        assert.equal(unknown.node.textContent, "d,d,history");
    } finally {
        await unknown.close();
    }
});

test("an ambiguous future cannot assign recommendation lineage to a manual current track", async () => {
    const app = await mount({
        queue: [
            track("d", false),
            track("d"),
            { ...track("b"), recommendationSessionId: "another-session" },
        ],
        currentIndex: 0,
    });
    try {
        assert.equal(captureRecommendationFeedback("d", "thumbs_down"), null);
        assert.equal(app.node.textContent, "d,d,b");
    } finally {
        await app.close();
    }
});

test("same-owner restoration can clear a persisted mask after the last recommended row was removed", async () => {
    const first = await mount({
        queue: [track("d", false), track("d")],
        currentIndex: 0,
    });
    await React.act(async () => {
        captureRecommendationFeedback("d", "thumbs_down");
    });
    assert.equal(first.node.textContent, "d");
    await first.close();
    const restored = await mount({
        queue: [track("d", false)],
        currentIndex: 0,
    });
    try {
        await React.act(async () => {
            assert.ok(captureRecommendationFeedback("d", "clear"));
        });
        await React.act(async () => restored.current().append(track("d")));
        assert.equal(restored.node.textContent, "d,d");
    } finally {
        await restored.close();
    }
});

test("explicit reset retires retained manual-current scope without relying on a generation change", async () => {
    const app = await mount({
        queue: [track("a"), track("d", false)],
        currentIndex: 0,
    });
    try {
        await React.act(async () => app.current().select(1));
        await React.act(async () => {
            assert.ok(captureRecommendationFeedback("d", "thumbs_down"));
        });
        await React.act(async () => app.current().reset());
        assert.equal(captureRecommendationFeedback("d", "clear"), null);
        assert.equal(app.current().allows(track("d")), true);
    } finally {
        await app.close();
    }
});

test("the mounted owner prunes future negatives and late refills without moving current", async () => {
    const app = await mount();
    try {
        await React.act(async () => {
            captureRecommendationFeedback("a", "thumbs_down");
        });
        assert.equal(app.node.textContent, "a,b,c,a");
        assert.equal(
            app.node.querySelector("output")?.getAttribute("data-current"),
            "b",
        );
        await React.act(async () => app.current().append(track("a")));
        assert.equal(app.node.textContent, "a,b,c,a");
        await React.act(async () => {
            captureRecommendationFeedback("a", "clear");
        });
        await React.act(async () => app.current().append(track("a")));
        assert.equal(app.node.textContent, "a,b,c,a,a");
    } finally {
        await app.close();
    }
});

test("a pending manual selection and collaborative queues keep their original authority", async () => {
    const app = await mount();
    try {
        writePlaybackReplacementIntent("b");
        assert.equal(captureRecommendationFeedback("a", "thumbs_down"), null);
        assert.equal(app.node.textContent, "a,b,a,c,a");
        consumePlaybackAdvanceOrigin();
        app.environment.collaborative = true;
        assert.equal(captureRecommendationFeedback("a", "thumbs_down"), null);
        assert.equal(app.current().allows(track("a")), true);
    } finally {
        await app.close();
    }
});

test("a manual reset retires delayed feedback and owner switch rejects further writes", async () => {
    const app = await mount();
    try {
        let receipt: ReturnType<typeof captureRecommendationFeedback> = null;
        await React.act(async () => {
            receipt = captureRecommendationFeedback("a", "thumbs_down");
        });
        await React.act(async () => app.current().reset());
        assert.equal(
            reconcileRecommendationFeedback(receipt, "thumbs_down"),
            false,
        );
        assert.equal(app.current().allows(track("a")), true);
        activateUserPlaybackStorage("owner-b");
        assert.equal(captureRecommendationFeedback("a", "thumbs_down"), null);
    } finally {
        await app.close();
    }
});

test("same-owner remount restores masks and malformed policy preserves manual rows", async () => {
    const first = await mount();
    let receipt: ReturnType<typeof captureRecommendationFeedback> = null;
    await React.act(async () => {
        receipt = captureRecommendationFeedback("a", "thumbs_down");
    });
    await first.close();
    const restored = await mount();
    try {
        assert.equal(restored.node.textContent, "a,b,c,a");
        assert.equal(restored.current().allows(track("a")), false);
        assert.equal(reconcileRecommendationFeedback(receipt, "clear"), false);
    } finally {
        await restored.close();
    }
    localStorage.setItem(
        "soundspan_recommendation_feedback_v1",
        '{"version":999}',
    );
    const malformed = await mount();
    try {
        assert.equal(malformed.node.textContent, "a,b,a");
        assert.equal(malformed.current().allows(track("a", false)), true);
    } finally {
        await malformed.close();
    }
});
