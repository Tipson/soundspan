import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React, { act } from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ url: "https://soundspan.test/search?q=RAC" });
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const played: unknown[][] = [];
let calls = 0;
let enabled = true;
mock.module("@/lib/features-context", {
    namedExports: { useFeatures: () => ({ audius: enabled }) },
});
const entry = {
    source: "audius",
    id: "7AlA9",
    title: "Sinners",
    artist: "RAC",
    artistHandle: "RAC",
    artistVerified: true,
    durationSeconds: 237,
    attributionUrl: "https://audius.co/RAC/sinners",
    fullStreamAvailable: true,
    automaticFallbackEligible: false,
    downloadAllowed: false,
};
mock.module("@/lib/api", {
    namedExports: {
        api: {
            searchAudius: async () => {
                calls++;
                return [entry];
            },
        },
    },
});
mock.module("@/lib/audio-controls-context", {
    namedExports: {
        useAudioControls: () => ({
            playTracks: (tracks: unknown[]) => played.push(tracks),
        }),
    },
});
mock.module("@/lib/listen-together-session", {
    namedExports: { isListenTogetherActiveOrPending: () => false },
});
after(() => GlobalRegistrator.unregister());
test("Audius is explicitly searched and selected result reaches the existing queue", async () => {
    const { createRoot } = await import("react-dom/client");
    const { AudiusSearchPanel } =
        await import("../../features/search/components/AudiusSearchPanel");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
        root.render(React.createElement(AudiusSearchPanel, { query: "RAC" })),
    );
    try {
        assert.equal(calls, 0);
        await act(async () =>
            (container.querySelector("button") as HTMLButtonElement).click(),
        );
        const play = container.querySelector(
            'button[aria-label="Слушать Sinners — RAC в Audius"]',
        ) as HTMLButtonElement;
        assert.ok(play);
        await act(async () => play.click());
        assert.equal(calls, 1);
        assert.equal((played[0][0] as { id: string }).id, "audius:7AlA9");
        assert.equal(
            container
                .querySelector('a[aria-label="Открыть Sinners в Audius"]')
                ?.getAttribute("href"),
            entry.attributionUrl,
        );
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

test("disabled Audius has no visible control and makes no catalog request", async () => {
    enabled = false;
    const { createRoot } = await import("react-dom/client");
    const { AudiusSearchPanel } =
        await import("../../features/search/components/AudiusSearchPanel");
    const container = document.createElement("div");
    const root = createRoot(container);
    const before = calls;
    try {
        await act(async () =>
            root.render(
                React.createElement(AudiusSearchPanel, { query: "RAC" }),
            ),
        );
        assert.equal(container.innerHTML, "");
        assert.equal(calls, before);
    } finally {
        await act(async () => root.unmount());
        enabled = true;
    }
});
