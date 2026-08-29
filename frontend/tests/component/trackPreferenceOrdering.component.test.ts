import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type PreferenceSignal = "thumbs_up" | "thumbs_down" | "clear";

interface PreferenceResponse {
    trackId: string;
    signal: PreferenceSignal;
    state: "liked" | "disliked" | "neutral";
    score: number;
    likedAt: string | null;
    dislikedAt: string | null;
    updatedAt: string;
}

interface DeferredPreference {
    signal: PreferenceSignal;
    promise: Promise<PreferenceResponse>;
    resolve: (value: PreferenceResponse) => void;
    reject: (reason: Error) => void;
}

const TRACK_ID = "yt:preference-ordering";
const pendingPreferences: DeferredPreference[] = [];

function preferenceResponse(signal: PreferenceSignal): PreferenceResponse {
    const liked = signal === "thumbs_up";
    const disliked = signal === "thumbs_down";
    return {
        trackId: TRACK_ID,
        signal,
        state: liked ? "liked" : disliked ? "disliked" : "neutral",
        score: liked ? 1 : disliked ? -1 : 0,
        likedAt: liked ? "2026-08-28T12:00:00.000Z" : null,
        dislikedAt: disliked ? "2026-08-28T12:00:00.000Z" : null,
        updatedAt: "2026-08-28T12:00:00.000Z",
    };
}

function deferredPreference(signal: PreferenceSignal): DeferredPreference {
    let resolve!: (value: PreferenceResponse) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<PreferenceResponse>(
        (resolvePromise, rejectPromise) => {
            resolve = resolvePromise;
            reject = rejectPromise;
        },
    );
    return { signal, promise, resolve, reject };
}

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getTrackPreference: async () => preferenceResponse("clear"),
            setTrackPreference: async (
                _trackId: string,
                signal: PreferenceSignal,
            ) => {
                const pending = deferredPreference(signal);
                pendingPreferences.push(pending);
                return pending.promise;
            },
        },
    },
});

after(() => {
    GlobalRegistrator.unregister();
});

beforeEach(() => {
    pendingPreferences.length = 0;
});

async function flushReact() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
        await React.act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    }
}

test("an older failed mutation cannot overwrite a newer preference from another hook instance", async (testContext) => {
    const [{ useTrackPreference }, { createRoot }] = await Promise.all([
        import("../../hooks/useTrackPreference"),
        import("react-dom/client"),
    ]);
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
        },
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    function PreferenceTrigger({
        signal,
        testId,
    }: {
        signal: PreferenceSignal;
        testId: string;
    }) {
        const preference = useTrackPreference(TRACK_ID);
        return React.createElement(
            "button",
            {
                "data-testid": testId,
                onClick: () => {
                    void preference.setSignal(signal).catch(() => undefined);
                },
            },
            signal,
        );
    }

    await React.act(async () => {
        root.render(
            React.createElement(
                QueryClientProvider,
                { client: queryClient },
                React.createElement(
                    React.Fragment,
                    null,
                    React.createElement(PreferenceTrigger, {
                        signal: "thumbs_up",
                        testId: "older-like",
                    }),
                    React.createElement(PreferenceTrigger, {
                        signal: "thumbs_down",
                        testId: "newer-dislike",
                    }),
                ),
            ),
        );
    });
    testContext.after(async () => {
        await React.act(async () => root.unmount());
        container.remove();
        queryClient.clear();
    });
    await flushReact();

    const olderButton = container.querySelector<HTMLButtonElement>(
        '[data-testid="older-like"]',
    );
    const newerButton = container.querySelector<HTMLButtonElement>(
        '[data-testid="newer-dislike"]',
    );
    assert.ok(olderButton);
    assert.ok(newerButton);

    await React.act(async () => olderButton.click());
    await flushReact();
    await React.act(async () => newerButton.click());
    await flushReact();
    assert.deepEqual(
        pendingPreferences.map(({ signal }) => signal),
        ["thumbs_up", "thumbs_down"],
    );

    await React.act(async () => {
        pendingPreferences[1]?.resolve(preferenceResponse("thumbs_down"));
    });
    await flushReact();
    assert.equal(
        queryClient.getQueryData<PreferenceResponse>([
            "track-preference",
            TRACK_ID,
        ])?.signal,
        "thumbs_down",
    );

    await React.act(async () => {
        pendingPreferences[0]?.reject(new Error("older provider failed"));
    });
    await flushReact();
    assert.equal(
        queryClient.getQueryData<PreferenceResponse>([
            "track-preference",
            TRACK_ID,
        ])?.signal,
        "thumbs_down",
    );
});

test("dislike toggle clears an active dislike and otherwise writes thumbs_down through the ordered mutation", async (testContext) => {
    const [{ useTrackPreference }, { createRoot }] = await Promise.all([
        import("../../hooks/useTrackPreference"),
        import("react-dom/client"),
    ]);
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
        },
    });
    queryClient.setQueryData(
        ["track-preference", TRACK_ID],
        preferenceResponse("thumbs_down"),
    );
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    function DislikeTrigger() {
        const preference = useTrackPreference(TRACK_ID);
        return React.createElement(
            "button",
            {
                onClick: () => {
                    void preference.toggleDislike().catch(() => undefined);
                },
            },
            preference.signal,
        );
    }

    await React.act(async () => {
        root.render(
            React.createElement(
                QueryClientProvider,
                { client: queryClient },
                React.createElement(DislikeTrigger),
            ),
        );
    });
    testContext.after(async () => {
        await React.act(async () => root.unmount());
        container.remove();
        queryClient.clear();
    });
    await flushReact();

    const button = container.querySelector("button");
    assert.ok(button);

    await React.act(async () => button.click());
    await flushReact();
    assert.equal(pendingPreferences[0]?.signal, "clear");
    assert.equal(
        queryClient.getQueryData<PreferenceResponse>([
            "track-preference",
            TRACK_ID,
        ])?.signal,
        "clear",
    );

    await React.act(async () => {
        pendingPreferences[0]?.resolve(preferenceResponse("clear"));
    });
    await flushReact();

    await React.act(async () => button.click());
    await flushReact();
    assert.equal(pendingPreferences[1]?.signal, "thumbs_down");
    assert.equal(
        queryClient.getQueryData<PreferenceResponse>([
            "track-preference",
            TRACK_ID,
        ])?.signal,
        "thumbs_down",
    );

    await React.act(async () => {
        pendingPreferences[1]?.resolve(preferenceResponse("thumbs_down"));
    });
    await flushReact();
});

test("successful like and dislike mutations both invalidate the personalized home feed", async (testContext) => {
    const [{ useTrackPreference }, { createRoot }] = await Promise.all([
        import("../../hooks/useTrackPreference"),
        import("react-dom/client"),
    ]);
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
        },
    });
    const invalidatedKeys: unknown[] = [];
    queryClient.invalidateQueries = (async (filters: {
        queryKey?: unknown;
    }) => {
        invalidatedKeys.push(filters.queryKey);
    }) as typeof queryClient.invalidateQueries;
    queryClient.setQueryData(
        ["track-preference", TRACK_ID],
        preferenceResponse("clear"),
    );
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    function PreferenceTriggers() {
        const preference = useTrackPreference(TRACK_ID);
        return React.createElement(
            React.Fragment,
            null,
            React.createElement(
                "button",
                {
                    "data-testid": "like",
                    onClick: () => {
                        void preference.toggleLike().catch(() => undefined);
                    },
                },
                "like",
            ),
            React.createElement(
                "button",
                {
                    "data-testid": "dislike",
                    onClick: () => {
                        void preference.toggleDislike().catch(() => undefined);
                    },
                },
                "dislike",
            ),
        );
    }

    await React.act(async () => {
        root.render(
            React.createElement(
                QueryClientProvider,
                { client: queryClient },
                React.createElement(PreferenceTriggers),
            ),
        );
    });
    testContext.after(async () => {
        await React.act(async () => root.unmount());
        container.remove();
        queryClient.clear();
    });
    await flushReact();

    const likeButton = container.querySelector<HTMLButtonElement>(
        '[data-testid="like"]',
    );
    const dislikeButton = container.querySelector<HTMLButtonElement>(
        '[data-testid="dislike"]',
    );
    assert.ok(likeButton);
    assert.ok(dislikeButton);

    await React.act(async () => likeButton.click());
    await flushReact();
    assert.equal(pendingPreferences[0]?.signal, "thumbs_up");
    await React.act(async () => {
        pendingPreferences[0]?.resolve(preferenceResponse("thumbs_up"));
    });
    await flushReact();
    assert.ok(
        invalidatedKeys.some(
            (key) =>
                JSON.stringify(key) ===
                JSON.stringify(["home", "personalized"]),
        ),
        "thumbs_up success invalidates the personalized home prefix",
    );

    invalidatedKeys.length = 0;
    await React.act(async () => dislikeButton.click());
    await flushReact();
    assert.equal(pendingPreferences[1]?.signal, "thumbs_down");
    await React.act(async () => {
        pendingPreferences[1]?.resolve(preferenceResponse("thumbs_down"));
    });
    await flushReact();
    assert.ok(
        invalidatedKeys.some(
            (key) =>
                JSON.stringify(key) ===
                JSON.stringify(["home", "personalized"]),
        ),
        "thumbs_down success invalidates the personalized home prefix",
    );
});
